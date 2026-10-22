import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { WagerTransactionRepository } from '../../../../../src/modules/wagering/application/wager-transaction-repository';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { inFreshContext, inTransaction, present } from '../../../../support/orm-context';

const CREATED_AT = new Date('2026-10-22T10:00:00.123Z');
const PROCESSED_AT = new Date('2026-10-22T10:00:01.456Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

interface NewTransactionOptions {
  kind: WagerTransactionKind;
  amount: string;
  walletId?: string;
  referenceExternalTransactionId?: string;
}

function newTransaction(options: NewTransactionOptions): WagerTransaction {
  const id = Bun.randomUUIDv7();
  return WagerTransaction.create({
    id,
    providerId: `provider-${id}`,
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `idem-${id}`,
    payloadHash: `hash-${id}`,
    walletId: options.walletId ?? Bun.randomUUIDv7(),
    playerId: `player-${id}`,
    roundId: `round-${id}`,
    gameId: 'game-1',
    kind: options.kind,
    money: brl(options.amount),
    referenceExternalTransactionId: options.referenceExternalTransactionId,
    createdAt: CREATED_AT,
  });
}

/** Vista comparável: dinheiro como `toJSON()` e datas como epoch, para o `toEqual` cobrir tudo. */
function view(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    status: tx.status,
    failureCode: tx.failureCode,
    balanceAfter: tx.balanceAfter?.toJSON(),
    processedAt: tx.processedAt?.getTime(),
    createdAt: tx.createdAt.getTime(),
  };
}

describe('wager transaction persistence (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let transactions: WagerTransactionRepository;

  const read = async (id: string) =>
    present(await inFreshContext(orm, () => transactions.findById(id)), 'wager transaction');

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    transactions = app.get(WagerTransactionRepository);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('round-trips a PENDING BET with 0.10 and no optional fields', async () => {
    const bet = newTransaction({ kind: WagerTransactionKind.Bet, amount: '0.10' });

    await inTransaction(orm, () => transactions.insert(bet));
    const stored = await read(bet.id);

    expect(view(stored)).toEqual(view(bet));
    expect(stored.status).toBe(WagerTransactionStatus.Pending);
    expect(stored.money.toJSON()).toEqual({ amount: '0.10', currency: 'BRL' });
    expect(stored.referenceExternalTransactionId).toBeUndefined();
    expect(stored.referenceTransactionId).toBeUndefined();
    expect(stored.failureCode).toBeUndefined();
    expect(stored.balanceAfter).toBeUndefined();
    expect(stored.processedAt).toBeUndefined();
  });

  it('updates a PENDING BET to PROCESSED with the exact observed balance', async () => {
    const bet = newTransaction({ kind: WagerTransactionKind.Bet, amount: '0.10' });
    await inTransaction(orm, () => transactions.insert(bet));

    bet.markProcessed({ at: PROCESSED_AT, balanceAfter: brl('99999999.99') });
    await inTransaction(orm, () => transactions.update(bet));
    const stored = await read(bet.id);

    expect(stored.status).toBe(WagerTransactionStatus.Processed);
    expect(stored.processedAt?.getTime()).toBe(PROCESSED_AT.getTime());
    expect(stored.balanceAfter?.toJSON()).toEqual({ amount: '99999999.99', currency: 'BRL' });
    expect(view(stored)).toEqual(view(bet));
  });

  it('persists a REJECTED BET with its failure code and no balance', async () => {
    const bet = newTransaction({ kind: WagerTransactionKind.Bet, amount: '10.00' });
    bet.reject(FailureCode.WalletNotFound, null);

    await inTransaction(orm, () => transactions.insert(bet));
    const stored = await read(bet.id);

    expect(stored.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored.failureCode).toBe(FailureCode.WalletNotFound);
    expect(stored.balanceAfter).toBeUndefined();
    expect(view(stored)).toEqual(view(bet));
  });

  it('persists a PROCESSED LOSS with amount 0.00', async () => {
    const loss = newTransaction({ kind: WagerTransactionKind.Loss, amount: '0.00' });
    loss.markProcessed({ at: PROCESSED_AT, balanceAfter: brl('50.00') });

    await inTransaction(orm, () => transactions.insert(loss));
    const stored = await read(loss.id);

    expect(stored.money.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(view(stored)).toEqual(view(loss));
  });

  it('persists the largest amount and a resolved ROLLBACK reference', async () => {
    const max = '9999999999999999.99';
    const walletId = Bun.randomUUIDv7();
    const bet = newTransaction({ kind: WagerTransactionKind.Bet, amount: max, walletId });
    bet.markProcessed({ at: PROCESSED_AT, balanceAfter: brl(max) });
    const rollback = newTransaction({
      kind: WagerTransactionKind.Rollback,
      amount: max,
      walletId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    rollback.markProcessed({
      at: PROCESSED_AT,
      balanceAfter: brl(max),
      referenceTransactionId: bet.id,
    });

    await inTransaction(orm, async () => {
      await transactions.insert(bet);
      await transactions.insert(rollback);
    });
    const storedBet = await read(bet.id);
    const storedRollback = await read(rollback.id);

    expect(storedBet.money.toJSON()).toEqual({ amount: max, currency: 'BRL' });
    expect(storedBet.balanceAfter?.toJSON()).toEqual({ amount: max, currency: 'BRL' });
    expect(storedRollback.kind).toBe(WagerTransactionKind.Rollback);
    expect(storedRollback.referenceExternalTransactionId).toBe(bet.externalTransactionId);
    expect(storedRollback.referenceTransactionId).toBe(bet.id);
    expect(view(storedRollback)).toEqual(view(rollback));
  });

  it('returns null for an id that does not exist', async () => {
    expect(await inFreshContext(orm, () => transactions.findById(Bun.randomUUIDv7()))).toBeNull();
  });

  it('rejects an update of a transaction that was never inserted', async () => {
    const bet = newTransaction({ kind: WagerTransactionKind.Bet, amount: '1.00' });
    bet.markProcessed({ at: PROCESSED_AT, balanceAfter: brl('1.00') });

    await expect(inTransaction(orm, () => transactions.update(bet))).rejects.toThrow(
      'not found for update',
    );
  });

  it('refuses to write outside em.transactional()', async () => {
    const bet = newTransaction({ kind: WagerTransactionKind.Bet, amount: '1.00' });

    await expect(inFreshContext(orm, () => transactions.insert(bet))).rejects.toThrow(
      'must run inside em.transactional()',
    );
    await expect(inFreshContext(orm, () => transactions.update(bet))).rejects.toThrow(
      'must run inside em.transactional()',
    );
  });
});
