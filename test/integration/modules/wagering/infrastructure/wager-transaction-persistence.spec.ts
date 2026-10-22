import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { WagerTransactionRepository } from '../../../../../src/modules/wagering/application/wager-transaction-repository';
import {
  WagerTransaction,
  WagerTransactionAlreadyExistsError,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import {
  WAGER_TRANSACTION_EXTERNAL_ID_CONSTRAINT,
  WAGER_TRANSACTION_IDEMPOTENCY_CONSTRAINT,
} from '../../../../../src/modules/wagering/infrastructure/persistence/mikro-orm-wager-transaction-repository';
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
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  referenceExternalTransactionId?: string;
}

function newTransaction(options: NewTransactionOptions): WagerTransaction {
  const id = Bun.randomUUIDv7();
  return WagerTransaction.create({
    id,
    providerId: options.providerId ?? `provider-${id}`,
    externalTransactionId: options.externalTransactionId ?? `ext-${id}`,
    idempotencyKey: options.idempotencyKey ?? `idem-${id}`,
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

/** Estado completo de `tx`, para reidratar uma variante que o domínio não alcança por transições (ex.: REJECTED com referência). */
function stateOf(tx: WagerTransaction): WagerTransactionState {
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
    money: tx.money,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    createdAt: tx.createdAt,
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt,
    balanceAfter: tx.balanceAfter,
  };
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

  describe('lookups by natural key', () => {
    it('finds a transaction by idempotency key, and misses for an unknown key or the same key under another provider', async () => {
      const bet = newTransaction({ kind: WagerTransactionKind.Bet, amount: '10.00' });
      await inTransaction(orm, () => transactions.insert(bet));

      const hit = present(
        await inFreshContext(orm, () => transactions.findByIdempotencyKey(bet.providerId, bet.idempotencyKey)),
        'transaction by idempotency key',
      );
      expect(view(hit)).toEqual(view(bet));
      expect(
        await inFreshContext(orm, () => transactions.findByIdempotencyKey(bet.providerId, 'unknown-key')),
      ).toBeNull();
      expect(
        await inFreshContext(orm, () =>
          transactions.findByIdempotencyKey(`other-${bet.providerId}`, bet.idempotencyKey),
        ),
      ).toBeNull();
    });

    it('finds a transaction by external id, and misses for an unknown id or another provider', async () => {
      const bet = newTransaction({ kind: WagerTransactionKind.Bet, amount: '10.00' });
      await inTransaction(orm, () => transactions.insert(bet));

      const hit = present(
        await inFreshContext(orm, () => transactions.findByExternalId(bet.providerId, bet.externalTransactionId)),
        'transaction by external id',
      );
      expect(view(hit)).toEqual(view(bet));
      expect(await inFreshContext(orm, () => transactions.findByExternalId(bet.providerId, 'unknown-id'))).toBeNull();
      expect(
        await inFreshContext(orm, () =>
          transactions.findByExternalId(`other-${bet.providerId}`, bet.externalTransactionId),
        ),
      ).toBeNull();
    });

    it('returns only the PROCESSED REFUND/ROLLBACK that point to the transaction', async () => {
      const walletId = Bun.randomUUIDv7();
      const providerId = `provider-${Bun.randomUUIDv7()}`;
      const bet = newTransaction({ kind: WagerTransactionKind.Bet, amount: '10.00', walletId, providerId });
      bet.markProcessed({ at: PROCESSED_AT, balanceAfter: brl('90.00') });
      const win = newTransaction({
        kind: WagerTransactionKind.Win,
        amount: '10.00',
        walletId,
        providerId,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      win.markProcessed({ at: PROCESSED_AT, balanceAfter: brl('100.00'), referenceTransactionId: bet.id });
      const rejectedRefund = WagerTransaction.rehydrate({
        ...stateOf(
          newTransaction({
            kind: WagerTransactionKind.Refund,
            amount: '10.00',
            walletId,
            providerId,
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
        status: WagerTransactionStatus.Rejected,
        referenceTransactionId: bet.id,
        failureCode: FailureCode.AlreadyReversed,
        balanceAfter: brl('90.00'),
      });
      const rollback = newTransaction({
        kind: WagerTransactionKind.Rollback,
        amount: '10.00',
        walletId,
        providerId,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      rollback.markProcessed({ at: PROCESSED_AT, balanceAfter: brl('100.00'), referenceTransactionId: bet.id });
      const unrelated = newTransaction({ kind: WagerTransactionKind.Bet, amount: '5.00', walletId, providerId });

      await inTransaction(orm, async () => {
        await transactions.insert(bet);
        await transactions.insert(win);
        await transactions.insert(rejectedRefund);
        await transactions.insert(rollback);
        await transactions.insert(unrelated);
      });

      const reversals = await inFreshContext(orm, () => transactions.findProcessedReversalsOf(bet.id));
      expect(reversals.map((tx) => tx.id)).toEqual([rollback.id]);
      expect(await inFreshContext(orm, () => transactions.findProcessedReversalsOf(Bun.randomUUIDv7()))).toEqual([]);
    });
  });

  describe('duplicate keys', () => {
    it('translates a repeated idempotency key into WagerTransactionAlreadyExistsError', async () => {
      const first = newTransaction({ kind: WagerTransactionKind.Bet, amount: '10.00' });
      await inTransaction(orm, () => transactions.insert(first));
      const second = newTransaction({
        kind: WagerTransactionKind.Bet,
        amount: '10.00',
        providerId: first.providerId,
        idempotencyKey: first.idempotencyKey,
      });

      const error = await inTransaction(orm, () => transactions.insert(second)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WagerTransactionAlreadyExistsError);
      expect((error as WagerTransactionAlreadyExistsError).constraint).toBe(WAGER_TRANSACTION_IDEMPOTENCY_CONSTRAINT);
      expect((error as WagerTransactionAlreadyExistsError).code).toBe(FailureCode.TransientFailure);
      expect(await inFreshContext(orm, () => transactions.findById(second.id))).toBeNull();
    });

    it('translates a repeated external id into WagerTransactionAlreadyExistsError', async () => {
      const first = newTransaction({ kind: WagerTransactionKind.Bet, amount: '10.00' });
      await inTransaction(orm, () => transactions.insert(first));
      const second = newTransaction({
        kind: WagerTransactionKind.Bet,
        amount: '10.00',
        providerId: first.providerId,
        externalTransactionId: first.externalTransactionId,
      });

      const error = await inTransaction(orm, () => transactions.insert(second)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WagerTransactionAlreadyExistsError);
      expect((error as WagerTransactionAlreadyExistsError).constraint).toBe(WAGER_TRANSACTION_EXTERNAL_ID_CONSTRAINT);
    });

    it('lets another provider reuse the same key and external id, and rethrows a repeated primary key raw', async () => {
      const first = newTransaction({ kind: WagerTransactionKind.Bet, amount: '10.00' });
      await inTransaction(orm, () => transactions.insert(first));
      const otherProvider = newTransaction({
        kind: WagerTransactionKind.Bet,
        amount: '10.00',
        providerId: `other-${first.providerId}`,
        externalTransactionId: first.externalTransactionId,
        idempotencyKey: first.idempotencyKey,
      });
      await inTransaction(orm, () => transactions.insert(otherProvider));

      const samePrimaryKey = WagerTransaction.rehydrate({
        ...stateOf(first),
        providerId: `provider-${Bun.randomUUIDv7()}`,
        externalTransactionId: `ext-${Bun.randomUUIDv7()}`,
        idempotencyKey: `idem-${Bun.randomUUIDv7()}`,
      });
      const error = await inTransaction(orm, () => transactions.insert(samePrimaryKey)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UniqueConstraintViolationException);
      expect((error as { constraint?: unknown }).constraint).toBe('wager_transactions_pkey');
    });
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
