import { describe, expect, it } from 'bun:test';

import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
  type LedgerEntryState,
} from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { DomainError } from '../../../../../src/shared/domain/domain-error';
import { FailureAction, FailureCode } from '../../../../../src/shared/domain/failure-code';
import { Money } from '../../../../../src/shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const CREATED_AT = new Date('2026-10-21T12:00:00.000Z');

const debit = (overrides: Partial<LedgerEntryState> = {}): LedgerEntryState => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  createdAt: CREATED_AT,
  ...overrides,
});

const credit = (overrides: Partial<LedgerEntryState> = {}): LedgerEntryState =>
  debit({
    direction: LedgerDirection.Credit,
    money: brl('25.00'),
    balanceBefore: brl('20.00'),
    balanceAfter: brl('45.00'),
    ...overrides,
  });

describe('WalletLedgerEntry.create: valid entries', () => {
  it('creates a DEBIT that subtracts money from the balance', () => {
    const entry = WalletLedgerEntry.create(debit());

    expect(entry.id).toBe('entry-1');
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-1');
    expect<string>(entry.direction).toBe('DEBIT');
    expect(entry.money.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(entry.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(entry.createdAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates a CREDIT that adds money to the balance', () => {
    const entry = WalletLedgerEntry.create(credit());

    expect<string>(entry.direction).toBe('CREDIT');
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '45.00', currency: 'BRL' });
    expect(entry.isBalanced()).toBe(true);
  });

  it('accepts a DEBIT that brings the balance exactly to zero', () => {
    const entry = WalletLedgerEntry.create(debit({ money: brl('100.00'), balanceAfter: brl('0.00') }));
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  it('accepts a CREDIT starting from zero', () => {
    const entry = WalletLedgerEntry.create(
      credit({ money: brl('0.10'), balanceBefore: brl('0.00'), balanceAfter: brl('0.10') }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  it('keeps exact cents on large values', () => {
    const entry = WalletLedgerEntry.create(
      credit({
        money: brl('0.01'),
        balanceBefore: brl('99999999.99'),
        balanceAfter: brl('100000000.00'),
      }),
    );
    expect(entry.balanceAfter.toJSON().amount).toBe('100000000.00');
  });
});

describe('WalletLedgerEntry.create: unbalanced entries', () => {
  it.each([
    ['DEBIT with wrong balanceAfter', debit({ balanceAfter: brl('20.01') })],
    ['CREDIT with wrong balanceAfter', credit({ balanceAfter: brl('44.99') })],
    // conta do crédito num lançamento de débito: 20 + 25 = 45, mas DEBIT exige 20 - 25
    ['DEBIT computed as a credit', credit({ direction: LedgerDirection.Debit })],
    ['CREDIT computed as a debit', debit({ direction: LedgerDirection.Credit })],
    ['unchanged balance', debit({ balanceAfter: brl('100.00') })],
  ])('rejects %s', (_label, props) => {
    expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry.create: mixed currencies', () => {
  it.each([
    ['money', debit({ money: usd('80.00') })],
    ['balanceBefore', debit({ balanceBefore: usd('100.00') })],
    ['balanceAfter', debit({ balanceAfter: usd('20.00') })],
  ])('rejects %s in another currency', (_label, props) => {
    expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
  });

  it('accepts an entry fully in another currency', () => {
    const entry = WalletLedgerEntry.create(
      debit({ money: usd('80.00'), balanceBefore: usd('100.00'), balanceAfter: usd('20.00') }),
    );
    expect(entry.money.currency).toBe('USD');
  });
});

describe('WalletLedgerEntry.create: other invariants', () => {
  it('rejects zero money', () => {
    expect(() =>
      WalletLedgerEntry.create(debit({ money: brl('0.00'), balanceAfter: brl('100.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects negative money', () => {
    const negative = brl('10.00').negate();
    expect(() =>
      WalletLedgerEntry.create(credit({ money: negative, balanceAfter: brl('10.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects a DEBIT that would leave the balance negative', () => {
    const negative = brl('100.00').subtract(brl('120.00'));
    expect(() =>
      WalletLedgerEntry.create(debit({ money: brl('120.00'), balanceAfter: negative })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects a negative balanceBefore', () => {
    const negative = brl('0.00').subtract(brl('5.00'));
    expect(() =>
      WalletLedgerEntry.create(
        credit({ money: brl('10.00'), balanceBefore: negative, balanceAfter: brl('5.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects an unknown direction', () => {
    expect(() =>
      WalletLedgerEntry.create(debit({ direction: 'TRANSFER' as LedgerDirection })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects an invalid date', () => {
    expect(() => WalletLedgerEntry.create(debit({ createdAt: new Date('nope') }))).toThrow(
      InvalidLedgerEntryError,
    );
  });
});

describe('WalletLedgerEntry: immutability', () => {
  it('is frozen: fields cannot be reassigned', () => {
    const entry = WalletLedgerEntry.create(debit());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow(TypeError);
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
  });

  it('has no transition methods', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual(['createdAt', 'isBalanced']);
  });

  it('is not affected by mutating the Date passed in', () => {
    const createdAt = new Date(CREATED_AT.getTime());
    const entry = WalletLedgerEntry.create(debit({ createdAt }));
    createdAt.setUTCFullYear(2000);
    expect(entry.createdAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
  });

  it('is not affected by mutating the Date it returns', () => {
    const entry = WalletLedgerEntry.create(debit());
    entry.createdAt.setUTCFullYear(2000);
    expect(entry.createdAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('rebuilds a persisted entry with the same data', () => {
    const entry = WalletLedgerEntry.rehydrate(debit());
    expect(entry.id).toBe('entry-1');
    expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('does not revalidate: an unbalanced state is rebuilt and isBalanced reports false', () => {
    const entry = WalletLedgerEntry.rehydrate(debit({ balanceAfter: brl('20.01') }));
    expect(entry.isBalanced()).toBe(false);
  });

  it('does not revalidate mixed currencies, and isBalanced returns false without throwing', () => {
    const entry = WalletLedgerEntry.rehydrate(debit({ balanceAfter: usd('20.00') }));
    expect(entry.isBalanced()).toBe(false);
  });

  it('does not revalidate zero money', () => {
    const entry = WalletLedgerEntry.rehydrate(
      debit({ money: brl('0.00'), balanceAfter: brl('100.00') }),
    );
    expect(entry.money.isZero()).toBe(true);
  });

  it('reports an unknown direction as unbalanced', () => {
    const entry = WalletLedgerEntry.rehydrate(debit({ direction: 'TRANSFER' as LedgerDirection }));
    expect(entry.isBalanced()).toBe(false);
  });
});

describe('InvalidLedgerEntryError', () => {
  it('is an invariant violation that must not be retried', () => {
    const error = new InvalidLedgerEntryError('x');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('InvalidLedgerEntryError');
    expect(error.code).toBe(FailureCode.InvariantViolation);
    expect(error.action).toBe(FailureAction.GiveUp);
  });
});
