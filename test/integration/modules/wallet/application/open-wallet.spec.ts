import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { OPENING_PROVIDER_ID, OpenWallet } from '../../../../../src/modules/wallet/application/open-wallet';
import { WalletRepository } from '../../../../../src/modules/wallet/application/wallet-repository';
import { WalletAlreadyExistsError } from '../../../../../src/modules/wallet/domain/wallet';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { inFreshContext, present } from '../../../../support/orm-context';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  kind: string;
  status: string;
  balance_after: string;
  created_at: string;
}

interface LedgerRow {
  transaction_id: string;
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
  created_at: string;
}

interface OutboxRow {
  aggregate_id: string;
  event_type: string;
  payload: {
    correlationId: string;
    data: { walletVersion?: number; balanceAfter?: { amount: string; currency: string } };
  };
  occurred_at: string;
}

/** Instante em ISO-8601 UTC com milissegundos, o mesmo formato de `Date.toISOString()`. */
const isoUtc = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

describe('OpenWallet (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let openWallet: OpenWallet;
  let wallets: WalletRepository;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    openWallet = app.get(OpenWallet);
    wallets = app.get(WalletRepository);
  });

  afterAll(async () => {
    await app?.close();
  });

  const newPlayerId = (): string => `player-${Bun.randomUUIDv7()}`;
  const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

  function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
    return orm.em.fork().execute<T[]>(sql, params);
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const result = await rows<{ n: number }>(sql, params);
    return present(result[0], 'count row').n;
  }

  const countWallets = (playerId: string) =>
    count('select count(*)::int as n from wallets where player_id = ?', [playerId]);
  const countTransactions = (playerId: string) =>
    count('select count(*)::int as n from wager_transactions where player_id = ?', [playerId]);
  const countLedger = (walletId: string) =>
    count('select count(*)::int as n from wallet_ledger_entries where wallet_id = ?', [walletId]);

  it('opens a wallet with a positive balance as OPENING + CREDIT + 2 outbox events in one transaction', async () => {
    const playerId = newPlayerId();
    const correlationId = Bun.randomUUIDv7();

    const wallet = await openWallet.execute({ playerId, initialBalance: brl('1000.00'), correlationId });

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    const read = present(await inFreshContext(orm, () => wallets.findById(wallet.id)), 'wallet');
    expect(read.playerId).toBe(playerId);
    expect(read.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(read.version).toBe(1);

    const transactions = await rows<TransactionRow>(
      `select id, provider_id, external_transaction_id, kind, status, balance_after::text as balance_after, ${isoUtc('created_at')} as created_at
         from wager_transactions where wallet_id = ?`,
      [wallet.id],
    );
    expect(transactions).toHaveLength(1);
    const opening = present(transactions[0], 'opening transaction');
    expect(opening.kind).toBe('OPENING');
    expect(opening.status).toBe('PROCESSED');
    expect(opening.balance_after).toBe('1000.00');
    expect(opening.provider_id).toBe(OPENING_PROVIDER_ID);
    expect(opening.external_transaction_id).toBe(wallet.id);

    const entries = await rows<LedgerRow>(
      `select transaction_id, direction, amount::text as amount, balance_before::text as balance_before,
              balance_after::text as balance_after, ${isoUtc('created_at')} as created_at
         from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
    );
    expect(entries).toHaveLength(1);
    const entry = present(entries[0], 'ledger entry');
    expect(entry.direction).toBe('CREDIT');
    expect(entry.amount).toBe('1000.00');
    expect(entry.balance_before).toBe('0.00');
    expect(entry.balance_after).toBe('1000.00');
    expect(entry.transaction_id).toBe(opening.id);

    const events = await rows<OutboxRow>(
      `select aggregate_id, event_type, payload, ${isoUtc('occurred_at')} as occurred_at from outbox_messages
        where aggregate_id in (?, ?) order by event_type`,
      [wallet.id, opening.id],
    );
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const processed = present(events[0], 'WagerTransactionProcessed event');
    const balanceChanged = present(events[1], 'WalletBalanceChanged event');
    expect(processed.aggregate_id).toBe(opening.id);
    expect(balanceChanged.aggregate_id).toBe(wallet.id);
    expect(balanceChanged.payload.data.walletVersion).toBe(1);
    expect(balanceChanged.payload.data.balanceAfter).toEqual({ amount: '1000.00', currency: 'BRL' });
    for (const event of events) {
      expect(event.payload.correlationId).toBe(correlationId);
    }

    // Uma única leitura do relógio: wallet, transação, lançamento e eventos compartilham o instante.
    const instant = wallet.createdAt.toISOString();
    expect(opening.created_at).toBe(instant);
    expect(entry.created_at).toBe(instant);
    for (const event of events) {
      expect(event.occurred_at).toBe(instant);
    }

    await assertWalletConsistent(orm, wallet.id);
  });

  it('opens a wallet with a zero balance without transaction, ledger entry or event', async () => {
    const playerId = newPlayerId();

    const wallet = await openWallet.execute({
      playerId,
      initialBalance: brl('0.00'),
      correlationId: Bun.randomUUIDv7(),
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    const read = present(await inFreshContext(orm, () => wallets.findById(wallet.id)), 'wallet');
    expect(read.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(read.version).toBe(1);
    expect(await countTransactions(playerId)).toBe(0);
    expect(await countLedger(wallet.id)).toBe(0);
    expect(
      await count('select count(*)::int as n from outbox_messages where aggregate_id = ?', [wallet.id]),
    ).toBe(0);
    await assertWalletConsistent(orm, wallet.id);
  });

  it('creates exactly one wallet out of 5 concurrent openings for the same player and currency', async () => {
    const playerId = newPlayerId();

    const correlationIds = Array.from({ length: 5 }, () => Bun.randomUUIDv7());

    const results = await Promise.allSettled(
      correlationIds.map((correlationId) =>
        openWallet.execute({ playerId, initialBalance: brl('100.00'), correlationId }),
      ),
    );

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<OpenWallet['execute']>>> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const { reason } of rejected) {
      expect(reason).toBeInstanceOf(WalletAlreadyExistsError);
      expect((reason as WalletAlreadyExistsError).code).toBe(FailureCode.WalletAlreadyExists);
    }

    const winner = present(fulfilled[0], 'winner').value;
    expect(await countWallets(playerId)).toBe(1);
    expect(await countTransactions(playerId)).toBe(1);
    expect(await countLedger(winner.id)).toBe(1);
    // Sem evento órfão das tentativas perdedoras: só os 2 da vencedora.
    expect(
      await count(
        "select count(*)::int as n from outbox_messages where payload->'data'->>'playerId' = ?",
        [playerId],
      ),
    ).toBe(1);
    expect(
      await count('select count(*)::int as n from outbox_messages where aggregate_id = ?', [winner.id]),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::int as n from outbox_messages where payload->>'correlationId' in (${correlationIds.map(() => '?').join(', ')})`,
        correlationIds,
      ),
    ).toBe(2);
    await assertWalletConsistent(orm, winner.id);
  });

  it('refuses a second wallet for the same player and currency, and accepts another currency', async () => {
    const playerId = newPlayerId();
    const first = await openWallet.execute({
      playerId,
      initialBalance: brl('50.00'),
      correlationId: Bun.randomUUIDv7(),
    });

    const error = await openWallet
      .execute({ playerId, initialBalance: brl('0.00'), correlationId: Bun.randomUUIDv7() })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect((error as WalletAlreadyExistsError).code).toBe(FailureCode.WalletAlreadyExists);
    expect(await countWallets(playerId)).toBe(1);
    expect(await countTransactions(playerId)).toBe(1);

    const usd = await openWallet.execute({
      playerId,
      initialBalance: Money.from({ amount: '10.00', currency: 'USD' }),
      correlationId: Bun.randomUUIDv7(),
    });

    expect(await countWallets(playerId)).toBe(2);
    await assertWalletConsistent(orm, first.id);
    await assertWalletConsistent(orm, usd.id);
  });
});
