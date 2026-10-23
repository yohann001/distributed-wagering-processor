import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { defaultIdempotencyKey } from '../../../../../src/modules/wagering/application/payload-hash';
import {
  PendingReferenceOutcome,
  ReprocessPendingReferences,
  type ReprocessedPendingReference,
} from '../../../../../src/modules/wagering/application/reprocess-pending-references';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../../../src/modules/wagering/application/submit-wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { resetDatabase } from '../../../../support/database';
import { installStatusChangeFault } from '../../../../support/fault-injection';
import { newProviderId, openWalletWithBalance } from '../../../../support/fixtures';
import { present } from '../../../../support/orm-context';
import { waitFor } from '../../../../support/sqs';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

interface Scenario {
  walletId: string;
  playerId: string;
  providerId: string;
}

interface TransactionRow {
  status: string;
  failure_code: string | null;
  reference_transaction_id: string | null;
  balance_after: string | null;
  reference_attempts: number;
  scheduled_in_the_future: boolean;
}

interface LedgerRow {
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
}

type CommandOverrides = Partial<SubmitWagerTransactionCommand> & Pick<SubmitWagerTransactionCommand, 'kind'>;

const PROCESSED = 'WagerTransactionProcessed';
const REJECTED = 'WagerTransactionRejected';
const PENDING_REFERENCE = 'WagerTransactionPendingReference';
const BALANCE_CHANGED = 'WalletBalanceChanged';

// Com jitter de 20%: a 1ª reavaliação perdida espera 160-200 ms e a 2ª, 320-400 ms. Folga suficiente para o teste
// conferir "ainda não venceu" logo depois de um ciclo.
const WORKER_OPTIONS = { enabled: false, maxAttempts: 3, retryBaseDelayMs: 200, retryMaxDelayMs: 400 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('ReprocessPendingReferences (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let submitWager: SubmitWagerTransaction;
  let reprocess: ReprocessPendingReferences;

  beforeAll(async () => {
    app = await createTestApp({ pendingReferenceWorker: WORKER_OPTIONS });
    orm = app.get(MikroORM);
    submitWager = app.get(SubmitWagerTransaction);
    reprocess = app.get(ReprocessPendingReferences);
  });

  afterAll(async () => {
    await resetDatabase(orm);
    await app?.close();
  });

  // Linhas PENDING_REFERENCE de outras suítes entrariam no claim e embaralhariam as contagens.
  beforeEach(() => resetDatabase(orm));

  const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
  const money = (amount: string) => ({ amount, currency: 'BRL' });

  function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
    return orm.em.fork().execute<T[]>(sql, params);
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const result = await rows<{ n: number }>(sql, params);
    return present(result[0], 'count row').n;
  }

  const countLedger = (walletId: string) =>
    count('select count(*)::int as n from wallet_ledger_entries where wallet_id = ?', [walletId]);

  async function transactionRow(id: string): Promise<TransactionRow> {
    const result = await rows<TransactionRow>(
      `select status, failure_code, reference_transaction_id, balance_after::text as balance_after,
              reference_attempts, next_reference_attempt_at > now() as scheduled_in_the_future
         from wager_transactions where id = ?`,
      [id],
    );
    return present(result[0], 'transaction row');
  }

  const ledgerOf = (transactionId: string) =>
    rows<LedgerRow>(
      `select direction, amount::text as amount, balance_before::text as balance_before,
              balance_after::text as balance_after
         from wallet_ledger_entries where transaction_id = ?`,
      [transactionId],
    );

  async function eventTypesOf(transactionId: string): Promise<string[]> {
    const events = await rows<{ event_type: string }>(
      "select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by event_type",
      [transactionId],
    );
    return events.map((event) => event.event_type);
  }

  async function openScenario(amount: string): Promise<Scenario> {
    const { wallet } = await openWalletWithBalance(app, { amount });
    return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
  }

  function command(scenario: Scenario, overrides: CommandOverrides): SubmitWagerTransactionCommand {
    const externalTransactionId = overrides.externalTransactionId ?? `ext-${Bun.randomUUIDv7()}`;
    return {
      idempotencyKey: defaultIdempotencyKey(scenario.providerId, externalTransactionId),
      providerId: scenario.providerId,
      externalTransactionId,
      walletId: scenario.walletId,
      playerId: scenario.playerId,
      roundId: `round-${Bun.randomUUIDv7()}`,
      gameId: 'game-1',
      money: brl('10.00'),
      correlationId: Bun.randomUUIDv7(),
      ...overrides,
    };
  }

  const bet = (scenario: Scenario, amount: string) =>
    command(scenario, { kind: WagerTransactionKind.Bet, money: brl(amount) });

  /** Comando que aponta `target` como referência, na mesma rodada. */
  const pointingAt = (
    scenario: Scenario,
    target: SubmitWagerTransactionCommand,
    kind: WagerTransactionKind,
    amount: string,
  ) =>
    command(scenario, {
      kind,
      money: brl(amount),
      roundId: target.roundId,
      referenceExternalTransactionId: target.externalTransactionId,
    });

  /** Roda ciclos até um deles reavaliar algo: espera o backoff vencer sem dormir um tempo fixo. */
  const reprocessWhenDue = (useCase: ReprocessPendingReferences) =>
    waitFor<readonly ReprocessedPendingReference[]>(
      async () => {
        const { reprocessed } = await useCase.execute(Bun.randomUUIDv7());
        return reprocessed.length > 0 ? reprocessed : null;
      },
      5000,
      25,
    );

  async function onlyItem(useCase: ReprocessPendingReferences): Promise<ReprocessedPendingReference> {
    const { reprocessed } = await useCase.execute(Bun.randomUUIDv7());
    expect(reprocessed).toHaveLength(1);
    return present(reprocessed[0], 'reprocessed item');
  }

  /** REFUND de `amount` enviado antes da BET que ele reverte; depois a BET chega. */
  async function refundThenBet(scenario: Scenario, amount: string) {
    const betCommand = bet(scenario, amount);
    const refundCommand = pointingAt(scenario, betCommand, WagerTransactionKind.Refund, amount);
    const pending = await submitWager.execute(refundCommand);
    const processedBet = await submitWager.execute(betCommand);
    return { refundCommand, pending: pending.transaction, bet: processedBet.transaction };
  }

  describe('the reference arrives', () => {
    it('applies a REFUND submitted before its BET once the BET arrives', async () => {
      const scenario = await openScenario('100.00');

      const { pending, bet: processedBet } = await refundThenBet(scenario, '30.00');
      expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
      expect(processedBet.status).toBe(WagerTransactionStatus.Processed);
      expect(await eventTypesOf(pending.id)).toEqual([PENDING_REFERENCE]);

      const item = await onlyItem(reprocess);

      expect(item.outcome).toBe(PendingReferenceOutcome.Processed);
      expect(item.attempt).toBe(1);
      expect(item.transaction.id).toBe(pending.id);
      expect(await transactionRow(pending.id)).toMatchObject({
        status: 'PROCESSED',
        failure_code: null,
        reference_transaction_id: processedBet.id,
        balance_after: '100.00',
      });
      expect(await ledgerOf(pending.id)).toEqual([
        { direction: 'CREDIT', amount: '30.00', balance_before: '70.00', balance_after: '100.00' },
      ]);
      expect(await countLedger(scenario.walletId)).toBe(3);
      expect(await eventTypesOf(pending.id)).toEqual([PENDING_REFERENCE, PROCESSED, BALANCE_CHANGED]);
      expect((await reprocess.execute(Bun.randomUUIDv7())).reprocessed).toEqual([]);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('rejects a pending REFUND once the BET arrives with another amount, with the rule that failed', async () => {
      const scenario = await openScenario('100.00');
      const betCommand = bet(scenario, '30.00');
      const refundCommand = pointingAt(scenario, betCommand, WagerTransactionKind.Refund, '20.00');
      const pending = (await submitWager.execute(refundCommand)).transaction;
      await submitWager.execute(betCommand);

      const item = await onlyItem(reprocess);

      expect(item.outcome).toBe(PendingReferenceOutcome.Rejected);
      expect(await transactionRow(pending.id)).toMatchObject({
        status: 'REJECTED',
        failure_code: FailureCode.ReferenceAmountMismatch,
        balance_after: '70.00',
      });
      expect(await ledgerOf(pending.id)).toEqual([]);
      expect(await eventTypesOf(pending.id)).toEqual([PENDING_REFERENCE, REJECTED]);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('answers a replay of the original submission with the current row: pending before the worker, processed after (D1)', async () => {
      const scenario = await openScenario('100.00');
      const { refundCommand, pending } = await refundThenBet(scenario, '30.00');

      const replayBefore = await submitWager.execute(refundCommand);
      expect(replayBefore.idempotentReplay).toBe(true);
      expect(replayBefore.transaction.id).toBe(pending.id);
      expect(replayBefore.transaction.status).toBe(WagerTransactionStatus.PendingReference);

      await onlyItem(reprocess);

      const replayAfter = await submitWager.execute(refundCommand);
      expect(replayAfter.idempotentReplay).toBe(true);
      expect(replayAfter.transaction.id).toBe(pending.id);
      expect(replayAfter.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(replayAfter.transaction.balanceAfter?.toJSON()).toEqual(money('100.00'));
      await assertWalletConsistent(orm, scenario.walletId);
    });
  });

  describe('the reference never arrives', () => {
    it('rejects a ROLLBACK after the attempt limit, with backoff between the reevaluations', async () => {
      const scenario = await openScenario('100.00');
      const rollback = (
        await submitWager.execute(
          command(scenario, {
            kind: WagerTransactionKind.Rollback,
            money: brl('30.00'),
            referenceExternalTransactionId: `ext-never-${Bun.randomUUIDv7()}`,
          }),
        )
      ).transaction;
      expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

      const first = await onlyItem(reprocess);
      expect(first).toMatchObject({ outcome: PendingReferenceOutcome.Retried, attempt: 1 });
      expect(await transactionRow(rollback.id)).toMatchObject({
        status: 'PENDING_REFERENCE',
        reference_attempts: 1,
        scheduled_in_the_future: true,
      });
      // Ainda não venceu: o claim não a enxerga.
      expect((await reprocess.execute(Bun.randomUUIDv7())).reprocessed).toEqual([]);

      const [second] = await reprocessWhenDue(reprocess);
      expect(second).toMatchObject({ outcome: PendingReferenceOutcome.Retried, attempt: 2 });
      expect(await transactionRow(rollback.id)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 2 });

      const [third] = await reprocessWhenDue(reprocess);
      expect(third).toMatchObject({ outcome: PendingReferenceOutcome.Expired, attempt: 3 });
      expect(await transactionRow(rollback.id)).toMatchObject({
        status: 'REJECTED',
        failure_code: FailureCode.ReferenceNotFound,
        balance_after: '100.00',
      });
      expect(await eventTypesOf(rollback.id)).toEqual([PENDING_REFERENCE, REJECTED]);
      expect(await countLedger(scenario.walletId)).toBe(1);

      // Terminal: ciclos seguintes não tocam na linha.
      await Bun.sleep(450);
      expect((await reprocess.execute(Bun.randomUUIDv7())).reprocessed).toEqual([]);
      expect(await eventTypesOf(rollback.id)).toEqual([PENDING_REFERENCE, REJECTED]);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('rejects with REFERENCE_NOT_PROCESSED when the reference is still pending at the limit, and never waits for a locked row', async () => {
      const limitOne = await createTestApp({ pendingReferenceWorker: { ...WORKER_OPTIONS, maxAttempts: 1 } });
      const release = deferred();
      try {
        const scenario = await openScenario('100.00');
        const refundCommand = command(scenario, {
          kind: WagerTransactionKind.Refund,
          money: brl('30.00'),
          referenceExternalTransactionId: `ext-never-${Bun.randomUUIDv7()}`,
        });
        const refund = (await submitWager.execute(refundCommand)).transaction;
        const rollback = (
          await submitWager.execute(pointingAt(scenario, refundCommand, WagerTransactionKind.Rollback, '30.00'))
        ).transaction;
        expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
        expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

        const locked = deferred();
        const owner = orm.em.fork().transactional(async (em) => {
          await em.execute('select id from wager_transactions where id = ? for update', [refund.id]);
          locked.resolve();
          await release.promise;
        });
        await Promise.race([locked.promise, owner]);

        const startedAt = performance.now();
        const { reprocessed } = await limitOne.get(ReprocessPendingReferences).execute(Bun.randomUUIDv7());
        const elapsedMs = performance.now() - startedAt;

        // O lock_timeout da transação é 2 s: esperar a linha travada passaria disso.
        expect(elapsedMs).toBeLessThan(1500);
        expect(reprocessed.map((item) => [item.transaction.id, item.outcome])).toEqual([
          [rollback.id, PendingReferenceOutcome.Expired],
        ]);
        expect(await transactionRow(rollback.id)).toMatchObject({
          status: 'REJECTED',
          failure_code: FailureCode.ReferenceNotProcessed,
          balance_after: '100.00',
        });
        expect(await transactionRow(refund.id)).toMatchObject({ status: 'PENDING_REFERENCE' });

        release.resolve();
        await owner;
        const afterRelease = await onlyItem(limitOne.get(ReprocessPendingReferences));
        expect(afterRelease.transaction.id).toBe(refund.id);
        expect(afterRelease.outcome).toBe(PendingReferenceOutcome.Expired);
        expect(await transactionRow(refund.id)).toMatchObject({
          status: 'REJECTED',
          failure_code: FailureCode.ReferenceNotFound,
        });
        expect(await countLedger(scenario.walletId)).toBe(1);
        await assertWalletConsistent(orm, scenario.walletId);
      } finally {
        release.resolve();
        await limitOne.close();
      }
    });
  });

  describe('a pending transaction that keeps failing', () => {
    it('defers the failing row and still reprocesses the next ones in the same cycle', async () => {
      const scenario = await openScenario('100.00');
      // Criada primeiro: é a pendente vencida mais antiga, a primeira do claim.
      const failing = await refundThenBet(scenario, '30.00');
      const healthy = await refundThenBet(scenario, '20.00');
      const removeFault = await installStatusChangeFault(orm, failing.pending.id);

      try {
        const { reprocessed } = await reprocess.execute(Bun.randomUUIDv7());

        expect(reprocessed.map((item) => [item.transaction.id, item.outcome])).toEqual([
          [failing.pending.id, PendingReferenceOutcome.Failed],
          [healthy.pending.id, PendingReferenceOutcome.Processed],
        ]);
        expect(reprocessed[0]).toMatchObject({ attempt: 1, errorName: 'DatabaseError' });
        expect(await transactionRow(failing.pending.id)).toMatchObject({
          status: 'PENDING_REFERENCE',
          reference_attempts: 1,
          scheduled_in_the_future: true,
        });
        expect(await ledgerOf(failing.pending.id)).toEqual([]);
        expect(await eventTypesOf(failing.pending.id)).toEqual([PENDING_REFERENCE]);
        expect(await transactionRow(healthy.pending.id)).toMatchObject({ status: 'PROCESSED', balance_after: '70.00' });
        // Adiada com backoff: o ciclo seguinte ainda não a enxerga.
        expect((await reprocess.execute(Bun.randomUUIDv7())).reprocessed).toEqual([]);
      } finally {
        await removeFault();
      }

      const [retried] = await reprocessWhenDue(reprocess);
      expect(retried).toMatchObject({ outcome: PendingReferenceOutcome.Processed, attempt: 2 });
      expect(retried?.transaction.id).toBe(failing.pending.id);
      expect(await transactionRow(failing.pending.id)).toMatchObject({
        status: 'PROCESSED',
        reference_transaction_id: failing.bet.id,
        balance_after: '100.00',
      });
      expect(await ledgerOf(failing.pending.id)).toEqual([
        { direction: 'CREDIT', amount: '30.00', balance_before: '70.00', balance_after: '100.00' },
      ]);
      expect(await eventTypesOf(failing.pending.id)).toEqual([PENDING_REFERENCE, PROCESSED, BALANCE_CHANGED]);
      await assertWalletConsistent(orm, scenario.walletId);
    });
  });

  describe('several instances', () => {
    it('applies each pending transaction once when three instances reprocess concurrently', async () => {
      const second = await createTestApp({ pendingReferenceWorker: WORKER_OPTIONS });
      const third = await createTestApp({ pendingReferenceWorker: WORKER_OPTIONS });
      const instances = [reprocess, second.get(ReprocessPendingReferences), third.get(ReprocessPendingReferences)];

      try {
        for (let round = 0; round < 2; round += 1) {
          const scenarios = [await openScenario('100.00'), await openScenario('100.00')];
          const refundIds: string[] = [];
          const betCommands: SubmitWagerTransactionCommand[] = [];
          for (const scenario of scenarios) {
            for (let index = 0; index < 3; index += 1) {
              const betCommand = bet(scenario, '10.00');
              const refund = await submitWager.execute(
                pointingAt(scenario, betCommand, WagerTransactionKind.Refund, '10.00'),
              );
              refundIds.push(refund.transaction.id);
              betCommands.push(betCommand);
            }
          }
          for (const betCommand of betCommands) {
            await submitWager.execute(betCommand);
          }

          const results = await Promise.all(instances.map((instance) => instance.execute(Bun.randomUUIDv7())));

          const outcomes = results.flatMap((result) => result.reprocessed.map((item) => item.outcome));
          expect(outcomes).toHaveLength(6);
          expect(new Set(outcomes)).toEqual(new Set([PendingReferenceOutcome.Processed]));
          const handledIds = results.flatMap((result) => result.reprocessed.map((item) => item.transaction.id));
          expect([...handledIds].sort()).toEqual([...refundIds].sort());

          const placeholders = refundIds.map(() => '?').join(', ');
          expect(
            await count(
              `select count(*)::int as n from wager_transactions where status = 'PROCESSED' and id in (${placeholders})`,
              refundIds,
            ),
          ).toBe(6);
          expect(
            await count(
              `select count(*)::int as n from wallet_ledger_entries where transaction_id in (${placeholders})`,
              refundIds,
            ),
          ).toBe(6);
          for (const refundId of refundIds) {
            expect(await ledgerOf(refundId)).toHaveLength(1);
            expect(await eventTypesOf(refundId)).toEqual([PENDING_REFERENCE, PROCESSED, BALANCE_CHANGED]);
          }
          for (const scenario of scenarios) {
            const [wallet] = await rows<{ balance: string }>(
              'select balance::text as balance from wallets where id = ?',
              [scenario.walletId],
            );
            expect(present(wallet, 'wallet row').balance).toBe('100.00');
            await assertWalletConsistent(orm, scenario.walletId);
          }
        }
      } finally {
        await second.close();
        await third.close();
      }
    });
  });
});
