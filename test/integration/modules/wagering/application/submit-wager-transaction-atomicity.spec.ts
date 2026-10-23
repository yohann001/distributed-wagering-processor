import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { Clock } from '../../../../../src/shared/application/clock';
import { IdGenerator } from '../../../../../src/shared/application/id-generator';
import { UnitOfWork } from '../../../../../src/shared/application/unit-of-work';
import { Money } from '../../../../../src/shared/domain/money';
import { InboxRepository } from '../../../../../src/modules/messaging/application/inbox-repository';
import { OutboxRepository } from '../../../../../src/modules/messaging/application/outbox-repository';
import { defaultIdempotencyKey } from '../../../../../src/modules/wagering/application/payload-hash';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../../../src/modules/wagering/application/submit-wager-transaction';
import { WagerTransactionMonitor } from '../../../../../src/modules/wagering/application/wager-transaction-monitor';
import { WagerTransactionRepository } from '../../../../../src/modules/wagering/application/wager-transaction-repository';
import { WagerApplicationPolicy } from '../../../../../src/modules/wagering/domain/wager-application-policy';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { WalletLedgerRepository } from '../../../../../src/modules/wallet/application/wallet-ledger-repository';
import { WalletRepository } from '../../../../../src/modules/wallet/application/wallet-repository';
import { createTestApp } from '../../../../support/create-test-app';
import { COMMIT_FAULT_PREFIX, InjectedFault, failingAt, installCommitFault } from '../../../../support/fault-injection';
import { newProviderId, openWalletWithBalance } from '../../../../support/fixtures';
import { inFreshContext, present } from '../../../../support/orm-context';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

interface Scenario {
  walletId: string;
  playerId: string;
  providerId: string;
}

interface TableCounts {
  transactions: number;
  ledger: number;
  inbox: number;
  outbox: number;
}

interface Ports {
  transactions: WagerTransactionRepository;
  wallets: WalletRepository;
  ledger: WalletLedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

const CONSUMER_NAME = 'atomicity-test-consumer';

// §13 (integração: atomicidade), §6.5, §11: transação, saldo, ledger, inbox e outbox são uma única transação SQL.
// Cada falha vem de um ponto real da transação: os repositórios continuam os do app (o SQL roda de verdade) e o
// proxy só lança antes ou depois da chamada escolhida; a falha no COMMIT é um trigger deferred real do Postgres.
describe('SubmitWagerTransaction atomicity (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let submitWager: SubmitWagerTransaction;
  let uow: UnitOfWork;
  let clock: Clock;
  let ids: IdGenerator;
  let monitor: WagerTransactionMonitor;
  let real: Ports;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    submitWager = app.get(SubmitWagerTransaction);
    uow = app.get(UnitOfWork);
    clock = app.get(Clock);
    ids = app.get(IdGenerator);
    monitor = app.get(WagerTransactionMonitor);
    real = {
      transactions: app.get(WagerTransactionRepository),
      wallets: app.get(WalletRepository),
      ledger: app.get(WalletLedgerRepository),
      inbox: app.get(InboxRepository),
      outbox: app.get(OutboxRepository),
    };
  });

  afterAll(async () => {
    await app?.close();
  });

  const money = (amount: string) => ({ amount, currency: 'BRL' });

  /** Mesma ordem de argumentos do `useFactory` do `WageringModule`; cada porta é a real, salvo a trocada. */
  function useCase(overrides: Partial<Ports>): SubmitWagerTransaction {
    const ports: Ports = { ...real, ...overrides };
    return new SubmitWagerTransaction(
      uow,
      ports.transactions,
      ports.wallets,
      ports.ledger,
      ports.inbox,
      ports.outbox,
      new WagerApplicationPolicy(),
      clock,
      ids,
      monitor,
    );
  }

  function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
    return orm.em.fork().execute<T[]>(sql, params);
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const result = await rows<{ n: number }>(sql, params);
    return present(result[0], 'count row').n;
  }

  async function tableCounts(): Promise<TableCounts> {
    const result = await rows<TableCounts>(
      `select (select count(*)::int from wager_transactions) as transactions,
              (select count(*)::int from wallet_ledger_entries) as ledger,
              (select count(*)::int from inbox_messages) as inbox,
              (select count(*)::int from outbox_messages) as outbox`,
      [],
    );
    return present(result[0], 'table counts');
  }

  const countLedger = (walletId: string) =>
    count('select count(*)::int as n from wallet_ledger_entries where wallet_id = ?', [walletId]);
  const countOutbox = (walletId: string) =>
    count("select count(*)::int as n from outbox_messages where payload->'data'->>'walletId' = ?", [walletId]);
  const countInbox = (messageId: string) =>
    count(
      'select count(*)::int as n from inbox_messages where consumer_name = ? and message_id = ? and processed_at is not null',
      [CONSUMER_NAME, messageId],
    );

  async function walletState(walletId: string) {
    const wallet = present(await inFreshContext(orm, () => real.wallets.findById(walletId)), 'wallet');
    return { balance: wallet.balance.toJSON(), version: wallet.version };
  }

  async function openScenario(amount: string): Promise<Scenario> {
    const { wallet } = await openWalletWithBalance(app, { amount });
    return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
  }

  /** BET 30.00 vinda do SQS (leva `inbox`) numa wallet com 100.00: a decisão é `Applied` e as 4 tabelas recebem linhas. */
  function sqsBet(scenario: Scenario): SubmitWagerTransactionCommand {
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
    return {
      idempotencyKey: defaultIdempotencyKey(scenario.providerId, externalTransactionId),
      providerId: scenario.providerId,
      externalTransactionId,
      walletId: scenario.walletId,
      playerId: scenario.playerId,
      roundId: `round-${Bun.randomUUIDv7()}`,
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from(money('30.00')),
      correlationId: Bun.randomUUIDv7(),
      inbox: { consumerName: CONSUMER_NAME, messageId: Bun.randomUUIDv7() },
    };
  }

  /** A falha não deixou nada: as 4 tabelas com as mesmas contagens e a wallet intacta e consistente. */
  async function expectNothingPersisted(scenario: Scenario, before: TableCounts): Promise<void> {
    expect(await tableCounts()).toEqual(before);
    expect(await walletState(scenario.walletId)).toEqual({ balance: money('100.00'), version: 1 });
    await assertWalletConsistent(orm, scenario.walletId);
  }

  /**
   * Reenviar o mesmo comando (mesmo `messageId`, mesma key) sem a falha aplica uma única vez. Se a falha tivesse
   * deixado uma linha (a inbox, por exemplo), o reenvio viraria replay e nada seria debitado.
   */
  async function expectResubmitAppliesOnce(
    scenario: Scenario,
    command: SubmitWagerTransactionCommand,
    before: TableCounts,
  ): Promise<void> {
    const result = await submitWager.execute(command);

    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(result.idempotentReplay).toBe(false);
    expect(await walletState(scenario.walletId)).toEqual({ balance: money('70.00'), version: 2 });
    expect(await countLedger(scenario.walletId)).toBe(2);
    expect(
      await rows<{ amount: string }>(
        "select amount::text as amount from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
        [scenario.walletId],
      ),
    ).toEqual([{ amount: '30.00' }]);
    expect(await countInbox(present(command.inbox, 'inbox').messageId)).toBe(1);
    expect(await countOutbox(scenario.walletId)).toBe(2);
    expect(await tableCounts()).toEqual({
      transactions: before.transactions + 1,
      ledger: before.ledger + 1,
      inbox: before.inbox + 1,
      outbox: before.outbox + 2,
    });
    await assertWalletConsistent(orm, scenario.walletId);
  }

  const faults: { name: string; point: string; build: () => SubmitWagerTransaction }[] = [
    {
      name: 'after the transaction row is written',
      point: 'after insert #1',
      build: () => useCase({ transactions: failingAt(real.transactions, 'insert', { when: 'after' }) }),
    },
    {
      name: 'after the balance is updated',
      point: 'after updateBalance #1',
      build: () => useCase({ wallets: failingAt(real.wallets, 'updateBalance', { when: 'after' }) }),
    },
    {
      name: 'after the ledger entry',
      point: 'after append #1',
      build: () => useCase({ ledger: failingAt(real.ledger, 'append', { when: 'after' }) }),
    },
    {
      name: 'before the first outbox event',
      point: 'before insert #1',
      build: () => useCase({ outbox: failingAt(real.outbox, 'insert', { when: 'before' }) }),
    },
    {
      name: 'between the two outbox events',
      point: 'before insert #2',
      build: () => useCase({ outbox: failingAt(real.outbox, 'insert', { when: 'before', call: 2 }) }),
    },
  ];

  for (const fault of faults) {
    it(`rolls back everything when it fails ${fault.name}`, async () => {
      const scenario = await openScenario('100.00');
      const command = sqsBet(scenario);
      const before = await tableCounts();

      const error = await fault.build().execute(command).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InjectedFault);
      expect(error).toMatchObject({ point: fault.point });
      await expectNothingPersisted(scenario, before);
      await expectResubmitAppliesOnce(scenario, command, before);
    });
  }

  it('rolls back everything when the COMMIT itself fails', async () => {
    const scenario = await openScenario('100.00');
    const command = sqsBet(scenario);
    const before = await tableCounts();
    const remove = await installCommitFault(orm, scenario.walletId);

    try {
      // Só um trigger deferred dispara no COMMIT: nenhuma exceção da aplicação antes dele pode ser a causa.
      const triggers = await rows<{ deferrable: boolean; initially_deferred: boolean }>(
        `select tgdeferrable as deferrable, tginitdeferred as initially_deferred from pg_trigger
          where tgrelid = 'outbox_messages'::regclass and starts_with(tgname, ?)`,
        [COMMIT_FAULT_PREFIX],
      );
      expect(triggers).toEqual([{ deferrable: true, initially_deferred: true }]);

      const error = await submitWager.execute(command).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(InjectedFault);
      expect(error).toMatchObject({ code: 'P0001' });
      await expectNothingPersisted(scenario, before);
    } finally {
      await remove();
    }

    await expectResubmitAppliesOnce(scenario, command, before);
  });
});
