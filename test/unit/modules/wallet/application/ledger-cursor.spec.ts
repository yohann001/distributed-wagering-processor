import { describe, expect, it } from 'bun:test';

import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../../../../src/modules/wallet/application/ledger-cursor';
import { InvalidQueryError } from '../../../../../src/shared/application/invalid-query-error';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';

const WALLET_ID = '0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER_WALLET_ID = '0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const raw = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const rawText = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const payload = (overrides: Record<string, unknown> = {}): string =>
  raw({ v: 1, w: WALLET_ID, s: '5', ...overrides });

function invalidCursorError(cursor: string, walletId = WALLET_ID): InvalidQueryError {
  let caught: unknown;
  try {
    decodeLedgerCursor(cursor, walletId);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidQueryError);
  return caught as InvalidQueryError;
}

describe('ledger cursor', () => {
  it('round-trips the position bound to the wallet', () => {
    const cursor = encodeLedgerCursor(WALLET_ID, '9007199254740993');

    expect(decodeLedgerCursor(cursor, WALLET_ID)).toBe('9007199254740993');
  });

  it('is URL-safe and opaque', () => {
    const cursor = encodeLedgerCursor(WALLET_ID, '42');

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(WALLET_ID);
  });

  it('accepts the biggest bigint position', () => {
    expect(decodeLedgerCursor(payload({ s: '9223372036854775807' }), WALLET_ID)).toBe('9223372036854775807');
  });

  it('accepts a wallet id that differs only by case', () => {
    expect(decodeLedgerCursor(payload({ w: WALLET_ID.toUpperCase() }), WALLET_ID)).toBe('5');
  });

  describe('invalid cursors', () => {
    const cases: [string, string][] = [
      ['empty', ''],
      ['not base64url', '%%%'],
      ['not JSON', rawText('not json')],
      ['a JSON array', rawText('[]')],
      ['a JSON string', rawText('"x"')],
      ['JSON null', rawText('null')],
      ['an unsupported version', payload({ v: 2 })],
      ['a missing version', raw({ w: WALLET_ID, s: '5' })],
      ['another wallet', payload({ w: OTHER_WALLET_ID })],
      ['a non-string wallet', payload({ w: 7 })],
      ['seq zero', payload({ s: '0' })],
      ['a negative seq', payload({ s: '-1' })],
      ['seq with a leading zero', payload({ s: '01' })],
      ['a numeric seq', payload({ s: 5 })],
      ['a missing seq', raw({ v: 1, w: WALLET_ID })],
      ['seq beyond 19 digits', payload({ s: '1'.repeat(20) })],
      ['seq beyond the bigint range', payload({ s: '9223372036854775808' })],
      ['a 600-char string', 'A'.repeat(600)],
    ];

    for (const [name, cursor] of cases) {
      it(`rejects ${name} as INVALID_PAYLOAD`, () => {
        const error = invalidCursorError(cursor);

        expect(error.code).toBe(FailureCode.InvalidPayload);
        expect(error.field).toBe('cursor');
      });
    }

    it('does not echo the cursor or the wallet in the message', () => {
      const error = invalidCursorError(payload({ w: OTHER_WALLET_ID }));

      expect(error.message).not.toContain(OTHER_WALLET_ID);
      expect(error.message).not.toContain(WALLET_ID);
    });
  });
});
