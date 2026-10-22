import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { ConcurrencyMetrics } from '../../../../../src/infrastructure/database/concurrency-metrics';
import { MikroOrmUnitOfWork } from '../../../../../src/infrastructure/database/mikro-orm-unit-of-work';
import { WagerTransactionRepository } from '../../../../../src/modules/wagering/application/wager-transaction-repository';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { WalletLedgerRepository } from '../../../../../src/modules/wallet/application/wallet-ledger-repository';
import { WalletRepository } from '../../../../../src/modules/wallet/application/wallet-repository';
import {
  ConcurrencyConflictError,
  ConcurrencyConflictReason,
  UnitOfWork,
} from '../../../../../src/shared/application/unit-of-work';
import { ExponentialBackoff } from '../../../../../src/shared/domain/exponential-backoff';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { newProviderId, openWalletWithBalance } from '../../../../support/fixtures';
import { inFreshContext, inTransaction, present } from '../../../../support/orm-context';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

type DebitOutcome = 'applied' | 'insufficient';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('wallet concurrency (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let uow: UnitOfWork;
  let wallets: WalletRepository;
  let transactions: WagerTransactionRepository;
  let ledger: WalletLedgerRepository;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    uow = app.get(UnitOfWork);
    wallets = app.get(WalletRepository);
    transactions = app.get(WagerTransactionRepository);
    ledger = app.get(WalletLedgerRepository);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Fluxo mínimo de débito que os casos de uso vão seguir: trava a wallet, decide, grava transação, lançamento e saldo. */
  function debit(walletId: string, amount: string): Promise<DebitOutcome> {
    const providerId = newProviderId();
    return uow.run<DebitOutcome>(async () => {
      const wallet = present(await wallets.lockById(walletId), 'wallet');
      const money = Money.from({ amount, currency: wallet.currency });
      if (!wallet.canDebit(money)) {
        return 'insufficient';
      }
      const expectedVersion = wallet.version;
      const transactionId = Bun.randomUUIDv7();
      const now = new Date();
      const bet = WagerTransaction.create({
        id: transactionId,
        providerId,
        externalTransactionId: `bet-${transactionId}`,
        idempotencyKey: `bet-${transactionId}`,
        payloadHash: `hash-${transactionId}`,
        walletId,
        playerId: wallet.playerId,
        roundId: `round-${transactionId}`,
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money,
        createdAt: now,
      });
      const entry = wallet.debit({ money, transactionId, ledgerEntryId: Bun.randomUUIDv7(), at: now });
      bet.markProcessed({ at: now, balanceAfter: wallet.balance });
      await transactions.insert(bet);
      await ledger.append(entry);
      await wallets.updateBalance(wallet, expectedVersion);
      return 'applied';
    });
  }

  async function readWallet(walletId: string) {
    return present(await inFreshContext(orm, () => wallets.findById(walletId)), 'wallet');
  }

  async function countDebits(walletId: string): Promise<number> {
    const rows = await orm.em
      .fork()
      .execute<{ n: number }[]>(
        "select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
        [walletId],
      );
    return present(rows[0], 'count row').n;
  }

  function countOutcomes(outcomes: DebitOutcome[]): Record<DebitOutcome, number> {
    return {
      applied: outcomes.filter((outcome) => outcome === 'applied').length,
      insufficient: outcomes.filter((outcome) => outcome === 'insufficient').length,
    };
  }

  it('applies exactly the affordable debits out of 20 parallel ones, with no lost update', async () => {
    const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });

    const outcomes = await Promise.all(Array.from({ length: 20 }, () => debit(wallet.id, '10.00')));

    expect(countOutcomes(outcomes)).toEqual({ applied: 10, insufficient: 10 });
    const read = await readWallet(wallet.id);
    expect(read.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(read.version).toBe(11);
    expect(await countDebits(wallet.id)).toBe(10);
    await assertWalletConsistent(orm, wallet.id);
  });

  it('accepts one of two simultaneous 80.00 bets on a 100.00 wallet (§8)', async () => {
    const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });

    const outcomes = await Promise.all([debit(wallet.id, '80.00'), debit(wallet.id, '80.00')]);

    expect(countOutcomes(outcomes)).toEqual({ applied: 1, insufficient: 1 });
    const read = await readWallet(wallet.id);
    expect(read.balance.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(await countDebits(wallet.id)).toBe(1);
    await assertWalletConsistent(orm, wallet.id);
  });

  it('does not make different wallets wait for each other', async () => {
    const x = (await openWalletWithBalance(app, { amount: '100.00' })).wallet;
    const y = (await openWalletWithBalance(app, { amount: '100.00' })).wallet;
    const locked = deferred();
    const release = deferred();
    let ownerSettled = false;
    const owner = uow
      .run(async () => {
        await wallets.lockById(x.id);
        locked.resolve();
        await release.promise;
      })
      .finally(() => {
        ownerSettled = true;
      });
    await Promise.race([locked.promise, owner]);

    try {
      expect(await debit(y.id, '10.00')).toBe('applied');
      expect(ownerSettled).toBe(false);

      // Controle: X está de fato travada, então quem tenta travá-la desiste por lock timeout.
      const impatient = new MikroOrmUnitOfWork(orm.em, app.get(ConcurrencyMetrics), {
        lockTimeoutMs: 200,
        maxAttempts: 1,
        backoff: new ExponentialBackoff({ baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }, () => 0),
      });
      const error = await impatient.run(() => wallets.lockById(x.id)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConcurrencyConflictError);
      expect((error as ConcurrencyConflictError).reason).toBe(ConcurrencyConflictReason.LockTimeout);
    } finally {
      release.resolve();
      await owner;
    }

    await assertWalletConsistent(orm, x.id);
    await assertWalletConsistent(orm, y.id);
  });

  it('rejects updateBalance with VERSION_CONFLICT when the row moved on, and rolls back', async () => {
    const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });

    const error = await inTransaction(orm, async () => {
      const locked = present(await wallets.lockById(wallet.id), 'wallet');
      const expectedVersion = locked.version;
      locked.debit({
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        transactionId: Bun.randomUUIDv7(),
        ledgerEntryId: Bun.randomUUIDv7(),
        at: new Date(),
      });
      // Outro escritor que passou por cima do lock.
      await orm.em.execute('update wallets set version = version + 1 where id = ?', [wallet.id]);
      await wallets.updateBalance(locked, expectedVersion);
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConcurrencyConflictError);
    expect((error as ConcurrencyConflictError).reason).toBe(ConcurrencyConflictReason.VersionConflict);
    const read = await readWallet(wallet.id);
    expect(read.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(read.version).toBe(1);
    await assertWalletConsistent(orm, wallet.id);
  });

  it('refuses updateBalance when the wallet version was not bumped by one', async () => {
    const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });

    await expect(
      inTransaction(orm, async () => {
        const locked = present(await wallets.lockById(wallet.id), 'wallet');
        await wallets.updateBalance(locked, locked.version);
      }),
    ).rejects.toThrow('must be expectedVersion + 1');
  });

  it('returns null when locking a wallet that does not exist', async () => {
    expect(await inTransaction(orm, () => wallets.lockById(Bun.randomUUIDv7()))).toBeNull();
  });

  it('refuses lockById and updateBalance outside em.transactional()', async () => {
    const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });

    await expect(inFreshContext(orm, () => wallets.lockById(wallet.id))).rejects.toThrow(
      'must run inside em.transactional()',
    );
    await expect(inFreshContext(orm, () => wallets.updateBalance(wallet, 0))).rejects.toThrow(
      'must run inside em.transactional()',
    );
  });
});
