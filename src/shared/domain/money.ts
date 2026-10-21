import Decimal from 'decimal.js';

import { DomainError } from './domain-error';

/** Precisão alta para que somas de valores grandes nunca arredondem (o padrão são 20 dígitos). */
const MoneyDecimal = Decimal.clone({ precision: 64, rounding: Decimal.ROUND_HALF_EVEN });

const SCALE = 2;
const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parser estrito do contrato de entrada: string decimal canônica, não negativa, com exatamente 2 casas. */
  static from(props: MoneyProps): Money {
    if (typeof props !== 'object' || props === null) {
      throw new InvalidMoneyError('money must be an object with amount and currency');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    Money.assertCurrency(currency);
    // A regex roda antes do Decimal, que aceitaria "1e3", "NaN", "Infinity" e "0x1A".
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with exactly 2 decimal places',
      );
    }
    return Money.of(new MoneyDecimal(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return Money.of(new MoneyDecimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  /** Único ponto de construção: normaliza o zero negativo (-0) para zero. */
  private static of(value: Decimal, currency: string): Money {
    const normalized = value.isZero() ? new MoneyDecimal(0) : value;
    return new Money(normalized, currency);
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string') {
      throw new InvalidMoneyError('currency must be a string');
    }
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code (3 uppercase letters)');
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
