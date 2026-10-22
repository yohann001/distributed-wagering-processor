import { describe, expect, it } from 'bun:test';

import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../../../src/modules/wagering/domain/wager-transaction-events';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';
import {
  InvalidIntegrationEventError,
  type EventContext,
} from '../../../../../src/shared/domain/integration-event';
import { Money } from '../../../../../src/shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const CREATED_AT = new Date('2026-10-21T12:00:00.000Z');
const LATER = new Date('2026-10-21T12:05:00.000Z');

const CTX: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: new Date('2026-10-21T12:00:00.000Z'),
};

const NEEDS_REFERENCE = new Set<WagerTransactionKind>([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const create = (
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction =>
  WagerTransaction.create({
    id: `tx-${kind.toLowerCase()}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind.toLowerCase()}`,
    idempotencyKey: `provider-a:ext-${kind.toLowerCase()}`,
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('80.00'),
    ...(NEEDS_REFERENCE.has(kind) ? { referenceExternalTransactionId: 'ext-ref' } : {}),
    createdAt: CREATED_AT,
    ...overrides,
  });

const processed = (
  kind: WagerTransactionKind,
  balanceAfter: string,
  referenceTransactionId?: string,
): WagerTransaction => {
  const tx = create(kind);
  tx.markProcessed({
    at: LATER,
    balanceAfter: brl(balanceAfter),
    ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
  });
  return tx;
};

const rejected = (code: FailureCode, balanceAfter: string | null): WagerTransaction => {
  const tx = create(WagerTransactionKind.Bet);
  tx.reject(code, balanceAfter === null ? null : brl(balanceAfter));
  return tx;
};

const pendingReference = (): WagerTransaction => {
  const tx = create(WagerTransactionKind.Rollback);
  tx.markPendingReference();
  return tx;
};

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

const EXPECTED_PROCESSED_BET =
  '{"eventId":"event-1","eventType":"WagerTransactionProcessed","aggregateId":"tx-bet",' +
  '"correlationId":"corr-1","causationId":"msg-1","occurredAt":"2026-10-21T12:00:00.000Z","version":1,' +
  '"data":{"transactionId":"tx-bet","providerId":"provider-a","externalTransactionId":"ext-bet",' +
  '"walletId":"wallet-1","playerId":"player-1","roundId":"round-1","gameId":"game-1","kind":"BET",' +
  '"money":{"amount":"80.00","currency":"BRL"},' +
  '"balanceAfter":{"amount":"20.00","currency":"BRL"}}}';

const EXPECTED_PROCESSED_REFUND =
  '{"eventId":"event-1","eventType":"WagerTransactionProcessed","aggregateId":"tx-refund",' +
  '"correlationId":"corr-1","causationId":"msg-1","occurredAt":"2026-10-21T12:00:00.000Z","version":1,' +
  '"data":{"transactionId":"tx-refund","providerId":"provider-a","externalTransactionId":"ext-refund",' +
  '"walletId":"wallet-1","playerId":"player-1","roundId":"round-1","gameId":"game-1","kind":"REFUND",' +
  '"money":{"amount":"80.00","currency":"BRL"},"referenceExternalTransactionId":"ext-ref",' +
  '"referenceTransactionId":"tx-bet","balanceAfter":{"amount":"100.00","currency":"BRL"}}}';

const EXPECTED_REJECTED_INSUFFICIENT_FUNDS =
  '{"eventId":"event-1","eventType":"WagerTransactionRejected","aggregateId":"tx-bet",' +
  '"correlationId":"corr-1","causationId":"msg-1","occurredAt":"2026-10-21T12:00:00.000Z","version":1,' +
  '"data":{"transactionId":"tx-bet","providerId":"provider-a","externalTransactionId":"ext-bet",' +
  '"walletId":"wallet-1","playerId":"player-1","roundId":"round-1","gameId":"game-1","kind":"BET",' +
  '"money":{"amount":"80.00","currency":"BRL"},"failureCode":"INSUFFICIENT_FUNDS",' +
  '"balanceAfter":{"amount":"20.00","currency":"BRL"}}}';

const EXPECTED_REJECTED_WALLET_NOT_FOUND =
  '{"eventId":"event-1","eventType":"WagerTransactionRejected","aggregateId":"tx-bet",' +
  '"correlationId":"corr-1","causationId":"msg-1","occurredAt":"2026-10-21T12:00:00.000Z","version":1,' +
  '"data":{"transactionId":"tx-bet","providerId":"provider-a","externalTransactionId":"ext-bet",' +
  '"walletId":"wallet-1","playerId":"player-1","roundId":"round-1","gameId":"game-1","kind":"BET",' +
  '"money":{"amount":"80.00","currency":"BRL"},"failureCode":"WALLET_NOT_FOUND"}}';

const EXPECTED_PENDING_REFERENCE_ROLLBACK =
  '{"eventId":"event-1","eventType":"WagerTransactionPendingReference","aggregateId":"tx-rollback",' +
  '"correlationId":"corr-1","causationId":"msg-1","occurredAt":"2026-10-21T12:00:00.000Z","version":1,' +
  '"data":{"transactionId":"tx-rollback","providerId":"provider-a","externalTransactionId":"ext-rollback",' +
  '"walletId":"wallet-1","playerId":"player-1","roundId":"round-1","gameId":"game-1","kind":"ROLLBACK",' +
  '"money":{"amount":"80.00","currency":"BRL"},"referenceExternalTransactionId":"ext-ref"}}';

describe('WagerTransactionProcessed: golden JSON', () => {
  it('serializes a processed BET with the observed balance', () => {
    const event = WagerTransactionProcessed.from(
      processed(WagerTransactionKind.Bet, '20.00'),
      CTX,
    );
    expect(JSON.stringify(event)).toBe(EXPECTED_PROCESSED_BET);
  });

  it('serializes a processed REFUND with both references', () => {
    const event = WagerTransactionProcessed.from(
      processed(WagerTransactionKind.Refund, '100.00', 'tx-bet'),
      CTX,
    );
    expect(JSON.stringify(event)).toBe(EXPECTED_PROCESSED_REFUND);
  });

  it('omits causationId when the context has none', () => {
    const { causationId: _omitted, ...withoutCausation } = CTX;
    const event = WagerTransactionProcessed.from(
      processed(WagerTransactionKind.Bet, '20.00'),
      withoutCausation,
    );
    expect(JSON.stringify(event)).toBe(EXPECTED_PROCESSED_BET.replace('"causationId":"msg-1",', ''));
  });
});

describe('WagerTransactionProcessed: accepted transactions', () => {
  it('accepts a LOSS, which produces no ledger entry', () => {
    const event = WagerTransactionProcessed.from(
      processed(WagerTransactionKind.Loss, '100.00'),
      CTX,
    );
    expect<string>(event.data.kind).toBe('LOSS');
    expect(event.data.balanceAfter).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('accepts the internal OPENING credit', () => {
    const opening = WagerTransaction.createOpening({
      id: 'tx-opening',
      providerId: 'internal',
      externalTransactionId: 'opening-wallet-1',
      idempotencyKey: 'internal:opening-wallet-1',
      payloadHash: 'hash-opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'opening',
      gameId: 'opening',
      money: brl('1000.00'),
      createdAt: CREATED_AT,
    });
    const event = WagerTransactionProcessed.from(opening, CTX);

    expect<string>(event.data.kind).toBe('OPENING');
    expect(event.data.balanceAfter).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(event.aggregateId).toBe('tx-opening');
  });
});

describe('WagerTransactionRejected: golden JSON', () => {
  it('serializes INSUFFICIENT_FUNDS with the observed balance', () => {
    const event = WagerTransactionRejected.from(
      rejected(FailureCode.InsufficientFunds, '20.00'),
      CTX,
    );
    expect(JSON.stringify(event)).toBe(EXPECTED_REJECTED_INSUFFICIENT_FUNDS);
  });

  it('serializes WALLET_NOT_FOUND without any balance', () => {
    const event = WagerTransactionRejected.from(rejected(FailureCode.WalletNotFound, null), CTX);
    expect(JSON.stringify(event)).toBe(EXPECTED_REJECTED_WALLET_NOT_FOUND);
    expect('balanceAfter' in event.data).toBe(false);
  });
});

describe('WagerTransactionPendingReference: golden JSON', () => {
  it('serializes a ROLLBACK waiting for its reference', () => {
    const event = WagerTransactionPendingReference.from(pendingReference(), CTX);
    expect(JSON.stringify(event)).toBe(EXPECTED_PENDING_REFERENCE_ROLLBACK);
  });

  it('accepts a WIN that points at a BET not received yet', () => {
    const win = create(WagerTransactionKind.Win, { referenceExternalTransactionId: 'ext-bet' });
    win.markPendingReference();
    const event = WagerTransactionPendingReference.from(win, CTX);

    expect<string>(event.data.kind).toBe('WIN');
    expect(event.data.referenceExternalTransactionId).toBe('ext-bet');
  });
});

describe('wager transaction events: type and aggregate', () => {
  it('declares eventType and version as literal types', () => {
    const processedEvent = WagerTransactionProcessed.from(
      processed(WagerTransactionKind.Bet, '20.00'),
      CTX,
    );
    const rejectedEvent = WagerTransactionRejected.from(
      rejected(FailureCode.InsufficientFunds, '20.00'),
      CTX,
    );
    const pendingEvent = WagerTransactionPendingReference.from(pendingReference(), CTX);

    const processedType: 'WagerTransactionProcessed' = processedEvent.eventType;
    const rejectedType: 'WagerTransactionRejected' = rejectedEvent.eventType;
    const pendingType: 'WagerTransactionPendingReference' = pendingEvent.eventType;
    const versions: 1[] = [processedEvent.version, rejectedEvent.version, pendingEvent.version];

    expect([processedType, rejectedType, pendingType]).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
      'WagerTransactionPendingReference',
    ]);
    expect(versions).toEqual([1, 1, 1]);
  });

  it('uses the internal transaction id as the aggregate and keeps the walletId in data', () => {
    const tx = processed(WagerTransactionKind.Bet, '20.00');
    const event = WagerTransactionProcessed.from(tx, CTX);

    expect(event.aggregateId).toBe(tx.id);
    expect(event.data.walletId).toBe('wallet-1');
    expect(event.eventId).toBe('event-1');
    expect(event.correlationId).toBe('corr-1');
    expect(event.causationId).toBe('msg-1');
    expect(event.occurredAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
  });
});

describe('wager transaction events: money in data', () => {
  const events = [
    [
      'WagerTransactionProcessed',
      () =>
        WagerTransactionProcessed.from(
          processed(WagerTransactionKind.Refund, '100.00', 'tx-bet'),
          CTX,
        ),
    ],
    [
      'WagerTransactionRejected',
      () => WagerTransactionRejected.from(rejected(FailureCode.InsufficientFunds, '20.00'), CTX),
    ],
    [
      'WagerTransactionPendingReference',
      () => WagerTransactionPendingReference.from(pendingReference(), CTX),
    ],
  ] as const;

  it('detects a Money instance when there is one', () => {
    expect(containsMoney({ nested: [{ money: brl('1.00') }] })).toBe(true);
  });

  it.each(events)('%s carries plain MoneyProps, never a Money instance', (_name, build) => {
    const event = build();

    expect(containsMoney(event.data)).toBe(false);
    expect(Object.getPrototypeOf(event.data.money)).toBe(Object.prototype);
    expect(event.data.money).toEqual({ amount: '80.00', currency: 'BRL' });
  });

  it.each(events)('%s survives a JSON round trip unchanged', (_name, build) => {
    const event = build();
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  it.each(events)('%s freezes data and its money', (_name, build) => {
    const event = build();

    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
  });
});

describe('wager transaction events: wrong source state', () => {
  const rehydrateAs = (
    status: WagerTransactionStatus,
    overrides: Partial<Parameters<typeof WagerTransaction.rehydrate>[0]> = {},
  ): WagerTransaction =>
    WagerTransaction.rehydrate({
      id: 'tx-bet',
      providerId: 'provider-a',
      externalTransactionId: 'ext-bet',
      idempotencyKey: 'provider-a:ext-bet',
      payloadHash: 'hash-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl('80.00'),
      createdAt: CREATED_AT,
      status,
      ...overrides,
    });

  it('Processed.from refuses a PENDING transaction and names the id and status only', () => {
    const error = caught(() => WagerTransactionProcessed.from(create(WagerTransactionKind.Bet), CTX));

    expect(error).toBeInstanceOf(InvalidIntegrationEventError);
    expect((error as InvalidIntegrationEventError).message).toBe(
      'Invalid integration event: WagerTransactionProcessed requires a PROCESSED transaction, tx-bet is PENDING',
    );
  });

  it('Processed.from refuses a REJECTED transaction', () => {
    expect(() =>
      WagerTransactionProcessed.from(rejected(FailureCode.InsufficientFunds, '20.00'), CTX),
    ).toThrow(InvalidIntegrationEventError);
  });

  it('Processed.from refuses a rehydrated PROCESSED transaction without the observed balance', () => {
    expect(() =>
      WagerTransactionProcessed.from(rehydrateAs(WagerTransactionStatus.Processed), CTX),
    ).toThrow(InvalidIntegrationEventError);
  });

  it('Rejected.from refuses PENDING and PROCESSED transactions', () => {
    expect(() => WagerTransactionRejected.from(create(WagerTransactionKind.Bet), CTX)).toThrow(
      InvalidIntegrationEventError,
    );
    expect(() =>
      WagerTransactionRejected.from(processed(WagerTransactionKind.Bet, '20.00'), CTX),
    ).toThrow(InvalidIntegrationEventError);
  });

  it('Rejected.from refuses a rehydrated REJECTED transaction without a failure code', () => {
    expect(() =>
      WagerTransactionRejected.from(rehydrateAs(WagerTransactionStatus.Rejected), CTX),
    ).toThrow(InvalidIntegrationEventError);
  });

  it('PendingReference.from refuses PENDING and PROCESSED transactions', () => {
    expect(() =>
      WagerTransactionPendingReference.from(create(WagerTransactionKind.Rollback), CTX),
    ).toThrow(InvalidIntegrationEventError);
    expect(() =>
      WagerTransactionPendingReference.from(processed(WagerTransactionKind.Bet, '20.00'), CTX),
    ).toThrow(InvalidIntegrationEventError);
  });

  it('PendingReference.from refuses a rehydrated PENDING_REFERENCE transaction without a reference', () => {
    expect(() =>
      WagerTransactionPendingReference.from(
        rehydrateAs(WagerTransactionStatus.PendingReference),
        CTX,
      ),
    ).toThrow(InvalidIntegrationEventError);
  });

  it('rejects an invalid context through the envelope guards', () => {
    const tx = processed(WagerTransactionKind.Bet, '20.00');
    expect(() => WagerTransactionProcessed.from(tx, { ...CTX, eventId: '' })).toThrow(
      InvalidIntegrationEventError,
    );
    expect(() =>
      WagerTransactionProcessed.from(tx, { ...CTX, occurredAt: new Date('x') }),
    ).toThrow(InvalidIntegrationEventError);
  });
});
