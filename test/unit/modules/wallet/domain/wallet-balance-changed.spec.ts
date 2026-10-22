import { describe, expect, it } from 'bun:test';

import { Wallet } from '../../../../../src/modules/wallet/domain/wallet';
import { WalletBalanceChanged } from '../../../../../src/modules/wallet/domain/wallet-balance-changed';
import type { WalletLedgerEntry } from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import {
  InvalidIntegrationEventError,
  type EventContext,
} from '../../../../../src/shared/domain/integration-event';
import { Money } from '../../../../../src/shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const OPENED_AT = new Date('2026-10-21T12:00:00.000Z');
const LATER = new Date('2026-10-21T12:05:00.000Z');

const CTX: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: new Date('2026-10-21T12:00:00.000Z'),
};

const openWallet = (id = 'wallet-1'): Wallet =>
  Wallet.open({
    id,
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openedAt: OPENED_AT,
    opening: { transactionId: `tx-opening-${id}`, ledgerEntryId: `entry-opening-${id}` },
  }).wallet;

const movement = (amount: string, n: number) => ({
  money: brl(amount),
  transactionId: `tx-${n}`,
  ledgerEntryId: `entry-${n}`,
  at: LATER,
});

const EXPECTED_DEBIT =
  '{"eventId":"event-1","eventType":"WalletBalanceChanged","aggregateId":"wallet-1",' +
  '"correlationId":"corr-1","causationId":"msg-1","occurredAt":"2026-10-21T12:00:00.000Z","version":1,' +
  '"data":{"walletId":"wallet-1","transactionId":"tx-1","ledgerEntryId":"entry-1","direction":"DEBIT",' +
  '"money":{"amount":"80.00","currency":"BRL"},"balanceBefore":{"amount":"100.00","currency":"BRL"},' +
  '"balanceAfter":{"amount":"20.00","currency":"BRL"},"walletVersion":2}}';

const EXPECTED_CREDIT =
  '{"eventId":"event-1","eventType":"WalletBalanceChanged","aggregateId":"wallet-1",' +
  '"correlationId":"corr-1","causationId":"msg-1","occurredAt":"2026-10-21T12:00:00.000Z","version":1,' +
  '"data":{"walletId":"wallet-1","transactionId":"tx-2","ledgerEntryId":"entry-2","direction":"CREDIT",' +
  '"money":{"amount":"25.00","currency":"BRL"},"balanceBefore":{"amount":"20.00","currency":"BRL"},' +
  '"balanceAfter":{"amount":"45.00","currency":"BRL"},"walletVersion":3}}';

const containsMoney = (value: unknown): boolean => {
  if (value instanceof Money) {
    return true;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsMoney);
  }
  return false;
};

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('WalletBalanceChanged: golden JSON', () => {
  it('serializes a DEBIT of 80.00 on a wallet with 100.00', () => {
    const wallet = openWallet();
    const entry = wallet.debit(movement('80.00', 1));

    expect(JSON.stringify(WalletBalanceChanged.from(wallet, entry, CTX))).toBe(EXPECTED_DEBIT);
  });

  it('serializes a CREDIT that follows the debit', () => {
    const wallet = openWallet();
    wallet.debit(movement('80.00', 1));
    const entry = wallet.credit(movement('25.00', 2));

    expect(JSON.stringify(WalletBalanceChanged.from(wallet, entry, CTX))).toBe(EXPECTED_CREDIT);
  });

  it('omits causationId when the context has none', () => {
    const { causationId: _omitted, ...withoutCausation } = CTX;
    const wallet = openWallet();
    const entry = wallet.debit(movement('80.00', 1));
    const event = WalletBalanceChanged.from(wallet, entry, withoutCausation);

    expect(JSON.stringify(event)).toBe(EXPECTED_DEBIT.replace('"causationId":"msg-1",', ''));
  });
});

describe('WalletBalanceChanged: type, aggregate and money', () => {
  const build = (): { event: WalletBalanceChanged; wallet: Wallet; entry: WalletLedgerEntry } => {
    const wallet = openWallet();
    const entry = wallet.debit(movement('80.00', 1));
    return { event: WalletBalanceChanged.from(wallet, entry, CTX), wallet, entry };
  };

  it('declares eventType and version as literal types', () => {
    const { event } = build();
    const eventType: 'WalletBalanceChanged' = event.eventType;
    const version: 1 = event.version;

    expect(eventType).toBe('WalletBalanceChanged');
    expect(version).toBe(1);
  });

  it('uses the wallet id as the aggregate and carries the ledger entry id', () => {
    const { event, wallet, entry } = build();

    expect(event.aggregateId).toBe(wallet.id);
    expect(event.data.walletId).toBe(wallet.id);
    expect(event.data.ledgerEntryId).toBe(entry.id);
    expect(event.data.walletVersion).toBe(wallet.version);
  });

  it('carries plain MoneyProps, never a Money instance', () => {
    const { event } = build();

    expect(containsMoney(event.data)).toBe(false);
    expect(Object.getPrototypeOf(event.data.money)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(event.data.balanceBefore)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(event.data.balanceAfter)).toBe(Object.prototype);
  });

  it('survives a JSON round trip unchanged', () => {
    const { event } = build();
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  it('freezes data and its money', () => {
    const { event } = build();

    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(Object.isFrozen(event.data.balanceBefore)).toBe(true);
    expect(Object.isFrozen(event.data.balanceAfter)).toBe(true);
  });
});

describe('WalletBalanceChanged: inconsistent source', () => {
  it('refuses an entry that belongs to another wallet and names the ids only', () => {
    const other = openWallet('wallet-2');
    const foreignEntry = other.debit(movement('80.00', 1));
    const wallet = openWallet();
    wallet.debit(movement('80.00', 2));

    const error = caught(() => WalletBalanceChanged.from(wallet, foreignEntry, CTX));

    expect(error).toBeInstanceOf(InvalidIntegrationEventError);
    expect((error as InvalidIntegrationEventError).message).toBe(
      'Invalid integration event: ledger entry entry-1 belongs to wallet wallet-2, not to wallet wallet-1',
    );
  });

  it('refuses an entry that is no longer the latest movement of the wallet', () => {
    const wallet = openWallet();
    const staleEntry = wallet.debit(movement('30.00', 1));
    wallet.debit(movement('20.00', 2));

    const error = caught(() => WalletBalanceChanged.from(wallet, staleEntry, CTX));

    expect(error).toBeInstanceOf(InvalidIntegrationEventError);
    expect((error as InvalidIntegrationEventError).message).toBe(
      'Invalid integration event: ledger entry entry-1 is not the latest movement of wallet wallet-1',
    );
  });

  it('refuses the opening entry once later movements brought the balance back to the same value', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      openedAt: OPENED_AT,
      opening: { transactionId: 'tx-opening', ledgerEntryId: 'entry-opening' },
    });
    wallet.credit(movement('10.00', 1));
    wallet.debit(movement('10.00', 2));
    expect(wallet.balance.equals((openingEntry as WalletLedgerEntry).balanceAfter)).toBe(true);

    const error = caught(() => WalletBalanceChanged.from(wallet, openingEntry as WalletLedgerEntry, CTX));

    expect(error).toBeInstanceOf(InvalidIntegrationEventError);
    expect((error as InvalidIntegrationEventError).message).toBe(
      'Invalid integration event: ledger entry entry-opening is not the latest movement of wallet wallet-1',
    );
  });

  it('refuses any entry for a rehydrated wallet that has not moved', () => {
    const source = openWallet();
    const entry = source.debit(movement('80.00', 1));
    const rehydrated = Wallet.rehydrate({
      id: source.id,
      playerId: source.playerId,
      currency: source.currency,
      balance: source.balance,
      version: source.version,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    });

    expect(() => WalletBalanceChanged.from(rehydrated, entry, CTX)).toThrow(
      InvalidIntegrationEventError,
    );
  });

  it('rejects an invalid context through the envelope guards', () => {
    const wallet = openWallet();
    const entry = wallet.debit(movement('80.00', 1));

    expect(() => WalletBalanceChanged.from(wallet, entry, { ...CTX, correlationId: '' })).toThrow(
      InvalidIntegrationEventError,
    );
  });
});
