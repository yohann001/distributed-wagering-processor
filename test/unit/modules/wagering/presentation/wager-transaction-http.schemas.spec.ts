import { describe, expect, it } from 'bun:test';

import {
  KindNotAllowedError,
  WagerTransactionStatus,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import {
  httpStatusForTransaction,
  idempotencyKeyHeaders,
  toSubmitCommandFields,
  wagerTransactionPayloadSchema,
} from '../../../../../src/modules/wagering/presentation/wager-transaction-http.schemas';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'provider-1',
    externalTransactionId: 'refund-1',
    playerId: 'player-1',
    walletId: '0199c1e2-abcd-7123-8fed-0123456789ab',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'REFUND',
    money: { amount: '10.00', currency: 'BRL' },
    referenceExternalTransactionId: 'bet-1',
    ...overrides,
  };
}

describe('wagerTransactionPayloadSchema', () => {
  it('accepts a reversal that references another transaction', () => {
    expect(wagerTransactionPayloadSchema.safeParse(payload()).success).toBe(true);
  });

  it('refuses a transaction that references itself, which could never leave PENDING_REFERENCE', () => {
    const parsed = wagerTransactionPayloadSchema.safeParse(payload({ referenceExternalTransactionId: 'refund-1' }));

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['referenceExternalTransactionId']);
  });

  it('compares the self-reference after normalization (UUID case)', () => {
    const id = '0199C1E2-ABCD-7123-8FED-0123456789AB';

    const parsed = wagerTransactionPayloadSchema.safeParse(
      payload({ externalTransactionId: id, referenceExternalTransactionId: id.toLowerCase() }),
    );

    expect(parsed.success).toBe(false);
  });

  it('does not list the internal OPENING kind among the expected values of an unknown kind', () => {
    const parsed = wagerTransactionPayloadSchema.safeParse(payload({ kind: 'FOO' }));

    expect(parsed.success).toBe(false);
    const message = parsed.error?.issues[0]?.message ?? '';
    expect(message).toContain('BET');
    expect(message).not.toContain('OPENING');
  });

  it('still parses OPENING so the submission refuses it with KIND_NOT_ALLOWED', () => {
    const parsed = wagerTransactionPayloadSchema.parse(
      payload({ kind: 'OPENING', referenceExternalTransactionId: undefined }),
    );

    expect(() => toSubmitCommandFields(parsed)).toThrow(KindNotAllowedError);
  });

  it('treats an explicit null reference like an omitted one', () => {
    const omitted = wagerTransactionPayloadSchema.parse(payload({ kind: 'BET', referenceExternalTransactionId: undefined }));
    const nulled = wagerTransactionPayloadSchema.parse(payload({ kind: 'BET', referenceExternalTransactionId: null }));

    expect(nulled).toEqual(omitted);
    expect(nulled.referenceExternalTransactionId).toBeUndefined();
  });
});

describe('idempotencyKeyHeaders', () => {
  it('accepts 255 visible ASCII characters', () => {
    expect(idempotencyKeyHeaders.safeParse({ 'idempotency-key': 'a'.repeat(255) }).success).toBe(true);
  });

  it.each([
    ['256 characters', 'a'.repeat(256)],
    ['empty', ''],
    ['an inner space', 'a b'],
    ['a tab', 'a\tb'],
    ['a non-ASCII character', 'chave-ç'],
  ])('refuses %s', (_name, value) => {
    expect(idempotencyKeyHeaders.safeParse({ 'idempotency-key': value }).success).toBe(false);
  });
});

describe('httpStatusForTransaction', () => {
  it.each([
    [WagerTransactionStatus.Processed, 200],
    [WagerTransactionStatus.PendingReference, 202],
    [WagerTransactionStatus.Rejected, 422],
    [WagerTransactionStatus.Failed, 500],
  ])('maps %s to %i', (status, httpStatus) => {
    expect(httpStatusForTransaction(status)).toBe(httpStatus);
  });

  it('treats PENDING as a programming error: the submission never returns it', () => {
    expect(() => httpStatusForTransaction(WagerTransactionStatus.Pending)).toThrow();
  });
});
