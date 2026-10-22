import { describe, expect, it } from 'bun:test';

import {
  InvalidEnvelopeError,
  parseWagerTransactionEnvelope,
} from '../../../../../../src/modules/messaging/infrastructure/sqs/wager-transaction-envelope';
import { KindNotAllowedError, WagerTransactionKind } from '../../../../../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../../../../../src/shared/domain/failure-code';
import { InvalidMoneyError } from '../../../../../../src/shared/domain/money';

const WALLET_ID = '0199c1e2-abcd-7123-8fed-0123456789ab';
const MESSAGE_ID = '0199c1e2-0000-7123-8fed-0123456789ab';

function data(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'provider-1',
    externalTransactionId: 'bet-1',
    playerId: 'player-1',
    walletId: WALLET_ID,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: MESSAGE_ID,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-22T10:00:00.000Z',
    data: data(),
    ...overrides,
  };
}

function parse(value: unknown) {
  return parseWagerTransactionEnvelope(JSON.stringify(value));
}

function invalidEnvelope(body: string | undefined): InvalidEnvelopeError {
  try {
    parseWagerTransactionEnvelope(body);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidEnvelopeError);
    return error as InvalidEnvelopeError;
  }
  throw new Error('expected the envelope to be refused');
}

function paths(error: InvalidEnvelopeError): string[] {
  return error.issues.map((issue) => issue.path);
}

describe('parseWagerTransactionEnvelope', () => {
  it('returns the business fields, the kept idempotencyKey and the envelope metadata', () => {
    const parsed = parse(envelope({ data: data({ idempotencyKey: 'key-from-provider' }) }));

    expect(parsed.messageId).toBe(MESSAGE_ID);
    expect(parsed.occurredAt).toEqual(new Date('2026-10-22T10:00:00.000Z'));
    expect(parsed.idempotencyKey).toBe('key-from-provider');
    expect(parsed.fields.kind).toBe(WagerTransactionKind.Bet);
    expect(parsed.fields.walletId).toBe(WALLET_ID);
    expect(parsed.fields.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(parsed.fields.referenceExternalTransactionId).toBeUndefined();
  });

  it('normalizes UUID ids to lower case, like the HTTP edge', () => {
    const parsed = parse(
      envelope({ data: data({ walletId: WALLET_ID.toUpperCase(), playerId: WALLET_ID.toUpperCase() }) }),
    );

    expect(parsed.fields.walletId).toBe(WALLET_ID);
    expect(parsed.fields.playerId).toBe(WALLET_ID);
  });

  it('falls back to providerId:externalTransactionId when the envelope has no idempotencyKey', () => {
    expect(parse(envelope()).idempotencyKey).toBe('provider-1:bet-1');
  });

  it('builds the fallback key from the normalized ids', () => {
    const upper = WALLET_ID.toUpperCase();

    expect(parse(envelope({ data: data({ externalTransactionId: upper }) })).idempotencyKey).toBe(
      `provider-1:${WALLET_ID}`,
    );
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['an empty body', ''],
    ['a body that is undefined', undefined],
  ])('refuses %s at the body path', (_name, body) => {
    const error = invalidEnvelope(body);

    expect(paths(error)).toEqual(['body']);
    expect(error.code).toBe(FailureCode.InvalidPayload);
  });

  it.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['null', 'null'],
  ])('refuses %s', (_name, body) => {
    expect(invalidEnvelope(body)).toBeInstanceOf(InvalidEnvelopeError);
  });

  it('refuses a type other than WagerTransactionRequested', () => {
    expect(paths(invalidEnvelope(JSON.stringify(envelope({ type: 'Other' }))))).toEqual(['type']);
  });

  it('refuses a missing messageId', () => {
    const { messageId: _omitted, ...withoutMessageId } = envelope();

    expect(paths(invalidEnvelope(JSON.stringify(withoutMessageId)))).toEqual(['messageId']);
  });

  it('refuses an occurredAt that is not an ISO datetime', () => {
    expect(paths(invalidEnvelope(JSON.stringify(envelope({ occurredAt: 'yesterday' }))))).toEqual(['occurredAt']);
  });

  it('refuses a missing data', () => {
    const { data: _omitted, ...withoutData } = envelope();

    expect(paths(invalidEnvelope(JSON.stringify(withoutData)))).toEqual(['data']);
  });

  it('refuses a providerId with a colon, which could collide with another default idempotency key', () => {
    expect(paths(invalidEnvelope(JSON.stringify(envelope({ data: data({ providerId: 'a:b' }) }))))).toEqual([
      'data.providerId',
    ]);
  });

  it('refuses a walletId that is not a UUID', () => {
    expect(paths(invalidEnvelope(JSON.stringify(envelope({ data: data({ walletId: 'wallet-1' }) }))))).toEqual([
      'data.walletId',
    ]);
  });

  it('refuses an idempotencyKey outside 1-255 visible ASCII characters', () => {
    expect(paths(invalidEnvelope(JSON.stringify(envelope({ data: data({ idempotencyKey: 'a b' }) }))))).toEqual([
      'data.idempotencyKey',
    ]);
  });

  it('refuses a transaction that references itself', () => {
    const error = invalidEnvelope(
      JSON.stringify(envelope({ data: data({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }) })),
    );

    expect(paths(error)).toEqual(['data.referenceExternalTransactionId']);
  });

  it('reports the problems of the envelope and of the data together', () => {
    const error = invalidEnvelope(
      JSON.stringify(envelope({ type: 'Other', data: data({ providerId: 'a:b' }) })),
    );

    expect(paths(error).sort()).toEqual(['data.providerId', 'type']);
  });

  it('refuses the internal OPENING kind with KIND_NOT_ALLOWED', () => {
    expect(() => parse(envelope({ data: data({ kind: 'OPENING' }) }))).toThrow(KindNotAllowedError);
  });

  it('refuses an amount sent as a number with INVALID_MONEY', () => {
    expect(() => parse(envelope({ data: data({ money: { amount: 25, currency: 'BRL' } }) }))).toThrow(
      InvalidMoneyError,
    );
  });

  it('never puts a received value in the error message', () => {
    const error = invalidEnvelope(
      JSON.stringify(
        envelope({ type: 'secret-type', data: data({ providerId: 'secret:provider', money: { amount: '987.65' } }) }),
      ),
    );

    expect(error.message).not.toContain('secret');
    expect(error.message).not.toContain('987.65');
    expect(error.message).toContain('type');
    expect(error.message).toContain('data.providerId');
  });
});
