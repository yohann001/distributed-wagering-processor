import { describe, expect, it } from 'bun:test';

import {
  InsufficientFundsError,
  InvalidWalletOpeningError,
  Wallet,
  type WalletState,
} from '../../../../../src/modules/wallet/domain/wallet';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  type WalletLedgerEntry,
} from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { DomainError } from '../../../../../src/shared/domain/domain-error';
import { FailureAction, FailureCode } from '../../../../../src/shared/domain/failure-code';
import { CurrencyMismatchError, Money } from '../../../../../src/shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const OPENED_AT = new Date('2026-10-21T12:00:00.000Z');
const LATER = new Date('2026-10-21T12:05:00.000Z');

const OPENING = { transactionId: 'tx-opening', ledgerEntryId: 'entry-opening' };

const openWith = (amount: string): { wallet: Wallet; openingEntry: WalletLedgerEntry | null } =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    openedAt: OPENED_AT,
    ...(amount === '0.00' ? {} : { opening: OPENING }),
  });

const movement = (amount: string, n = 1) => ({
  money: brl(amount),
  transactionId: `tx-${n}`,
  ledgerEntryId: `entry-${n}`,
  at: LATER,
});

/** saldo reconstruído pelo ledger (§13): soma dos créditos menos os débitos, a partir de zero. */
const replayLedger = (entries: WalletLedgerEntry[], currency = 'BRL'): Money =>
  entries.reduce(
    (balance, entry) =>
      entry.direction === LedgerDirection.Credit
        ? balance.add(entry.money)
        : balance.subtract(entry.money),
    Money.zero(currency),
  );

const snapshot = (wallet: Wallet) => ({
  balance: wallet.balance.toJSON(),
  version: wallet.version,
  updatedAt: wallet.updatedAt.toISOString(),
});

describe('Wallet.open', () => {
  it('opens with zero balance, version 1 and no ledger entry', () => {
    const { wallet, openingEntry } = openWith('0.00');

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt.toISOString()).toBe(OPENED_AT.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(OPENED_AT.toISOString());
    expect(openingEntry).toBeNull();
  });

  it('opens with a positive balance, version 1 and the opening CREDIT', () => {
    const { wallet, openingEntry } = openWith('1000.00');

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(openingEntry).not.toBeNull();
    const entry = openingEntry as WalletLedgerEntry;
    expect(entry.id).toBe('entry-opening');
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-opening');
    expect<string>(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.toJSON().amount).toBe('0.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.createdAt.toISOString()).toBe(OPENED_AT.toISOString());
    expect(replayLedger([entry]).equals(wallet.balance)).toBe(true);
  });

  it('takes the currency from the initial balance', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-usd',
      playerId: 'player-1',
      initialBalance: usd('0.00'),
      openedAt: OPENED_AT,
    });
    expect(wallet.currency).toBe('USD');
  });

  it('rejects a positive initial balance without an opening transaction', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('10.00'),
        openedAt: OPENED_AT,
      }),
    ).toThrow(InvalidWalletOpeningError);
  });

  it('rejects an opening transaction on a zero initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('0.00'),
        openedAt: OPENED_AT,
        opening: OPENING,
      }),
    ).toThrow(InvalidWalletOpeningError);
  });

  it('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('10.00').negate(),
        openedAt: OPENED_AT,
        opening: OPENING,
      }),
    ).toThrow(InvalidWalletOpeningError);
  });
});

describe('Wallet.debit', () => {
  it('subtracts the money, increments version and returns the matching DEBIT', () => {
    const { wallet } = openWith('100.00');

    const entry = wallet.debit(movement('80.00'));

    expect(wallet.balance.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(LATER.toISOString());
    expect(wallet.createdAt.toISOString()).toBe(OPENED_AT.toISOString());
    expect(entry.id).toBe('entry-1');
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-1');
    expect<string>(entry.direction).toBe('DEBIT');
    expect(entry.money.toJSON().amount).toBe('80.00');
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  it('allows debiting the whole balance down to zero', () => {
    const { wallet } = openWith('100.00');
    wallet.debit(movement('100.00'));
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  it('rejects insufficient funds without changing balance, version or updatedAt', () => {
    const { wallet } = openWith('100.00');
    const before = snapshot(wallet);

    expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
    expect(snapshot(wallet)).toEqual(before);
  });

  it('rejects any debit on a zero balance', () => {
    const { wallet } = openWith('0.00');
    expect(() => wallet.debit(movement('0.01'))).toThrow(InsufficientFundsError);
    expect(wallet.version).toBe(1);
  });

  it('rejects another currency without changing state', () => {
    const { wallet } = openWith('100.00');
    const before = snapshot(wallet);

    expect(() => wallet.debit({ ...movement('10.00'), money: usd('10.00') })).toThrow(
      CurrencyMismatchError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  it('rejects a zero amount without changing state', () => {
    const { wallet } = openWith('100.00');
    const before = snapshot(wallet);

    expect(() => wallet.debit(movement('0.00'))).toThrow(InvalidLedgerEntryError);
    expect(snapshot(wallet)).toEqual(before);
  });
});

describe('Wallet.credit', () => {
  it('adds the money, increments version and returns the matching CREDIT', () => {
    const { wallet } = openWith('20.00');

    const entry = wallet.credit(movement('25.00'));

    expect(wallet.balance.toJSON()).toEqual({ amount: '45.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(LATER.toISOString());
    expect<string>(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.toJSON().amount).toBe('20.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  it('credits a wallet opened with zero balance', () => {
    const { wallet } = openWith('0.00');
    wallet.credit(movement('0.10'));
    expect(wallet.balance.toJSON().amount).toBe('0.10');
    expect(wallet.version).toBe(2);
  });

  it('rejects another currency without changing state', () => {
    const { wallet } = openWith('20.00');
    const before = snapshot(wallet);

    expect(() => wallet.credit({ ...movement('10.00'), money: usd('10.00') })).toThrow(
      CurrencyMismatchError,
    );
    expect(snapshot(wallet)).toEqual(before);
  });

  it('rejects a zero amount without changing state', () => {
    const { wallet } = openWith('20.00');
    const before = snapshot(wallet);

    expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidLedgerEntryError);
    expect(snapshot(wallet)).toEqual(before);
  });
});

describe('Wallet.canDebit', () => {
  it('answers without changing state', () => {
    const { wallet } = openWith('100.00');
    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(wallet.version).toBe(1);
  });

  it('rejects another currency', () => {
    const { wallet } = openWith('100.00');
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet: balance and ledger stay consistent', () => {
  it('matches the ledger replay after every operation, and version counts balance changes', () => {
    const { wallet, openingEntry } = openWith('100.00');
    const ledger: WalletLedgerEntry[] = [openingEntry as WalletLedgerEntry];

    // cenário do §8: duas apostas de 80.00 sobre 100.00, só a primeira passa
    ledger.push(wallet.debit(movement('80.00', 1)));
    expect(() => wallet.debit(movement('80.00', 2))).toThrow(InsufficientFundsError);
    ledger.push(wallet.credit(movement('150.00', 3)));
    ledger.push(wallet.debit(movement('0.01', 4)));

    expect(wallet.balance.toJSON().amount).toBe('169.99');
    expect(replayLedger(ledger).equals(wallet.balance)).toBe(true);
    expect(ledger.every((entry) => entry.isBalanced())).toBe(true);
    // cada lançamento começa onde o anterior terminou
    for (let i = 1; i < ledger.length; i++) {
      expect(ledger[i]!.balanceBefore.equals(ledger[i - 1]!.balanceAfter)).toBe(true);
    }
    // version 1 (abertura, inclui o CREDIT inicial) + 3 alterações de saldo; a recusa não conta
    expect(wallet.version).toBe(4);
  });
});

describe('Wallet: date immutability', () => {
  it('is not affected by mutating the Dates passed in or returned', () => {
    const openedAt = new Date(OPENED_AT.getTime());
    const { wallet } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('0.00'),
      openedAt,
    });
    openedAt.setUTCFullYear(2000);
    wallet.createdAt.setUTCFullYear(2000);
    wallet.updatedAt.setUTCFullYear(2000);

    expect(wallet.createdAt.toISOString()).toBe(OPENED_AT.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(OPENED_AT.toISOString());
  });
});

describe('Wallet.rehydrate', () => {
  const state = (overrides: Partial<WalletState> = {}): WalletState => ({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: brl('55.00'),
    version: 7,
    createdAt: OPENED_AT,
    updatedAt: LATER,
    ...overrides,
  });

  it('rebuilds the persisted state as is', () => {
    const wallet = Wallet.rehydrate(state());

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toJSON().amount).toBe('55.00');
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt.toISOString()).toBe(OPENED_AT.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(LATER.toISOString());
  });

  it('continues from the persisted version', () => {
    const wallet = Wallet.rehydrate(state());
    const entry = wallet.debit(movement('5.00'));

    expect(wallet.version).toBe(8);
    expect(entry.balanceBefore.toJSON().amount).toBe('55.00');
    expect(wallet.balance.toJSON().amount).toBe('50.00');
  });

  it('does not revalidate', () => {
    const wallet = Wallet.rehydrate(
      state({ balance: brl('1.00').negate(), version: 0, currency: 'USD' }),
    );
    expect(wallet.balance.isNegative()).toBe(true);
    expect(wallet.version).toBe(0);
  });
});

describe('Wallet errors', () => {
  it('InsufficientFundsError is a GIVE_UP DomainError that names only the wallet', () => {
    const error = new InsufficientFundsError('wallet-1');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('InsufficientFundsError');
    expect(error.code).toBe(FailureCode.InsufficientFunds);
    expect(error.action).toBe(FailureAction.GiveUp);
    expect(error.walletId).toBe('wallet-1');
    expect(error.message).toBe('Insufficient funds in wallet wallet-1');
  });

  it('InvalidWalletOpeningError is an invariant violation', () => {
    const error = new InvalidWalletOpeningError('x');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe(FailureCode.InvariantViolation);
    expect(error.action).toBe(FailureAction.GiveUp);
  });
});
