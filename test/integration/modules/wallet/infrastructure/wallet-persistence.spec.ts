import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { WagerTransactionRepository } from '../../../../../src/modules/wagering/application/wager-transaction-repository';
import { WagerTransaction } from '../../../../../src/modules/wagering/domain/wager-transaction';
import { WalletLedgerRepository } from '../../../../../src/modules/wallet/application/wallet-ledger-repository';
import { WalletRepository } from '../../../../../src/modules/wallet/application/wallet-repository';
import { Wallet } from '../../../../../src/modules/wallet/domain/wallet';
import { LedgerDirection } from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { inFreshContext, inTransaction, present } from '../../../../support/orm-context';

const OPENED_AT = new Date('2026-10-22T10:00:00.123Z');

function openWalletWithBalance(amount: string) {
  const walletId = Bun.randomUUIDv7();
  const transactionId = Bun.randomUUIDv7();
  const playerId = `player-${Bun.randomUUIDv7()}`;
  const initialBalance = Money.from({ amount, currency: 'BRL' });
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance,
    openedAt: OPENED_AT,
    opening: { transactionId, ledgerEntryId: Bun.randomUUIDv7() },
  });
  const openingTransaction = WagerTransaction.createOpening({
    id: transactionId,
    providerId: 'wallet-opening',
    externalTransactionId: `opening-${transactionId}`,
    idempotencyKey: `opening-${transactionId}`,
    payloadHash: `hash-${transactionId}`,
    walletId,
    playerId,
    roundId: `round-${transactionId}`,
    gameId: 'game-1',
    money: initialBalance,
    createdAt: OPENED_AT,
  });
  return { wallet, openingEntry: present(openingEntry, 'opening entry'), openingTransaction };
}

describe('wallet persistence (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let wallets: WalletRepository;
  let ledger: WalletLedgerRepository;
  let transactions: WagerTransactionRepository;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    wallets = app.get(WalletRepository);
    ledger = app.get(WalletLedgerRepository);
    transactions = app.get(WagerTransactionRepository);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('round-trips a wallet with a zero balance and no ledger entry', async () => {
    const { wallet } = Wallet.open({
      id: Bun.randomUUIDv7(),
      playerId: `player-${Bun.randomUUIDv7()}`,
      initialBalance: Money.zero('BRL'),
      openedAt: OPENED_AT,
    });

    await inTransaction(orm, () => wallets.insert(wallet));
    const read = present(await inFreshContext(orm, () => wallets.findById(wallet.id)), 'wallet');

    expect(read.id).toBe(wallet.id);
    expect(read.playerId).toBe(wallet.playerId);
    expect(read.currency).toBe('BRL');
    expect(read.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(read.version).toBe(1);
    expect(read.createdAt.getTime()).toBe(OPENED_AT.getTime());
    expect(read.updatedAt.getTime()).toBe(OPENED_AT.getTime());
    expect(read.lastLedgerEntryId).toBeUndefined();
  });

  it.each(['99999999.99', '0.10'])(
    'round-trips a wallet opened with %s together with its OPENING transaction and ledger entry',
    async (amount) => {
      const { wallet, openingEntry, openingTransaction } = openWalletWithBalance(amount);

      await inTransaction(orm, async () => {
        await wallets.insert(wallet);
        await transactions.insert(openingTransaction);
        await ledger.append(openingEntry);
      });

      const readWallet = present(
        await inFreshContext(orm, () => wallets.findById(wallet.id)),
        'wallet',
      );
      const readEntry = present(
        await inFreshContext(orm, () => ledger.findById(openingEntry.id)),
        'ledger entry',
      );

      expect(readWallet.balance.toJSON()).toEqual({ amount, currency: 'BRL' });
      expect(readWallet.version).toBe(1);
      expect(readWallet.createdAt.getTime()).toBe(OPENED_AT.getTime());

      expect(readEntry.id).toBe(openingEntry.id);
      expect(readEntry.walletId).toBe(wallet.id);
      expect(readEntry.transactionId).toBe(openingTransaction.id);
      expect(readEntry.direction).toBe(LedgerDirection.Credit);
      expect(readEntry.money.toJSON()).toEqual({ amount, currency: 'BRL' });
      expect(readEntry.balanceBefore.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(readEntry.balanceAfter.toJSON()).toEqual({ amount, currency: 'BRL' });
      expect(readEntry.createdAt.getTime()).toBe(OPENED_AT.getTime());
      expect(readEntry.isBalanced()).toBe(true);
      // §13: o saldo da wallet é o saldo reconstruído pelo ledger.
      expect(readWallet.balance.equals(readEntry.balanceAfter)).toBe(true);
    },
  );

  it('returns null for ids that do not exist', async () => {
    expect(await inFreshContext(orm, () => wallets.findById(Bun.randomUUIDv7()))).toBeNull();
    expect(await inFreshContext(orm, () => ledger.findById(Bun.randomUUIDv7()))).toBeNull();
  });

  it('refuses to write outside em.transactional()', async () => {
    const { wallet, openingEntry } = openWalletWithBalance('1.00');

    await expect(inFreshContext(orm, () => wallets.insert(wallet))).rejects.toThrow(
      'must run inside em.transactional()',
    );
    await expect(inFreshContext(orm, () => ledger.append(openingEntry))).rejects.toThrow(
      'must run inside em.transactional()',
    );
    expect(await inFreshContext(orm, () => wallets.findById(wallet.id))).toBeNull();
  });

  it('leaves nothing behind when the transaction throws', async () => {
    const { wallet } = Wallet.open({
      id: Bun.randomUUIDv7(),
      playerId: `player-${Bun.randomUUIDv7()}`,
      initialBalance: Money.zero('BRL'),
      openedAt: OPENED_AT,
    });

    await expect(
      inTransaction(orm, async () => {
        await wallets.insert(wallet);
        expect(await wallets.findById(wallet.id)).not.toBeNull();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await inFreshContext(orm, () => wallets.findById(wallet.id))).toBeNull();
  });
});
