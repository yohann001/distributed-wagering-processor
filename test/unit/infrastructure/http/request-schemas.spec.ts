import { describe, expect, it } from 'bun:test';

import { z } from 'zod';

import { InvalidRequestError } from '../../../../src/infrastructure/http/http-errors';
import {
  ID_MAX_LENGTH,
  idText,
  moneyFrom,
  normalizeId,
  parseRequest,
  providerIdText,
  uuidText,
} from '../../../../src/infrastructure/http/request-schemas';
import { InvalidMoneyError } from '../../../../src/shared/domain/money';

const UPPER_UUID = '0199C1E2-ABCD-7123-8FED-0123456789AB';

describe('normalizeId', () => {
  it('lowercases a UUID', () => {
    expect(normalizeId(UPPER_UUID)).toBe(UPPER_UUID.toLowerCase());
  });

  it('leaves a non-UUID id untouched', () => {
    expect(normalizeId('Round-ABC')).toBe('Round-ABC');
  });
});

describe('idText', () => {
  it('lowercases UUID-shaped ids and keeps other ids as received', () => {
    expect(idText.parse(UPPER_UUID)).toBe(UPPER_UUID.toLowerCase());
    expect(idText.parse('Round-ABC')).toBe('Round-ABC');
  });

  it('accepts an id of exactly the maximum length', () => {
    expect(idText.safeParse('a'.repeat(ID_MAX_LENGTH)).success).toBe(true);
  });

  it.each([
    ['leading space', ' a'],
    ['trailing space', 'a '],
    ['only spaces', '   '],
    ['empty', ''],
    ['control character', 'a\nb'],
    ['too long', 'a'.repeat(ID_MAX_LENGTH + 1)],
  ])('refuses %s', (_name, value) => {
    expect(idText.safeParse(value).success).toBe(false);
  });
});

describe('providerIdText', () => {
  it("refuses ':' because it is the idempotency key separator", () => {
    expect(providerIdText.safeParse('a:b').success).toBe(false);
  });

  it('accepts a plain provider id', () => {
    expect(providerIdText.parse('provider-1')).toBe('provider-1');
  });
});

describe('uuidText', () => {
  it('lowercases a UUID', () => {
    expect(uuidText.parse(UPPER_UUID)).toBe(UPPER_UUID.toLowerCase());
  });

  it('refuses text that is not a UUID', () => {
    expect(uuidText.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('parseRequest', () => {
  it('returns the parsed output', () => {
    expect(parseRequest('params', uuidText, UPPER_UUID)).toBe(UPPER_UUID.toLowerCase());
  });

  it('throws an InvalidRequestError whose issue paths start with the request source', () => {
    const schema = z.object({ money: z.object({ amount: z.string() }) });
    let caught: unknown;
    try {
      parseRequest('body', schema, { money: { amount: 25 } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidRequestError);
    expect((caught as InvalidRequestError).issues.map((issue) => issue.path)).toEqual(['body.money.amount']);
  });
});

describe('moneyFrom', () => {
  it('builds Money from a decimal string', () => {
    expect(moneyFrom({ amount: '25.00', currency: 'BRL' }).toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it.each([
    ['a number amount', { amount: 25, currency: 'BRL' }],
    ['a missing value', undefined],
  ])('throws InvalidMoneyError for %s', (_name, value) => {
    expect(() => moneyFrom(value)).toThrow(InvalidMoneyError);
  });
});
