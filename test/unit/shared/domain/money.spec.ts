import { describe, expect, it } from 'bun:test';

import { DomainError } from '../../../../src/shared/domain/domain-error';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from '../../../../src/shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

describe('Money.from: valid inputs', () => {
  it.each(['0.00', '0.10', '25.00', '1000.00', '12345678901234567890123.45'])(
    'round-trips %s through toJSON',
    (amount) => {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
    },
  );

  it('formats toString as "<amount> <currency>"', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });

  it('serializes with JSON.stringify', () => {
    expect(JSON.stringify(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
  });
});

describe('Money.from: invalid amounts', () => {
  it.each([
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '2.5E-1',
    '',
    '   ',
    // mais de 2 casas: rejeitado, nunca arredondado
    '10.005',
    '-25.00',
    '25',
    '25.5',
    '.50',
    '25.',
    '+25.00',
    '0025.00',
    ' 25.00',
    '25,00',
    '1_000.00',
    '0x1A',
  ])('rejects %p', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects a non-string amount at runtime', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it('rejects null and undefined amounts', () => {
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.from({ amount: undefined as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it('rejects a null or non-object props', () => {
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(
      InvalidMoneyError,
    );
  });
});

describe('Money: invalid currency', () => {
  it.each(['', 'brl', 'BR', 'BRLX', 'R$'])('rejects currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  it('rejects a non-string currency', () => {
    expect(() => Money.from({ amount: '1.00', currency: 123 as unknown as string })).toThrow(
      InvalidMoneyError,
    );
  });

  it('rejects an invalid currency in Money.zero', () => {
    expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
  });
});

describe('Money: arithmetic', () => {
  it('adds exactly: 0.10 + 0.20 equals 0.30', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  it('subtracts: 100.00 - 80.00 = 20.00', () => {
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
  });

  it('goes negative: 20.00 - 80.00 = -60.00', () => {
    const result = brl('20.00').subtract(brl('80.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-60.00');
  });

  it('negates a positive value', () => {
    expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
  });

  it('negating zero stays zero, not negative', () => {
    const result = brl('0.00').negate();
    expect(result.isZero()).toBe(true);
    expect(result.isNegative()).toBe(false);
    expect(result.toJSON().amount).toBe('0.00');
  });

  it('subtracting to zero is not negative', () => {
    const result = brl('5.00').subtract(brl('5.00'));
    expect(result.isZero()).toBe(true);
    expect(result.toJSON().amount).toBe('0.00');
  });

  it('keeps large values exact', () => {
    const result = brl('12345678901234567890123.45').add(brl('0.01'));
    expect(result.toJSON().amount).toBe('12345678901234567890123.46');
  });
});

describe('Money: immutability', () => {
  it('returns new instances and leaves operands unchanged', () => {
    const a = brl('10.00');
    const b = brl('2.50');
    const aBefore = a.toJSON();
    const bBefore = b.toJSON();

    const sum = a.add(b);
    const diff = a.subtract(b);
    const neg = a.negate();

    expect(sum).not.toBe(a);
    expect(sum).not.toBe(b);
    expect(diff).not.toBe(a);
    expect(neg).not.toBe(a);
    expect(a.toJSON()).toEqual(aBefore);
    expect(b.toJSON()).toEqual(bBefore);
  });

  it('freezes the instance', () => {
    expect(Object.isFrozen(brl('1.00'))).toBe(true);
    expect(Object.isFrozen(Money.zero('BRL'))).toBe(true);
  });
});

describe('Money: predicates', () => {
  const positive = brl('10.00');
  const zero = Money.zero('BRL');
  const negative = brl('10.00').negate();

  it('Money.zero builds a zero with the given currency', () => {
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('isZero', () => {
    expect(zero.isZero()).toBe(true);
    expect(positive.isZero()).toBe(false);
    expect(negative.isZero()).toBe(false);
  });

  it('isPositive', () => {
    expect(positive.isPositive()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(negative.isPositive()).toBe(false);
  });

  it('isNegative', () => {
    expect(negative.isNegative()).toBe(true);
    expect(zero.isNegative()).toBe(false);
    expect(positive.isNegative()).toBe(false);
  });

  it('isLessThan in both directions and for equal values', () => {
    expect(negative.isLessThan(zero)).toBe(true);
    expect(zero.isLessThan(positive)).toBe(true);
    expect(positive.isLessThan(zero)).toBe(false);
    expect(positive.isLessThan(brl('10.00'))).toBe(false);
  });

  it('equals compares amount and currency without throwing', () => {
    expect(brl('10.00').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(brl('10.01'))).toBe(false);
    expect(brl('10.00').equals(usd('10.00'))).toBe(false);
  });
});

describe('Money: currency conflict', () => {
  it.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ] as const)('%s between BRL and USD throws CurrencyMismatchError', (_name, operation) => {
    expect(() => operation(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  it('exposes the domain error code', () => {
    let caught: unknown;
    try {
      brl('1.00').add(usd('1.00'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CurrencyMismatchError);
    expect(caught).toBeInstanceOf(DomainError);
    expect<string>((caught as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
  });
});
