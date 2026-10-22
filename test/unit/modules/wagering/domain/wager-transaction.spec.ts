import { describe, expect, it } from 'bun:test';

import {
  InvalidWagerTransactionError,
  KindNotAllowedError,
  ReferenceRequiredError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { InvalidTransactionStateError } from '../../../../../src/shared/domain/domain-error';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';
import { InvalidMoneyError, Money } from '../../../../../src/shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const CREATED_AT = new Date('2026-10-21T12:00:00.000Z');
const LATER = new Date('2026-10-21T12:05:00.000Z');

const NEEDS_REFERENCE = new Set<WagerTransactionKind>([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const props = (
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
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

const create = (
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction => WagerTransaction.create(props(kind, overrides));

const opening = (): WagerTransaction =>
  WagerTransaction.createOpening({
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

const processed = (kind: WagerTransactionKind): WagerTransaction => {
  const tx = create(kind);
  tx.markProcessed({
    at: LATER,
    balanceAfter: brl('20.00'),
    ...(NEEDS_REFERENCE.has(kind) ? { referenceTransactionId: 'tx-ref' } : {}),
  });
  return tx;
};

const pendingReference = (): WagerTransaction => {
  const tx = create(WagerTransactionKind.Refund);
  tx.markPendingReference();
  return tx;
};

const rejected = (): WagerTransaction => {
  const tx = create(WagerTransactionKind.Bet);
  tx.reject(FailureCode.InsufficientFunds, brl('50.00'));
  return tx;
};

const failed = (): WagerTransaction => {
  const tx = create(WagerTransactionKind.Bet);
  tx.fail(FailureCode.PermanentFailure);
  return tx;
};

const snapshot = (tx: WagerTransaction) => ({
  status: tx.status,
  failureCode: tx.failureCode,
  referenceTransactionId: tx.referenceTransactionId,
  processedAt: tx.processedAt?.toISOString(),
  balanceAfter: tx.balanceAfter?.toJSON(),
});

describe('WagerTransaction.create', () => {
  it('is born PENDING with the given identity and no decision yet', () => {
    const tx = create(WagerTransactionKind.Bet);

    expect(tx.id).toBe('tx-bet');
    expect(tx.providerId).toBe('provider-a');
    expect(tx.externalTransactionId).toBe('ext-bet');
    expect(tx.idempotencyKey).toBe('provider-a:ext-bet');
    expect(tx.payloadHash).toBe('hash-1');
    expect(tx.walletId).toBe('wallet-1');
    expect(tx.playerId).toBe('player-1');
    expect(tx.roundId).toBe('round-1');
    expect(tx.gameId).toBe('game-1');
    expect<string>(tx.kind).toBe('BET');
    expect(tx.money.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(tx.createdAt.toISOString()).toBe(CREATED_AT.toISOString());
    expect<string>(tx.status).toBe('PENDING');
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  it.each([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])('accepts %s from a provider', (kind) => {
    expect(create(kind).status).toBe(WagerTransactionStatus.Pending);
  });

  it('refuses OPENING coming from outside with KIND_NOT_ALLOWED', () => {
    let error: unknown;
    try {
      create(WagerTransactionKind.Opening);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(KindNotAllowedError);
    expect<string>((error as KindNotAllowedError).code).toBe('KIND_NOT_ALLOWED');
  });

  it('refuses an unknown kind', () => {
    expect(() => create('JACKPOT' as WagerTransactionKind)).toThrow(KindNotAllowedError);
  });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    'rejects %s without reference with REFERENCE_REQUIRED',
    (kind) => {
      for (const reference of [undefined, '']) {
        let error: unknown;
        try {
          create(kind, { referenceExternalTransactionId: reference });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(ReferenceRequiredError);
        expect<string>((error as ReferenceRequiredError).code).toBe('REFERENCE_REQUIRED');
      }
    },
  );

  it('keeps the reference of REFUND and ROLLBACK', () => {
    expect(create(WagerTransactionKind.Refund).referenceExternalTransactionId).toBe('ext-ref');
    expect(create(WagerTransactionKind.Rollback).referenceExternalTransactionId).toBe('ext-ref');
  });

  it('accepts an optional reference on WIN, and normalizes an empty one to undefined', () => {
    const withReference = create(WagerTransactionKind.Win, {
      referenceExternalTransactionId: 'ext-bet',
    });
    expect(withReference.referenceExternalTransactionId).toBe('ext-bet');
    const withEmpty = create(WagerTransactionKind.Win, { referenceExternalTransactionId: '' });
    expect(withEmpty.referenceExternalTransactionId).toBeUndefined();
  });

  it.each([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])('requires a positive amount for %s', (kind) => {
    let error: unknown;
    try {
      create(kind, { money: brl('0.00') });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidMoneyError);
    expect<string>((error as InvalidMoneyError).code).toBe('INVALID_MONEY');
  });

  it('accepts a zero amount for LOSS, but never a negative one', () => {
    expect(create(WagerTransactionKind.Loss, { money: brl('0.00') }).money.isZero()).toBe(true);
    expect(() => create(WagerTransactionKind.Loss, { money: brl('1.00').negate() })).toThrow(
      InvalidMoneyError,
    );
  });

  it('keeps its own copy of createdAt', () => {
    const createdAt = new Date(CREATED_AT.getTime());
    const tx = create(WagerTransactionKind.Bet, { createdAt });
    createdAt.setUTCFullYear(2000);
    tx.createdAt.setUTCFullYear(2001);
    expect(tx.createdAt.toISOString()).toBe(CREATED_AT.toISOString());
  });
});

describe('WagerTransaction.createOpening', () => {
  it('is born PROCESSED, with the initial balance as the observed balance', () => {
    const tx = opening();

    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt?.toISOString()).toBe(CREATED_AT.toISOString());
    expect(tx.balanceAfter?.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('requires a positive amount', () => {
    expect(() =>
      WagerTransaction.createOpening({ ...props(WagerTransactionKind.Bet), money: brl('0.00') }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('rebuilds persisted state without revalidating', () => {
    const tx = WagerTransaction.rehydrate({
      ...props(WagerTransactionKind.Rollback, { referenceExternalTransactionId: undefined }),
      kind: WagerTransactionKind.Rollback,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      balanceAfter: brl('20.00'),
    });

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(tx.balanceAfter?.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
  });

  it('rebuilds an OPENING (never accepted by create)', () => {
    const tx = WagerTransaction.rehydrate({
      ...props(WagerTransactionKind.Bet),
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Processed,
      processedAt: CREATED_AT,
      balanceAfter: brl('80.00'),
    });
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
  });

  it('keeps its own copy of processedAt', () => {
    const processedAt = new Date(LATER.getTime());
    const tx = WagerTransaction.rehydrate({
      ...props(WagerTransactionKind.Bet),
      status: WagerTransactionStatus.Processed,
      processedAt,
      balanceAfter: brl('20.00'),
    });
    processedAt.setUTCFullYear(2000);
    tx.processedAt?.setUTCFullYear(2001);
    expect(tx.processedAt?.toISOString()).toBe(LATER.toISOString());
  });
});

describe('WagerTransaction.markProcessed', () => {
  it('moves PENDING to PROCESSED, recording time and observed balance', () => {
    const tx = create(WagerTransactionKind.Bet);
    tx.markProcessed({ at: LATER, balanceAfter: brl('20.00') });

    expect<string>(tx.status).toBe('PROCESSED');
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt?.toISOString()).toBe(LATER.toISOString());
    expect(tx.balanceAfter?.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(tx.failureCode).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
  });

  it('moves PENDING_REFERENCE to PROCESSED with the resolved reference', () => {
    const tx = pendingReference();
    tx.markProcessed({ at: LATER, balanceAfter: brl('100.00'), referenceTransactionId: 'tx-bet' });

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('tx-bet');
  });

  it('records LOSS as PROCESSED with the unchanged balance', () => {
    const tx = create(WagerTransactionKind.Loss);
    tx.markProcessed({ at: LATER, balanceAfter: brl('100.00') });
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.balanceAfter?.toJSON().amount).toBe('100.00');
  });

  it('keeps an optional reference on WIN', () => {
    const tx = create(WagerTransactionKind.Win, { referenceExternalTransactionId: 'ext-bet' });
    tx.markProcessed({ at: LATER, balanceAfter: brl('180.00'), referenceTransactionId: 'tx-bet' });
    expect(tx.referenceTransactionId).toBe('tx-bet');
  });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    'refuses to process %s without the resolved reference',
    (kind) => {
      const tx = create(kind);
      expect(() => tx.markProcessed({ at: LATER, balanceAfter: brl('20.00') })).toThrow(
        InvalidWagerTransactionError,
      );
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
    },
  );

  it('refuses an observed balance in another currency or negative, leaving state intact', () => {
    const tx = create(WagerTransactionKind.Bet);
    expect(() => tx.markProcessed({ at: LATER, balanceAfter: usd('20.00') })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      tx.markProcessed({ at: LATER, balanceAfter: brl('20.00').negate() }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() => tx.markProcessed({ at: new Date('nope'), balanceAfter: brl('20.00') })).toThrow(
      InvalidWagerTransactionError,
    );
    expect(snapshot(tx)).toEqual(snapshot(create(WagerTransactionKind.Bet)));
  });

  it('keeps its own copy of processedAt', () => {
    const at = new Date(LATER.getTime());
    const tx = create(WagerTransactionKind.Bet);
    tx.markProcessed({ at, balanceAfter: brl('20.00') });
    at.setUTCFullYear(2000);
    expect(tx.processedAt?.toISOString()).toBe(LATER.toISOString());
  });
});

describe('WagerTransaction.markPendingReference', () => {
  it('moves PENDING to PENDING_REFERENCE, which is not terminal', () => {
    const tx = pendingReference();
    expect<string>(tx.status).toBe('PENDING_REFERENCE');
    expect(tx.isTerminal()).toBe(false);
  });

  it('is idempotent from PENDING_REFERENCE', () => {
    const tx = pendingReference();
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });

  it('allows a WIN that references a BET to wait for it', () => {
    const tx = create(WagerTransactionKind.Win, { referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });

  it('refuses a transaction without reference', () => {
    const tx = create(WagerTransactionKind.Bet);
    expect(() => tx.markPendingReference()).toThrow(InvalidWagerTransactionError);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
  });
});

describe('WagerTransaction.reject', () => {
  it('moves PENDING to REJECTED with the code and the observed balance', () => {
    const tx = rejected();

    expect<string>(tx.status).toBe('REJECTED');
    expect(tx.isTerminal()).toBe(true);
    expect<string | undefined>(tx.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(tx.balanceAfter?.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(tx.processedAt).toBeUndefined();
  });

  it('moves PENDING_REFERENCE to REJECTED when the reference never arrives', () => {
    const tx = pendingReference();
    tx.reject(FailureCode.ReferenceNotFound, brl('100.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('accepts null when there is no balance to expose', () => {
    const tx = create(WagerTransactionKind.Bet);
    tx.reject(FailureCode.WalletNotFound, null);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.balanceAfter).toBeUndefined();
  });

  it.each([
    FailureCode.TransientFailure,
    FailureCode.PermanentFailure,
    FailureCode.InvariantViolation,
  ])('refuses the non-business code %s', (code) => {
    const tx = create(WagerTransactionKind.Bet);
    expect(() => tx.reject(code, brl('50.00'))).toThrow(InvalidWagerTransactionError);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
  });

  it('refuses an observed balance in another currency or negative', () => {
    const tx = create(WagerTransactionKind.Bet);
    expect(() => tx.reject(FailureCode.InsufficientFunds, usd('50.00'))).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => tx.reject(FailureCode.InsufficientFunds, brl('1.00').negate())).toThrow(
      InvalidWagerTransactionError,
    );
    expect(snapshot(tx)).toEqual(snapshot(create(WagerTransactionKind.Bet)));
  });
});

describe('WagerTransaction.fail', () => {
  it('moves PENDING to FAILED with PERMANENT_FAILURE', () => {
    const tx = failed();
    expect<string>(tx.status).toBe('FAILED');
    expect(tx.isTerminal()).toBe(true);
    expect<string | undefined>(tx.failureCode).toBe('PERMANENT_FAILURE');
    expect(tx.balanceAfter).toBeUndefined();
  });

  it('moves PENDING_REFERENCE to FAILED', () => {
    const tx = pendingReference();
    tx.fail(FailureCode.PermanentFailure);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
  });

  it.each([FailureCode.TransientFailure, FailureCode.InsufficientFunds])(
    'refuses %s',
    (code) => {
      const tx = create(WagerTransactionKind.Bet);
      expect(() => tx.fail(code)).toThrow(InvalidWagerTransactionError);
      expect(tx.status).toBe(WagerTransactionStatus.Pending);
    },
  );
});

describe('transitions from terminal states', () => {
  const terminals: Array<[string, () => WagerTransaction]> = [
    ['PROCESSED', () => processed(WagerTransactionKind.Refund)],
    ['REJECTED', rejected],
    ['FAILED', failed],
    ['PROCESSED OPENING', opening],
  ];
  const transitions: Array<[string, (tx: WagerTransaction) => void]> = [
    [
      'markProcessed',
      (tx) =>
        tx.markProcessed({ at: LATER, balanceAfter: brl('1.00'), referenceTransactionId: 'tx-x' }),
    ],
    ['markPendingReference', (tx) => tx.markPendingReference()],
    ['reject', (tx) => tx.reject(FailureCode.AlreadyReversed, brl('1.00'))],
    ['fail', (tx) => tx.fail(FailureCode.PermanentFailure)],
  ];

  for (const [state, build] of terminals) {
    for (const [name, transition] of transitions) {
      it(`${name} from ${state} throws InvalidTransactionStateError and changes nothing`, () => {
        const tx = build();
        const before = snapshot(tx);

        let error: unknown;
        try {
          transition(tx);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(InvalidTransactionStateError);
        expect<string>((error as InvalidTransactionStateError).code).toBe('INVARIANT_VIOLATION');
        expect((error as InvalidTransactionStateError).attemptedTransition).toBe(name);
        expect(snapshot(tx)).toEqual(before);
      });
    }
  }
});

describe('domain queries', () => {
  it('affectsBalance is false only for LOSS', () => {
    expect(create(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(create(WagerTransactionKind.Win).affectsBalance()).toBe(true);
    expect(create(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(create(WagerTransactionKind.Refund).affectsBalance()).toBe(true);
    expect(create(WagerTransactionKind.Rollback).affectsBalance()).toBe(true);
    expect(opening().affectsBalance()).toBe(true);
  });

  it('requiresReference is true only for REFUND and ROLLBACK', () => {
    expect(create(WagerTransactionKind.Bet).requiresReference()).toBe(false);
    expect(
      create(WagerTransactionKind.Win, { referenceExternalTransactionId: 'ext-bet' })
        .requiresReference(),
    ).toBe(false);
    expect(create(WagerTransactionKind.Loss).requiresReference()).toBe(false);
    expect(create(WagerTransactionKind.Refund).requiresReference()).toBe(true);
    expect(create(WagerTransactionKind.Rollback).requiresReference()).toBe(true);
    expect(opening().requiresReference()).toBe(false);
  });

  it('matchesPayload compares the stored payload hash', () => {
    const tx = create(WagerTransactionKind.Bet, { payloadHash: 'abc123' });
    expect(tx.matchesPayload('abc123')).toBe(true);
    expect(tx.matchesPayload('abc124')).toBe(false);
    expect(tx.matchesPayload('')).toBe(false);
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  it('BET debits; WIN, REFUND and OPENING credit', () => {
    expect(create(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create(WagerTransactionKind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(create(WagerTransactionKind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(opening().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('ROLLBACK inverts the direction of its reference', () => {
    const rollback = create(WagerTransactionKind.Rollback);
    expect(rollback.ledgerDirectionFor(processed(WagerTransactionKind.Bet))).toBe(
      LedgerDirection.Credit,
    );
    expect(rollback.ledgerDirectionFor(processed(WagerTransactionKind.Win))).toBe(
      LedgerDirection.Debit,
    );
    expect(rollback.ledgerDirectionFor(processed(WagerTransactionKind.Refund))).toBe(
      LedgerDirection.Debit,
    );
  });

  it('ROLLBACK without reference is a programming error', () => {
    expect(() => create(WagerTransactionKind.Rollback).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('ROLLBACK of ROLLBACK, LOSS or OPENING is a programming error', () => {
    const rollback = create(WagerTransactionKind.Rollback);
    for (const reference of [
      processed(WagerTransactionKind.Rollback),
      processed(WagerTransactionKind.Loss),
      opening(),
    ]) {
      expect(() => rollback.ledgerDirectionFor(reference)).toThrow(InvalidWagerTransactionError);
    }
  });

  it('LOSS never produces a ledger entry', () => {
    expect(() => create(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });
});
