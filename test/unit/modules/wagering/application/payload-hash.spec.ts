import { createHash } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import {
  defaultIdempotencyKey,
  wagerPayloadHash,
  type WagerPayload,
} from '../../../../../src/modules/wagering/application/payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { Money } from '../../../../../src/shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const CREATED_AT = new Date('2026-10-21T12:00:00.000Z');

const EXPECTED_CANONICAL =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
  '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
  '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

const EXPECTED_HASH = '629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344';

const basePayload = (overrides: Partial<WagerPayload> = {}): WagerPayload => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00'),
  ...overrides,
});

describe('wagerPayloadHash: key order', () => {
  it('gives the same hash for the same payload built with keys in reverse order', () => {
    const reversed: WagerPayload = {
      money: Money.from({ currency: 'BRL', amount: '25.00' }),
      kind: WagerTransactionKind.Bet,
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(wagerPayloadHash(reversed)).toBe(wagerPayloadHash(basePayload()));
  });

  it('is deterministic across calls', () => {
    expect(wagerPayloadHash(basePayload())).toBe(wagerPayloadHash(basePayload()));
  });
});

describe('wagerPayloadHash: business fields', () => {
  const base = wagerPayloadHash(basePayload());

  it.each<[string, Partial<WagerPayload>]>([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['playerId', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'fortune-tiger' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['money.amount', { money: brl('25.01') }],
    ['money.currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['referenceExternalTransactionId (added)', { referenceExternalTransactionId: 'ext-ref' }],
  ])('changes the hash when %s changes', (_field, overrides) => {
    expect(wagerPayloadHash(basePayload(overrides))).not.toBe(base);
  });

  it('changes the hash when the reference changes', () => {
    const first = wagerPayloadHash(basePayload({ referenceExternalTransactionId: 'ext-ref-1' }));
    const second = wagerPayloadHash(basePayload({ referenceExternalTransactionId: 'ext-ref-2' }));
    expect(first).not.toBe(second);
  });

  it('changes the hash when the reference is removed', () => {
    const withReference = wagerPayloadHash(basePayload({ referenceExternalTransactionId: 'ext-ref' }));
    const removed = wagerPayloadHash(basePayload({ referenceExternalTransactionId: undefined }));
    expect(removed).not.toBe(withReference);
  });

  it('does not collapse values moved between adjacent fields', () => {
    const first = wagerPayloadHash(basePayload({ roundId: 'round-9', gameId: '87fortune-chimp' }));
    const second = wagerPayloadHash(basePayload({ roundId: 'round-987', gameId: 'fortune-chimp' }));
    expect(first).not.toBe(second);
  });
});

describe('wagerPayloadHash: transport fields', () => {
  type WiderPayload = WagerPayload & {
    idempotencyKey: string;
    messageId: string;
    type: string;
    occurredAt: string;
    correlationId: string;
    headers: Record<string, string>;
  };

  it('ignores idempotencyKey, messageId, type, occurredAt, correlationId and headers', () => {
    const wider: WiderPayload = {
      ...basePayload(),
      idempotencyKey: 'provider-a:transaction-123',
      messageId: 'msg-123',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      correlationId: 'corr-1',
      headers: { 'idempotency-key': 'custom-key' },
    };
    expect(wagerPayloadHash(wider)).toBe(wagerPayloadHash(basePayload()));
  });

  it('treats an undefined, absent and empty reference as the same payload', () => {
    const absent = wagerPayloadHash(basePayload());
    expect(wagerPayloadHash(basePayload({ referenceExternalTransactionId: undefined }))).toBe(absent);
    expect(wagerPayloadHash(basePayload({ referenceExternalTransactionId: '' }))).toBe(absent);
  });
});

describe('wagerPayloadHash: algorithm', () => {
  it('returns 64 lowercase hex characters', () => {
    expect(wagerPayloadHash(basePayload())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the SHA-256 of the documented canonical string', () => {
    const expected = createHash('sha256').update(EXPECTED_CANONICAL, 'utf8').digest('hex');
    expect(wagerPayloadHash(basePayload())).toBe(expected);
  });

  it('keeps the golden hash for the reference payload', () => {
    expect(wagerPayloadHash(basePayload())).toBe(EXPECTED_HASH);
  });

  it('places a present reference in sorted position in the canonical string', () => {
    const canonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"REFUND",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
      '"providerId":"provider-a","referenceExternalTransactionId":"ext-ref","roundId":"round-987",' +
      '"walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const payload = basePayload({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-ref',
    });
    expect(wagerPayloadHash(payload)).toBe(expected);
  });
});

describe('defaultIdempotencyKey', () => {
  it('joins providerId and externalTransactionId with a colon', () => {
    expect(defaultIdempotencyKey('provider-a', 'transaction-123')).toBe('provider-a:transaction-123');
  });
});

describe('same idempotency key with a divergent payload', () => {
  const transactionFor = (payload: WagerPayload, payloadHash: string): WagerTransaction =>
    WagerTransaction.create({
      ...payload,
      id: 'tx-1',
      idempotencyKey: defaultIdempotencyKey(payload.providerId, payload.externalTransactionId),
      payloadHash,
      createdAt: CREATED_AT,
    });

  it('matches the identical payload and does not match one with another amount', () => {
    const original = basePayload();
    const divergent = basePayload({ money: brl('30.00') });
    const originalHash = wagerPayloadHash(original);
    const divergentHash = wagerPayloadHash(divergent);

    expect(defaultIdempotencyKey(divergent.providerId, divergent.externalTransactionId)).toBe(
      defaultIdempotencyKey(original.providerId, original.externalTransactionId),
    );

    const stored = transactionFor(original, originalHash);
    expect(stored.matchesPayload(originalHash)).toBe(true);
    expect(stored.matchesPayload(divergentHash)).toBe(false);
  });
});
