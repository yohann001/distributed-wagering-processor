import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { InboxMessageConflictError } from '../../../../../src/modules/messaging/domain/inbox-message';
import { defaultIdempotencyKey } from '../../../../../src/modules/wagering/application/payload-hash';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../../../src/modules/wagering/application/submit-wager-transaction';
import {
  IdempotencyConflictError,
  KindNotAllowedError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { WalletRepository } from '../../../../../src/modules/wallet/application/wallet-repository';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { newProviderId, openWalletWithBalance } from '../../../../support/fixtures';
import { inFreshContext, present } from '../../../../support/orm-context';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

interface LedgerRow {
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
}

interface Scenario {
  walletId: string;
  playerId: string;
  providerId: string;
}

type CommandOverrides = Partial<SubmitWagerTransactionCommand> & Pick<SubmitWagerTransactionCommand, 'kind'>;

const PROCESSED = 'WagerTransactionProcessed';
const REJECTED = 'WagerTransactionRejected';
const PENDING_REFERENCE = 'WagerTransactionPendingReference';
const BALANCE_CHANGED = 'WalletBalanceChanged';

describe('SubmitWagerTransaction (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let submitWager: SubmitWagerTransaction;
  let wallets: WalletRepository;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    submitWager = app.get(SubmitWagerTransaction);
    wallets = app.get(WalletRepository);
  });

  afterAll(async () => {
    await app?.close();
  });

  const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
  const money = (amount: string) => ({ amount, currency: 'BRL' });

  function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
    return orm.em.fork().execute<T[]>(sql, params);
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const result = await rows<{ n: number }>(sql, params);
    return present(result[0], 'count row').n;
  }

  const countTransactions = (providerId: string) =>
    count('select count(*)::int as n from wager_transactions where provider_id = ?', [providerId]);
  const countLedger = (walletId: string) =>
    count('select count(*)::int as n from wallet_ledger_entries where wallet_id = ?', [walletId]);
  const countOutbox = (walletId: string) =>
    count("select count(*)::int as n from outbox_messages where payload->'data'->>'walletId' = ?", [walletId]);
  const countInbox = (consumerName: string, messageIds: string[]) =>
    count(
      `select count(*)::int as n from inbox_messages
        where consumer_name = ? and processed_at is not null and message_id in (${messageIds.map(() => '?').join(', ')})`,
      [consumerName, ...messageIds],
    );

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

  async function walletState(walletId: string) {
    const wallet = present(await inFreshContext(orm, () => wallets.findById(walletId)), 'wallet');
    return { balance: wallet.balance.toJSON(), version: wallet.version };
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

  const bet = (scenario: Scenario, amount: string, overrides: Partial<SubmitWagerTransactionCommand> = {}) =>
    command(scenario, { kind: WagerTransactionKind.Bet, money: brl(amount), ...overrides });

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

  describe('BET', () => {
    it('debits the wallet, writes one DEBIT entry and enqueues Processed + BalanceChanged', async () => {
      const scenario = await openScenario('100.00');
      const correlationId = Bun.randomUUIDv7();

      const result = await submitWager.execute(bet(scenario, '25.00', { correlationId }));

      expect(result.idempotentReplay).toBe(false);
      expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(result.transaction.balanceAfter?.toJSON()).toEqual(money('75.00'));
      expect(await walletState(scenario.walletId)).toEqual({ balance: money('75.00'), version: 2 });
      expect(await ledgerOf(result.transaction.id)).toEqual([
        { direction: 'DEBIT', amount: '25.00', balance_before: '100.00', balance_after: '75.00' },
      ]);
      expect(await eventTypesOf(result.transaction.id)).toEqual([PROCESSED, BALANCE_CHANGED]);
      const [event] = await rows<{ correlation_id: string; causation_id: string | null }>(
        `select payload->>'correlationId' as correlation_id, payload->>'causationId' as causation_id
           from outbox_messages where payload->'data'->>'transactionId' = ? limit 1`,
        [result.transaction.id],
      );
      expect(present(event, 'event')).toEqual({ correlation_id: correlationId, causation_id: null });
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('rejects a BET without enough balance as INSUFFICIENT_FUNDS: no ledger entry, only Rejected', async () => {
      const scenario = await openScenario('100.00');

      const result = await submitWager.execute(bet(scenario, '150.00'));

      expect(result.idempotentReplay).toBe(false);
      expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(result.transaction.balanceAfter?.toJSON()).toEqual(money('100.00'));
      expect(await ledgerOf(result.transaction.id)).toEqual([]);
      expect(await eventTypesOf(result.transaction.id)).toEqual([REJECTED]);
      expect(await walletState(scenario.walletId)).toEqual({ balance: money('100.00'), version: 1 });
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('persists a REJECTED WALLET_NOT_FOUND without balance for an unknown wallet', async () => {
      const scenario = { walletId: Bun.randomUUIDv7(), playerId: 'player-unknown', providerId: newProviderId() };

      const result = await submitWager.execute(bet(scenario, '10.00'));

      expect(result.idempotentReplay).toBe(false);
      expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.transaction.failureCode).toBe(FailureCode.WalletNotFound);
      expect(result.transaction.balanceAfter).toBeUndefined();
      expect(await eventTypesOf(result.transaction.id)).toEqual([REJECTED]);
      expect(await countTransactions(scenario.providerId)).toBe(1);
    });
  });

  describe('WIN, LOSS, REFUND and ROLLBACK', () => {
    it('credits a WIN without reference', async () => {
      const scenario = await openScenario('100.00');

      const result = await submitWager.execute(
        command(scenario, { kind: WagerTransactionKind.Win, money: brl('20.00') }),
      );

      expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(result.transaction.referenceTransactionId).toBeUndefined();
      expect(result.transaction.balanceAfter?.toJSON()).toEqual(money('120.00'));
      expect(await ledgerOf(result.transaction.id)).toEqual([
        { direction: 'CREDIT', amount: '20.00', balance_before: '100.00', balance_after: '120.00' },
      ]);
      expect(await eventTypesOf(result.transaction.id)).toEqual([PROCESSED, BALANCE_CHANGED]);
      expect(await walletState(scenario.walletId)).toEqual({ balance: money('120.00'), version: 2 });
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('credits a WIN that references a processed BET and resolves the internal reference id', async () => {
      const scenario = await openScenario('100.00');
      const placed = bet(scenario, '25.00');
      const betResult = await submitWager.execute(placed);

      const result = await submitWager.execute(pointingAt(scenario, placed, WagerTransactionKind.Win, '40.00'));

      expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(result.transaction.referenceTransactionId).toBe(betResult.transaction.id);
      expect(result.transaction.balanceAfter?.toJSON()).toEqual(money('115.00'));
      expect(await ledgerOf(result.transaction.id)).toHaveLength(1);
      expect(await eventTypesOf(result.transaction.id)).toEqual([PROCESSED, BALANCE_CHANGED]);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('records a LOSS as PROCESSED without a ledger entry, a version bump or BalanceChanged', async () => {
      const scenario = await openScenario('100.00');
      const placed = bet(scenario, '25.00');
      await submitWager.execute(placed);
      const ledgerBefore = await countLedger(scenario.walletId);

      const result = await submitWager.execute(pointingAt(scenario, placed, WagerTransactionKind.Loss, '0.00'));

      expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(result.transaction.balanceAfter?.toJSON()).toEqual(money('75.00'));
      expect(await ledgerOf(result.transaction.id)).toEqual([]);
      expect(await countLedger(scenario.walletId)).toBe(ledgerBefore);
      expect(await eventTypesOf(result.transaction.id)).toEqual([PROCESSED]);
      expect(await walletState(scenario.walletId)).toEqual({ balance: money('75.00'), version: 2 });
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('credits the stake back on a REFUND of a BET', async () => {
      const scenario = await openScenario('100.00');
      const placed = bet(scenario, '25.00');
      const betResult = await submitWager.execute(placed);

      const result = await submitWager.execute(pointingAt(scenario, placed, WagerTransactionKind.Refund, '25.00'));

      expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(result.transaction.referenceTransactionId).toBe(betResult.transaction.id);
      expect(result.transaction.balanceAfter?.toJSON()).toEqual(money('100.00'));
      expect(await ledgerOf(result.transaction.id)).toEqual([
        { direction: 'CREDIT', amount: '25.00', balance_before: '75.00', balance_after: '100.00' },
      ]);
      expect(await eventTypesOf(result.transaction.id)).toEqual([PROCESSED, BALANCE_CHANGED]);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('credits the stake back on a ROLLBACK of a BET', async () => {
      const scenario = await openScenario('100.00');
      const placed = bet(scenario, '25.00');
      const betResult = await submitWager.execute(placed);

      const result = await submitWager.execute(pointingAt(scenario, placed, WagerTransactionKind.Rollback, '25.00'));

      expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(result.transaction.referenceTransactionId).toBe(betResult.transaction.id);
      expect(await ledgerOf(result.transaction.id)).toEqual([
        { direction: 'CREDIT', amount: '25.00', balance_before: '75.00', balance_after: '100.00' },
      ]);
      expect(await eventTypesOf(result.transaction.id)).toEqual([PROCESSED, BALANCE_CHANGED]);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('rejects the ROLLBACK of a spent WIN as REVERSAL_INSUFFICIENT_FUNDS, distinct from INSUFFICIENT_FUNDS', async () => {
      const scenario = await openScenario('0.00');
      const roundId = `round-${Bun.randomUUIDv7()}`;
      const won = command(scenario, { kind: WagerTransactionKind.Win, money: brl('50.00'), roundId });
      await submitWager.execute(won);
      await submitWager.execute(bet(scenario, '50.00', { roundId }));
      const ledgerBefore = await countLedger(scenario.walletId);

      const result = await submitWager.execute(pointingAt(scenario, won, WagerTransactionKind.Rollback, '50.00'));

      expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.transaction.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(result.transaction.failureCode).not.toBe(FailureCode.InsufficientFunds);
      expect(result.transaction.balanceAfter?.toJSON()).toEqual(money('0.00'));
      expect(await ledgerOf(result.transaction.id)).toEqual([]);
      expect(await countLedger(scenario.walletId)).toBe(ledgerBefore);
      expect(await eventTypesOf(result.transaction.id)).toEqual([REJECTED]);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('parks a REFUND whose reference does not exist yet as PENDING_REFERENCE', async () => {
      const scenario = await openScenario('100.00');

      const result = await submitWager.execute(
        command(scenario, {
          kind: WagerTransactionKind.Refund,
          money: brl('25.00'),
          referenceExternalTransactionId: `missing-${Bun.randomUUIDv7()}`,
        }),
      );

      expect(result.idempotentReplay).toBe(false);
      expect(result.transaction.status).toBe(WagerTransactionStatus.PendingReference);
      expect(result.transaction.balanceAfter).toBeUndefined();
      expect(await ledgerOf(result.transaction.id)).toEqual([]);
      expect(await eventTypesOf(result.transaction.id)).toEqual([PENDING_REFERENCE]);
      const [stored] = await rows<{ status: string }>('select status from wager_transactions where id = ?', [
        result.transaction.id,
      ]);
      expect(present(stored, 'stored transaction').status).toBe('PENDING_REFERENCE');
      expect(await walletState(scenario.walletId)).toEqual({ balance: money('100.00'), version: 1 });
      await assertWalletConsistent(orm, scenario.walletId);
    });
  });

  describe('idempotency', () => {
    it('replays an identical resubmission with the original balance and no new rows, even after the balance moved', async () => {
      const scenario = await openScenario('100.00');
      const first = bet(scenario, '25.00');
      const original = await submitWager.execute(first);
      await submitWager.execute(bet(scenario, '10.00'));
      const before = {
        transactions: await countTransactions(scenario.providerId),
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
      };

      const replay = await submitWager.execute({ ...first, correlationId: Bun.randomUUIDv7() });

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(original.transaction.id);
      expect(replay.transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(replay.transaction.balanceAfter?.toJSON()).toEqual(money('75.00'));
      expect({
        transactions: await countTransactions(scenario.providerId),
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
      }).toEqual(before);
      expect(await walletState(scenario.walletId)).toEqual({ balance: money('65.00'), version: 3 });
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('replays a REJECTED transaction as REJECTED', async () => {
      const scenario = await openScenario('100.00');
      const first = bet(scenario, '150.00');
      const original = await submitWager.execute(first);

      const replay = await submitWager.execute(first);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(original.transaction.id);
      expect(replay.transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(replay.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(await eventTypesOf(original.transaction.id)).toEqual([REJECTED]);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('refuses the same key with a different payload and writes nothing', async () => {
      const scenario = await openScenario('100.00');
      const first = bet(scenario, '25.00');
      await submitWager.execute(first);
      const before = {
        transactions: await countTransactions(scenario.providerId),
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
      };

      const error = await submitWager.execute({ ...first, money: brl('30.00') }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(IdempotencyConflictError);
      expect((error as IdempotencyConflictError).code).toBe(FailureCode.IdempotencyConflict);
      expect((error as IdempotencyConflictError).message).not.toContain(first.idempotencyKey);
      expect({
        transactions: await countTransactions(scenario.providerId),
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
      }).toEqual(before);
      expect(await walletState(scenario.walletId)).toEqual({ balance: money('75.00'), version: 2 });
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('refuses the same external transaction id under another key and writes nothing', async () => {
      const scenario = await openScenario('100.00');
      const first = bet(scenario, '25.00');
      await submitWager.execute(first);
      const before = {
        transactions: await countTransactions(scenario.providerId),
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
      };

      const error = await submitWager
        .execute({ ...first, idempotencyKey: `another-${first.idempotencyKey}` })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(IdempotencyConflictError);
      expect((error as IdempotencyConflictError).code).toBe(FailureCode.IdempotencyConflict);
      expect({
        transactions: await countTransactions(scenario.providerId),
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
      }).toEqual(before);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('keeps one key per provider: another provider may reuse the same key and external id', async () => {
      const scenario = await openScenario('100.00');
      const first = bet(scenario, '25.00');
      const original = await submitWager.execute(first);

      const other = await submitWager.execute({ ...first, providerId: newProviderId() });

      expect(other.idempotentReplay).toBe(false);
      expect(other.transaction.id).not.toBe(original.transaction.id);
      expect(other.transaction.balanceAfter?.toJSON()).toEqual(money('50.00'));
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('applies exactly once out of 5 concurrent identical submissions on an existing wallet', async () => {
      const scenario = await openScenario('100.00');
      const first = bet(scenario, '10.00');

      const results = await Promise.all(Array.from({ length: 5 }, () => submitWager.execute(first)));

      expect(new Set(results.map((result) => result.transaction.id)).size).toBe(1);
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
      expect(results.filter((result) => result.idempotentReplay)).toHaveLength(4);
      for (const result of results) {
        expect(result.transaction.balanceAfter?.toJSON()).toEqual(money('90.00'));
      }
      const id = present(results[0], 'result').transaction.id;
      expect(await countTransactions(scenario.providerId)).toBe(1);
      expect(await ledgerOf(id)).toHaveLength(1);
      expect(await eventTypesOf(id)).toEqual([PROCESSED, BALANCE_CHANGED]);
      expect(await walletState(scenario.walletId)).toEqual({ balance: money('90.00'), version: 2 });
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('resolves the insert race through the unique constraint when the wallet row does not exist', async () => {
      const scenario = { walletId: Bun.randomUUIDv7(), playerId: 'player-unknown', providerId: newProviderId() };
      const first = bet(scenario, '10.00');

      const results = await Promise.all(Array.from({ length: 5 }, () => submitWager.execute(first)));

      expect(new Set(results.map((result) => result.transaction.id)).size).toBe(1);
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
      expect(results.filter((result) => result.idempotentReplay)).toHaveLength(4);
      for (const result of results) {
        expect(result.transaction.status).toBe(WagerTransactionStatus.Rejected);
        expect(result.transaction.failureCode).toBe(FailureCode.WalletNotFound);
      }
      const id = present(results[0], 'result').transaction.id;
      expect(await countTransactions(scenario.providerId)).toBe(1);
      expect(await eventTypesOf(id)).toEqual([REJECTED]);
    });
  });

  describe('inbox (SQS entry)', () => {
    const consumerName = 'test-consumer';

    it('records the message as processed in the same transaction and carries it as causationId', async () => {
      const scenario = await openScenario('100.00');
      const messageId = Bun.randomUUIDv7();

      const result = await submitWager.execute(bet(scenario, '25.00', { inbox: { consumerName, messageId } }));

      expect(result.idempotentReplay).toBe(false);
      expect(await countInbox(consumerName, [messageId])).toBe(1);
      const events = await rows<{ causation_id: string | null }>(
        "select payload->>'causationId' as causation_id from outbox_messages where payload->'data'->>'transactionId' = ?",
        [result.transaction.id],
      );
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.causation_id === messageId)).toBe(true);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('treats a redelivery of the same message as a replay with no new effect', async () => {
      const scenario = await openScenario('100.00');
      const messageId = Bun.randomUUIDv7();
      const first = bet(scenario, '25.00', { inbox: { consumerName, messageId } });
      const original = await submitWager.execute(first);
      const before = {
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
        transactions: await countTransactions(scenario.providerId),
      };

      const redelivery = await submitWager.execute(first);

      expect(redelivery.idempotentReplay).toBe(true);
      expect(redelivery.transaction.id).toBe(original.transaction.id);
      expect(await countInbox(consumerName, [messageId])).toBe(1);
      expect({
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
        transactions: await countTransactions(scenario.providerId),
      }).toEqual(before);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('refuses the same message id carrying a different payload and writes nothing', async () => {
      const scenario = await openScenario('100.00');
      const messageId = Bun.randomUUIDv7();
      const first = bet(scenario, '25.00', { inbox: { consumerName, messageId } });
      await submitWager.execute(first);
      const before = {
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
        transactions: await countTransactions(scenario.providerId),
      };

      const error = await submitWager.execute({ ...first, money: brl('30.00') }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InboxMessageConflictError);
      expect((error as InboxMessageConflictError).code).toBe(FailureCode.IdempotencyConflict);
      expect({
        ledger: await countLedger(scenario.walletId),
        outbox: await countOutbox(scenario.walletId),
        transactions: await countTransactions(scenario.providerId),
      }).toEqual(before);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('records a new message id that carries an already processed key as a replay, and a second inbox row', async () => {
      const scenario = await openScenario('100.00');
      const firstMessageId = Bun.randomUUIDv7();
      const secondMessageId = Bun.randomUUIDv7();
      const first = bet(scenario, '25.00', { inbox: { consumerName, messageId: firstMessageId } });
      const original = await submitWager.execute(first);

      const replay = await submitWager.execute({ ...first, inbox: { consumerName, messageId: secondMessageId } });

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(original.transaction.id);
      expect(await countInbox(consumerName, [firstMessageId, secondMessageId])).toBe(2);
      expect(await ledgerOf(original.transaction.id)).toHaveLength(1);
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('applies exactly once out of 5 concurrent deliveries of the same message', async () => {
      const scenario = await openScenario('100.00');
      const messageId = Bun.randomUUIDv7();
      const first = bet(scenario, '10.00', { inbox: { consumerName, messageId } });

      const results = await Promise.all(Array.from({ length: 5 }, () => submitWager.execute(first)));

      expect(new Set(results.map((result) => result.transaction.id)).size).toBe(1);
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
      expect(await countInbox(consumerName, [messageId])).toBe(1);
      expect(await countTransactions(scenario.providerId)).toBe(1);
      expect(await walletState(scenario.walletId)).toEqual({ balance: money('90.00'), version: 2 });
      await assertWalletConsistent(orm, scenario.walletId);
    });
  });

  describe('validation', () => {
    it('refuses the internal OPENING kind and writes nothing', async () => {
      const scenario = await openScenario('100.00');
      const before = await countLedger(scenario.walletId);

      const error = await submitWager
        .execute(command(scenario, { kind: WagerTransactionKind.Opening, money: brl('10.00') }))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(KindNotAllowedError);
      expect((error as KindNotAllowedError).code).toBe(FailureCode.KindNotAllowed);
      expect(await countTransactions(scenario.providerId)).toBe(0);
      expect(await countLedger(scenario.walletId)).toBe(before);
      expect(await countOutbox(scenario.walletId)).toBe(0);
      await assertWalletConsistent(orm, scenario.walletId);
    });
  });
});
