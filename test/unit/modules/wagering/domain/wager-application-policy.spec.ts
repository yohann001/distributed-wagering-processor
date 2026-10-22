import { describe, expect, it } from 'bun:test';

import {
  WagerApplicationPolicy,
  type ApplyWagerInput,
  type WagerApplicationOutcome,
} from '../../../../../src/modules/wagering/domain/wager-application-policy';
import {
  InvalidWagerTransactionError,
  ReferenceRequiredError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
  type WagerTransactionState,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { Wallet, type WalletState } from '../../../../../src/modules/wallet/domain/wallet';
import { InvalidTransactionStateError } from '../../../../../src/shared/domain/domain-error';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';
import { Money } from '../../../../../src/shared/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const CREATED_AT = new Date('2026-10-21T12:00:00.000Z');
const AT = new Date('2026-10-21T12:05:00.000Z');

const INITIAL_BALANCE = '100.00';
const INITIAL_VERSION = 3;

const policy = new WagerApplicationPolicy();

const NEEDS_REFERENCE = new Set<WagerTransactionKind>([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const wallet = (balance = INITIAL_BALANCE, overrides: Partial<WalletState> = {}): Wallet =>
  Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: brl(balance),
    version: INITIAL_VERSION,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });

const tx = (
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

/** Transação já decidida, com id interno `ref-1` e id externo `ext-ref` (o que REFUND/ROLLBACK apontam). */
const ref = (
  kind: WagerTransactionKind,
  overrides: Partial<WagerTransactionState> = {},
): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: 'ref-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-ref',
    idempotencyKey: 'provider-a:ext-ref',
    payloadHash: 'hash-ref',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('80.00'),
    createdAt: CREATED_AT,
    status: WagerTransactionStatus.Processed,
    processedAt: CREATED_AT,
    balanceAfter: brl('20.00'),
    ...overrides,
  });

const undecidedRef = (
  kind: WagerTransactionKind,
  status: WagerTransactionStatus.Pending | WagerTransactionStatus.PendingReference,
): WagerTransaction =>
  ref(kind, { status, processedAt: undefined, balanceAfter: undefined });

const failedRef = (kind: WagerTransactionKind): WagerTransaction =>
  ref(kind, {
    status: WagerTransactionStatus.Failed,
    failureCode: FailureCode.PermanentFailure,
    processedAt: undefined,
    balanceAfter: undefined,
  });

const rejectedRef = (kind: WagerTransactionKind): WagerTransaction =>
  ref(kind, {
    status: WagerTransactionStatus.Rejected,
    failureCode: FailureCode.InsufficientFunds,
    processedAt: undefined,
    balanceAfter: brl('20.00'),
  });

/** Reversão ou WIN/LOSS que já aponta a referência `ref-1`. */
const reversal = (
  kind: WagerTransactionKind,
  id: string,
  overrides: Partial<WagerTransactionState> = {},
): WagerTransaction =>
  ref(kind, {
    id,
    externalTransactionId: `ext-${id}`,
    referenceExternalTransactionId: 'ext-ref',
    referenceTransactionId: 'ref-1',
    ...overrides,
  });

const rejectedReversal = (kind: WagerTransactionKind, id: string): WagerTransaction =>
  reversal(kind, id, {
    status: WagerTransactionStatus.Rejected,
    failureCode: FailureCode.ReferenceAmountMismatch,
    referenceTransactionId: undefined,
    processedAt: undefined,
  });

type Overrides = Partial<Omit<ApplyWagerInput, 'transaction' | 'wallet'>>;

const apply = (
  transaction: WagerTransaction,
  target: Wallet | null,
  overrides: Overrides = {},
): WagerApplicationOutcome =>
  policy.apply({
    transaction,
    wallet: target,
    reference: null,
    reversalsOfReference: [],
    ledgerEntryId: 'entry-1',
    at: AT,
    ...overrides,
  });

interface AppliedExpectation {
  direction: string;
  from: string;
  to: string;
  referenceId?: string;
}

const expectApplied = (
  outcome: WagerApplicationOutcome,
  transaction: WagerTransaction,
  target: Wallet,
  expected: AppliedExpectation,
): void => {
  expect<string>(outcome.decision).toBe('APPLIED');
  const entry = outcome.ledgerEntry;
  expect(entry).not.toBeNull();
  expect<string | undefined>(entry?.direction).toBe(expected.direction);
  expect(entry?.id).toBe('entry-1');
  expect(entry?.walletId).toBe('wallet-1');
  expect(entry?.transactionId).toBe(transaction.id);
  expect(entry?.money.toJSON()).toEqual(transaction.money.toJSON());
  expect(entry?.balanceBefore.toJSON()).toEqual(brl(expected.from).toJSON());
  expect(entry?.balanceAfter.toJSON()).toEqual(brl(expected.to).toJSON());
  expect(entry?.isBalanced()).toBe(true);
  expect(target.balance.toJSON()).toEqual(brl(expected.to).toJSON());
  expect(target.version).toBe(INITIAL_VERSION + 1);
  expect<string>(transaction.status).toBe('PROCESSED');
  expect(transaction.balanceAfter?.toJSON()).toEqual(brl(expected.to).toJSON());
  expect(transaction.referenceTransactionId).toBe(expected.referenceId);
  expect(transaction.processedAt?.toISOString()).toBe(AT.toISOString());
};

const expectRecorded = (
  outcome: WagerApplicationOutcome,
  transaction: WagerTransaction,
  target: Wallet,
  referenceId?: string,
): void => {
  expect<string>(outcome.decision).toBe('RECORDED');
  expect(outcome.ledgerEntry).toBeNull();
  expect<string>(transaction.status).toBe('PROCESSED');
  expect(transaction.balanceAfter?.toJSON()).toEqual(brl(INITIAL_BALANCE).toJSON());
  expect(transaction.referenceTransactionId).toBe(referenceId);
  expect(transaction.processedAt?.toISOString()).toBe(AT.toISOString());
  expect(target.balance.toJSON()).toEqual(brl(INITIAL_BALANCE).toJSON());
  expect(target.version).toBe(INITIAL_VERSION);
};

interface RejectionExpectation {
  /** Saldo da wallet, que deve continuar igual. */
  balance?: string;
  /** Saldo exposto em `tx.balanceAfter`; null quando a rejeição não expõe saldo. Padrão: o da wallet. */
  observed?: string | null;
}

const expectRejected = (
  outcome: WagerApplicationOutcome,
  transaction: WagerTransaction,
  target: Wallet | null,
  code: string,
  expected: RejectionExpectation = {},
): void => {
  const balance = expected.balance ?? INITIAL_BALANCE;
  const observed = expected.observed === undefined ? balance : expected.observed;
  expect<unknown>(outcome).toEqual({
    decision: 'REJECTED',
    failureCode: code,
    ledgerEntry: null,
  });
  expect<string>(transaction.status).toBe('REJECTED');
  expect<string | undefined>(transaction.failureCode).toBe(code);
  expect(transaction.balanceAfter?.toJSON()).toEqual(
    observed === null ? undefined : brl(observed).toJSON(),
  );
  expect(transaction.referenceTransactionId).toBeUndefined();
  if (target !== null) {
    expect(target.balance.toJSON()).toEqual(brl(balance).toJSON());
    expect(target.version).toBe(INITIAL_VERSION);
  }
};

const expectAwaiting = (
  outcome: WagerApplicationOutcome,
  transaction: WagerTransaction,
  target: Wallet,
): void => {
  expect<string>(outcome.decision).toBe('AWAITING_REFERENCE');
  expect(outcome.ledgerEntry).toBeNull();
  expect<string>(transaction.status).toBe('PENDING_REFERENCE');
  expect(transaction.failureCode).toBeUndefined();
  expect(transaction.balanceAfter).toBeUndefined();
  expect(transaction.processedAt).toBeUndefined();
  expect(target.balance.toJSON()).toEqual(brl(INITIAL_BALANCE).toJSON());
  expect(target.version).toBe(INITIAL_VERSION);
};

const catchError = (run: () => unknown): unknown => {
  let error: unknown;
  try {
    run();
  } catch (e) {
    error = e;
  }
  return error;
};

describe('WagerApplicationPolicy', () => {
  describe('§7 table', () => {
    it('BET debits the wallet with one DEBIT entry', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Bet);

      const outcome = apply(t, w);

      expectApplied(outcome, t, w, { direction: 'DEBIT', from: '100.00', to: '20.00' });
    });

    it('WIN credits the wallet with one CREDIT entry', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Win);

      const outcome = apply(t, w);

      expectApplied(outcome, t, w, { direction: 'CREDIT', from: '100.00', to: '180.00' });
    });

    it.each(['80.00', '0.00'])(
      'LOSS of %s is PROCESSED without entry, and balance and version stay untouched',
      (amount) => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Loss, { money: brl(amount) });

        const outcome = apply(t, w);

        expectRecorded(outcome, t, w);
      },
    );

    it('REFUND of a PROCESSED BET credits the wallet with one CREDIT entry', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Refund);
      const bet = ref(WagerTransactionKind.Bet);

      const outcome = apply(t, w, { reference: bet });

      expectApplied(outcome, t, w, {
        direction: 'CREDIT',
        from: '100.00',
        to: '180.00',
        referenceId: 'ref-1',
      });
    });

    it.each<[WagerTransactionKind, string, string]>([
      [WagerTransactionKind.Bet, 'CREDIT', '180.00'],
      [WagerTransactionKind.Win, 'DEBIT', '20.00'],
      [WagerTransactionKind.Refund, 'DEBIT', '20.00'],
    ])('ROLLBACK of a PROCESSED %s writes a %s entry', (referenceKind, direction, to) => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Rollback);

      const outcome = apply(t, w, { reference: ref(referenceKind) });

      expectApplied(outcome, t, w, { direction, from: '100.00', to, referenceId: 'ref-1' });
    });
  });

  describe('regras adicionais', () => {
    describe('regra 1: REFUND e ROLLBACK exigem referência', () => {
      it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
        '%s without reference cannot even be created',
        (kind) => {
          const error = catchError(() => tx(kind, { referenceExternalTransactionId: undefined }));

          expect(error).toBeInstanceOf(ReferenceRequiredError);
          expect<string>((error as ReferenceRequiredError).code).toBe('REFERENCE_REQUIRED');
        },
      );
    });

    describe('regra 2: mesma origem da referência', () => {
      const fields: Array<[string, Partial<WagerTransactionState>]> = [
        ['provider', { providerId: 'provider-b' }],
        ['player', { playerId: 'player-2' }],
        ['wallet', { walletId: 'wallet-2' }],
        ['currency', { money: usd('80.00') }],
        ['round', { roundId: 'round-2' }],
      ];
      const cases = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].flatMap(
        (kind) =>
          fields.map(
            ([field, change]): [WagerTransactionKind, string, Partial<WagerTransactionState>] => [
              kind,
              field,
              change,
            ],
          ),
      );

      it.each(cases)('rejects %s whose reference has another %s', (kind, _field, change) => {
        const w = wallet();
        const t = tx(kind);

        const outcome = apply(t, w, { reference: ref(WagerTransactionKind.Bet, change) });

        expectRejected(outcome, t, w, 'REFERENCE_MISMATCH');
      });
    });

    describe('regra 3: kinds de referência permitidos', () => {
      it.each<[WagerTransactionKind, WagerTransactionKind]>([
        [WagerTransactionKind.Refund, WagerTransactionKind.Win],
        [WagerTransactionKind.Refund, WagerTransactionKind.Loss],
        [WagerTransactionKind.Refund, WagerTransactionKind.Refund],
        [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
        [WagerTransactionKind.Refund, WagerTransactionKind.Opening],
        [WagerTransactionKind.Rollback, WagerTransactionKind.Loss],
        [WagerTransactionKind.Rollback, WagerTransactionKind.Rollback],
        [WagerTransactionKind.Rollback, WagerTransactionKind.Opening],
      ])('rejects %s referencing %s', (kind, referenceKind) => {
        const w = wallet();
        const t = tx(kind);

        const outcome = apply(t, w, { reference: ref(referenceKind) });

        expectRejected(outcome, t, w, 'INVALID_REFERENCE_KIND');
      });
    });

    describe('regra 4: reversão única por tipo', () => {
      it.each([WagerTransactionKind.Win, WagerTransactionKind.Refund])(
        'rejects a second ROLLBACK of a %s',
        (referenceKind) => {
          const w = wallet();
          const t = tx(WagerTransactionKind.Rollback);

          const outcome = apply(t, w, {
            reference: ref(referenceKind),
            reversalsOfReference: [reversal(WagerTransactionKind.Rollback, 'rb-1')],
          });

          expectRejected(outcome, t, w, 'ALREADY_REVERSED');
        },
      );

      it('rejects a second REFUND of the same BET', () => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Refund);

        const outcome = apply(t, w, {
          reference: ref(WagerTransactionKind.Bet),
          reversalsOfReference: [reversal(WagerTransactionKind.Refund, 'rf-1')],
        });

        expectRejected(outcome, t, w, 'ALREADY_REVERSED');
      });

      it('rejects a second ROLLBACK of the same BET', () => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Rollback);

        const outcome = apply(t, w, {
          reference: ref(WagerTransactionKind.Bet),
          reversalsOfReference: [reversal(WagerTransactionKind.Rollback, 'rb-1')],
        });

        expectRejected(outcome, t, w, 'ALREADY_REVERSED');
      });

      it('rejects ROLLBACK of a BET that already has a PROCESSED REFUND (no double credit)', () => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Rollback);

        const outcome = apply(t, w, {
          reference: ref(WagerTransactionKind.Bet),
          reversalsOfReference: [reversal(WagerTransactionKind.Refund, 'rf-1')],
        });

        expectRejected(outcome, t, w, 'ALREADY_REVERSED');
      });

      it('rejects REFUND of a BET that already has a PROCESSED ROLLBACK (no double credit)', () => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Refund);

        const outcome = apply(t, w, {
          reference: ref(WagerTransactionKind.Bet),
          reversalsOfReference: [reversal(WagerTransactionKind.Rollback, 'rb-1')],
        });

        expectRejected(outcome, t, w, 'ALREADY_REVERSED');
      });

      it('does not block ROLLBACK of a BET because of a PROCESSED WIN pointing at that BET', () => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Rollback);

        const outcome = apply(t, w, {
          reference: ref(WagerTransactionKind.Bet),
          reversalsOfReference: [reversal(WagerTransactionKind.Win, 'win-1')],
        });

        expectApplied(outcome, t, w, {
          direction: 'CREDIT',
          from: '100.00',
          to: '180.00',
          referenceId: 'ref-1',
        });
      });

      it('does not block REFUND after a REJECTED REFUND', () => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Refund);

        const outcome = apply(t, w, {
          reference: ref(WagerTransactionKind.Bet),
          reversalsOfReference: [rejectedReversal(WagerTransactionKind.Refund, 'rf-1')],
        });

        expectApplied(outcome, t, w, {
          direction: 'CREDIT',
          from: '100.00',
          to: '180.00',
          referenceId: 'ref-1',
        });
      });

      it('does not count the transaction itself among the reversals', () => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Refund);
        const staleCopy = reversal(WagerTransactionKind.Refund, t.id);

        const outcome = apply(t, w, {
          reference: ref(WagerTransactionKind.Bet),
          reversalsOfReference: [staleCopy],
        });

        expectApplied(outcome, t, w, {
          direction: 'CREDIT',
          from: '100.00',
          to: '180.00',
          referenceId: 'ref-1',
        });
      });
    });

    describe('regra 5: valor igual ao da referência', () => {
      it.each([
        [WagerTransactionKind.Refund, '50.00'],
        [WagerTransactionKind.Refund, '80.01'],
        [WagerTransactionKind.Rollback, '50.00'],
        [WagerTransactionKind.Rollback, '80.01'],
      ])('rejects %s of %s against a reference of 80.00', (kind, amount) => {
        const w = wallet();
        const t = tx(kind, { money: brl(amount) });

        const outcome = apply(t, w, { reference: ref(WagerTransactionKind.Bet) });

        expectRejected(outcome, t, w, 'REFERENCE_AMOUNT_MISMATCH');
      });
    });

    describe('regra 6: REJECTED nunca gera lançamento nem altera a wallet', () => {
      interface Scenario {
        transaction: WagerTransaction;
        target: Wallet;
        balance: string;
        overrides?: Overrides;
      }

      const scenarios: Array<[string, () => Scenario]> = [
        [
          'BET without funds',
          () => ({
            transaction: tx(WagerTransactionKind.Bet, { money: brl('150.00') }),
            target: wallet(),
            balance: '100.00',
          }),
        ],
        [
          'ROLLBACK of a WIN without funds',
          () => ({
            transaction: tx(WagerTransactionKind.Rollback),
            target: wallet('50.00'),
            balance: '50.00',
            overrides: { reference: ref(WagerTransactionKind.Win) },
          }),
        ],
        [
          'REFUND with another amount',
          () => ({
            transaction: tx(WagerTransactionKind.Refund, { money: brl('10.00') }),
            target: wallet(),
            balance: '100.00',
            overrides: { reference: ref(WagerTransactionKind.Bet) },
          }),
        ],
        [
          'REFUND already reversed',
          () => ({
            transaction: tx(WagerTransactionKind.Refund),
            target: wallet(),
            balance: '100.00',
            overrides: {
              reference: ref(WagerTransactionKind.Bet),
              reversalsOfReference: [reversal(WagerTransactionKind.Refund, 'rf-1')],
            },
          }),
        ],
        [
          'ROLLBACK with a reference from another round',
          () => ({
            transaction: tx(WagerTransactionKind.Rollback),
            target: wallet(),
            balance: '100.00',
            overrides: { reference: ref(WagerTransactionKind.Bet, { roundId: 'round-2' }) },
          }),
        ],
      ];

      it.each(scenarios)('%s', (_name, build) => {
        const { transaction, target, balance, overrides } = build();

        const outcome = apply(transaction, target, overrides);

        expect<string>(outcome.decision).toBe('REJECTED');
        expect(outcome.ledgerEntry).toBeNull();
        expect<string>(transaction.status).toBe('REJECTED');
        expect(target.balance.toJSON()).toEqual(brl(balance).toJSON());
        expect(target.version).toBe(INITIAL_VERSION);
      });
    });

    describe('regra 7: o resultado devolve o saldo observado e a decisão é terminal', () => {
      it('stores the new balance when applied and the unchanged one when rejected', () => {
        const applied = tx(WagerTransactionKind.Bet);
        const rejected = tx(WagerTransactionKind.Bet, { money: brl('500.00') });
        const w = wallet();

        apply(applied, w);
        apply(rejected, w, { ledgerEntryId: 'entry-2' });

        expect(applied.balanceAfter?.toJSON()).toEqual(brl('20.00').toJSON());
        expect(rejected.balanceAfter?.toJSON()).toEqual(brl('20.00').toJSON());
      });

      it.each(['applied', 'rejected'])(
        'a second apply on a transaction that was %s throws and does not touch the wallet',
        (decision) => {
          const w = wallet();
          const t = tx(WagerTransactionKind.Bet, {
            money: brl(decision === 'applied' ? '80.00' : '500.00'),
          });
          apply(t, w);
          const balance = w.balance.toJSON();
          const version = w.version;
          const status = t.status;

          const error = catchError(() => apply(t, w, { ledgerEntryId: 'entry-2' }));

          expect(error).toBeInstanceOf(InvalidTransactionStateError);
          expect<string>((error as InvalidTransactionStateError).code).toBe('INVARIANT_VIOLATION');
          expect(w.balance.toJSON()).toEqual(balance);
          expect(w.version).toBe(version);
          expect(t.status).toBe(status);
        },
      );
    });

    describe('regra 8: referência ainda não recebida', () => {
      it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
        '%s whose reference was not found becomes PENDING_REFERENCE without entry',
        (kind) => {
          const w = wallet();
          const t = tx(kind);

          const outcome = apply(t, w, { reference: null });

          expectAwaiting(outcome, t, w);
        },
      );
    });

    describe('regra 9: reversão que deixaria saldo negativo', () => {
      it.each([WagerTransactionKind.Win, WagerTransactionKind.Refund])(
        'rejects ROLLBACK of a %s with REVERSAL_INSUFFICIENT_FUNDS when balance is below the amount',
        (referenceKind) => {
          const w = wallet('79.99');
          const t = tx(WagerTransactionKind.Rollback);

          const outcome = apply(t, w, { reference: ref(referenceKind) });

          expectRejected(outcome, t, w, 'REVERSAL_INSUFFICIENT_FUNDS', { balance: '79.99' });
        },
      );

      it('rejects BET without funds with INSUFFICIENT_FUNDS, a code distinct from the reversal one', () => {
        const betWallet = wallet('79.99');
        const bet = tx(WagerTransactionKind.Bet);
        const rollbackWallet = wallet('79.99');
        const rollback = tx(WagerTransactionKind.Rollback);

        const betOutcome = apply(bet, betWallet);
        const rollbackOutcome = apply(rollback, rollbackWallet, {
          reference: ref(WagerTransactionKind.Win),
        });

        expectRejected(betOutcome, bet, betWallet, 'INSUFFICIENT_FUNDS', { balance: '79.99' });
        expect(bet.failureCode).not.toBe(rollback.failureCode);
        expect<string | undefined>(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
        expect<string>(rollbackOutcome.decision).toBe('REJECTED');
      });

      it('applies the reversal when the balance is exactly the amount', () => {
        const w = wallet('80.00');
        const t = tx(WagerTransactionKind.Rollback);

        const outcome = apply(t, w, { reference: ref(WagerTransactionKind.Win) });

        expect<string>(outcome.decision).toBe('APPLIED');
        expect(w.balance.toJSON()).toEqual(brl('0.00').toJSON());
        expect(t.balanceAfter?.toJSON()).toEqual(brl('0.00').toJSON());
      });

      it('never needs funds for a credit: ROLLBACK of a BET on an empty wallet applies', () => {
        const w = wallet('0.00');
        const t = tx(WagerTransactionKind.Rollback);

        const outcome = apply(t, w, { reference: ref(WagerTransactionKind.Bet) });

        expect<string>(outcome.decision).toBe('APPLIED');
        expect(w.balance.toJSON()).toEqual(brl('80.00').toJSON());
      });
    });
  });

  describe('referência em WIN e LOSS', () => {
    it('WIN referencing a PROCESSED BET is applied and keeps the reference id', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Win, { referenceExternalTransactionId: 'ext-ref' });

      const outcome = apply(t, w, { reference: ref(WagerTransactionKind.Bet) });

      expectApplied(outcome, t, w, {
        direction: 'CREDIT',
        from: '100.00',
        to: '180.00',
        referenceId: 'ref-1',
      });
    });

    it('WIN does not need the same amount as the BET, nor is it blocked by reversals', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Win, {
        referenceExternalTransactionId: 'ext-ref',
        money: brl('160.00'),
      });

      const outcome = apply(t, w, {
        reference: ref(WagerTransactionKind.Bet),
        reversalsOfReference: [reversal(WagerTransactionKind.Refund, 'rf-1')],
      });

      expectApplied(outcome, t, w, {
        direction: 'CREDIT',
        from: '100.00',
        to: '260.00',
        referenceId: 'ref-1',
      });
    });

    it('WIN whose BET was not received yet becomes PENDING_REFERENCE', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Win, { referenceExternalTransactionId: 'ext-ref' });

      const outcome = apply(t, w, { reference: null });

      expectAwaiting(outcome, t, w);
    });

    it('WIN referencing a BET from another round is rejected with REFERENCE_MISMATCH', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Win, { referenceExternalTransactionId: 'ext-ref' });

      const outcome = apply(t, w, { reference: ref(WagerTransactionKind.Bet, { roundId: 'round-2' }) });

      expectRejected(outcome, t, w, 'REFERENCE_MISMATCH');
    });

    it('WIN referencing a WIN is rejected with INVALID_REFERENCE_KIND', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Win, { referenceExternalTransactionId: 'ext-ref' });

      const outcome = apply(t, w, { reference: ref(WagerTransactionKind.Win) });

      expectRejected(outcome, t, w, 'INVALID_REFERENCE_KIND');
    });

    it('WIN referencing a REJECTED BET is rejected with REFERENCE_NOT_PROCESSED', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Win, { referenceExternalTransactionId: 'ext-ref' });

      const outcome = apply(t, w, { reference: rejectedRef(WagerTransactionKind.Bet) });

      expectRejected(outcome, t, w, 'REFERENCE_NOT_PROCESSED');
    });

    it('LOSS referencing a PROCESSED BET is recorded and keeps the reference id', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Loss, { referenceExternalTransactionId: 'ext-ref' });

      const outcome = apply(t, w, { reference: ref(WagerTransactionKind.Bet) });

      expectRecorded(outcome, t, w, 'ref-1');
    });

    it('WIN and LOSS without reference ignore any reference handed in', () => {
      const win = tx(WagerTransactionKind.Win);
      const loss = tx(WagerTransactionKind.Loss);
      const w = wallet();

      const winOutcome = apply(win, w, { reference: ref(WagerTransactionKind.Bet) });
      const lossOutcome = apply(loss, w, {
        reference: ref(WagerTransactionKind.Bet),
        ledgerEntryId: 'entry-2',
      });

      expect<string>(winOutcome.decision).toBe('APPLIED');
      expect(win.referenceTransactionId).toBeUndefined();
      expect<string>(lossOutcome.decision).toBe('RECORDED');
      expect(loss.referenceTransactionId).toBeUndefined();
    });

    it.each<[string, WagerTransaction | null]>([
      ['not found', null],
      ['a PROCESSED BET', ref(WagerTransactionKind.Bet)],
    ])(
      'BET carrying a reference is rejected with INVALID_REFERENCE_KIND even when the reference is %s',
      (_case, reference) => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Bet, { referenceExternalTransactionId: 'ext-ref' });

        const outcome = apply(t, w, { reference });

        expectRejected(outcome, t, w, 'INVALID_REFERENCE_KIND');
      },
    );
  });

  describe('wallet', () => {
    it('rejects with WALLET_NOT_FOUND and exposes no balance', () => {
      const t = tx(WagerTransactionKind.Bet);

      const outcome = apply(t, null);

      expectRejected(outcome, t, null, 'WALLET_NOT_FOUND', { observed: null });
    });

    it('rejects a wallet of another player with WALLET_PLAYER_MISMATCH and exposes no balance', () => {
      const w = wallet(INITIAL_BALANCE, { playerId: 'player-2' });
      const t = tx(WagerTransactionKind.Bet);

      const outcome = apply(t, w);

      expectRejected(outcome, t, w, 'WALLET_PLAYER_MISMATCH', { observed: null });
    });

    it('rejects a wallet of another currency with CURRENCY_MISMATCH and exposes no balance', () => {
      const w = wallet(INITIAL_BALANCE, { currency: 'USD', balance: usd(INITIAL_BALANCE) });
      const t = tx(WagerTransactionKind.Bet);

      const outcome = apply(t, w);

      expect<unknown>(outcome).toEqual({
        decision: 'REJECTED',
        failureCode: 'CURRENCY_MISMATCH',
        ledgerEntry: null,
      });
      expect<string>(t.status).toBe('REJECTED');
      expect(t.balanceAfter).toBeUndefined();
      expect(w.balance.toJSON()).toEqual(usd(INITIAL_BALANCE).toJSON());
      expect(w.version).toBe(INITIAL_VERSION);
    });
  });

  describe('ordem das checagens', () => {
    it('checks the wallet before the reference', () => {
      const t = tx(WagerTransactionKind.Refund);

      const outcome = apply(t, null, { reference: null });

      expectRejected(outcome, t, null, 'WALLET_NOT_FOUND', { observed: null });
    });

    it('checks the origin of the reference before its kind', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Refund);

      const outcome = apply(t, w, {
        reference: ref(WagerTransactionKind.Win, { roundId: 'round-2' }),
      });

      expectRejected(outcome, t, w, 'REFERENCE_MISMATCH');
    });

    it('checks the kind of the reference before its status', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Refund);

      const outcome = apply(t, w, { reference: rejectedRef(WagerTransactionKind.Win) });

      expectRejected(outcome, t, w, 'INVALID_REFERENCE_KIND');
    });

    it('checks the status of the reference before the amount', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Refund, { money: brl('50.00') });

      const outcome = apply(t, w, { reference: rejectedRef(WagerTransactionKind.Bet) });

      expectRejected(outcome, t, w, 'REFERENCE_NOT_PROCESSED');
    });

    it('checks the amount before the double reversal', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Refund, { money: brl('50.00') });

      const outcome = apply(t, w, {
        reference: ref(WagerTransactionKind.Bet),
        reversalsOfReference: [reversal(WagerTransactionKind.Refund, 'rf-1')],
      });

      expectRejected(outcome, t, w, 'REFERENCE_AMOUNT_MISMATCH');
    });

    it('checks the double reversal before the balance', () => {
      const w = wallet('10.00');
      const t = tx(WagerTransactionKind.Rollback);

      const outcome = apply(t, w, {
        reference: ref(WagerTransactionKind.Win),
        reversalsOfReference: [reversal(WagerTransactionKind.Rollback, 'rb-1')],
      });

      expectRejected(outcome, t, w, 'ALREADY_REVERSED', { balance: '10.00' });
    });
  });

  describe('referência pendente', () => {
    it.each([WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference])(
      'waits while the reference is %s',
      (status) => {
        const w = wallet();
        const t = tx(WagerTransactionKind.Refund);

        const outcome = apply(t, w, { reference: undecidedRef(WagerTransactionKind.Bet, status) });

        expectAwaiting(outcome, t, w);
      },
    );

    it('applies a PENDING_REFERENCE transaction once its reference arrives (worker path)', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Refund);

      const first = apply(t, w, { reference: null });
      const second = apply(t, w, { reference: ref(WagerTransactionKind.Bet) });

      expect<string>(first.decision).toBe('AWAITING_REFERENCE');
      expectApplied(second, t, w, {
        direction: 'CREDIT',
        from: '100.00',
        to: '180.00',
        referenceId: 'ref-1',
      });
    });

    it('keeps waiting on repeated evaluations without the reference', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Rollback);

      apply(t, w, { reference: null });
      const again = apply(t, w, { reference: null });

      expectAwaiting(again, t, w);
    });

    it.each([
      ['REJECTED', rejectedRef],
      ['FAILED', failedRef],
    ])('rejects with REFERENCE_NOT_PROCESSED when the reference ended %s', (_status, build) => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Refund);

      const outcome = apply(t, w, { reference: build(WagerTransactionKind.Bet) });

      expectRejected(outcome, t, w, 'REFERENCE_NOT_PROCESSED');
    });
  });

  describe('erros de programação', () => {
    it.each<[string, () => WagerTransaction]>([
      [
        'PROCESSED',
        () => {
          const t = tx(WagerTransactionKind.Bet);
          t.markProcessed({ at: AT, balanceAfter: brl('20.00') });
          return t;
        },
      ],
      [
        'REJECTED',
        () => {
          const t = tx(WagerTransactionKind.Bet);
          t.reject(FailureCode.InsufficientFunds, brl('50.00'));
          return t;
        },
      ],
      [
        'FAILED',
        () => {
          const t = tx(WagerTransactionKind.Bet);
          t.fail(FailureCode.PermanentFailure);
          return t;
        },
      ],
    ])('throws InvalidTransactionStateError for a %s transaction and leaves the wallet intact', (_status, build) => {
      const w = wallet();
      const t = build();
      const status = t.status;

      const error = catchError(() => apply(t, w));

      expect(error).toBeInstanceOf(InvalidTransactionStateError);
      expect(t.status).toBe(status);
      expect(w.balance.toJSON()).toEqual(brl(INITIAL_BALANCE).toJSON());
      expect(w.version).toBe(INITIAL_VERSION);
    });

    it('throws InvalidWagerTransactionError when the wallet is not the transaction wallet', () => {
      const w = wallet(INITIAL_BALANCE, { id: 'wallet-2' });
      const t = tx(WagerTransactionKind.Bet);

      const error = catchError(() => apply(t, w));

      expect(error).toBeInstanceOf(InvalidWagerTransactionError);
      expect<string>(t.status).toBe('PENDING');
      expect(w.balance.toJSON()).toEqual(brl(INITIAL_BALANCE).toJSON());
      expect(w.version).toBe(INITIAL_VERSION);
    });

    it('throws InvalidWagerTransactionError when the reference was resolved for another id', () => {
      const w = wallet();
      const t = tx(WagerTransactionKind.Refund);

      const error = catchError(() =>
        apply(t, w, {
          reference: ref(WagerTransactionKind.Bet, { externalTransactionId: 'ext-other' }),
        }),
      );

      expect(error).toBeInstanceOf(InvalidWagerTransactionError);
      expect<string>(t.status).toBe('PENDING');
      expect(w.balance.toJSON()).toEqual(brl(INITIAL_BALANCE).toJSON());
      expect(w.version).toBe(INITIAL_VERSION);
    });

    it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
      'throws InvalidWagerTransactionError for a rehydrated %s without reference and leaves the wallet intact',
      (kind) => {
        const w = wallet();
        const t = undecidedRef(kind, WagerTransactionStatus.Pending);

        const error = catchError(() => apply(t, w, { reference: ref(WagerTransactionKind.Bet) }));

        expect(error).toBeInstanceOf(InvalidWagerTransactionError);
        expect<string>(t.status).toBe('PENDING');
        expect(w.balance.toJSON()).toEqual(brl(INITIAL_BALANCE).toJSON());
        expect(w.version).toBe(INITIAL_VERSION);
      },
    );
  });

  describe('cenário do §8', () => {
    it('wallet 100.00 and two BETs of 80.00 in sequence: 1 applied, 1 rejected, balance 20.00, 1 DEBIT entry', () => {
      const w = wallet();
      const first = tx(WagerTransactionKind.Bet, {
        id: 'tx-bet-1',
        externalTransactionId: 'ext-bet-1',
        idempotencyKey: 'provider-a:ext-bet-1',
      });
      const second = tx(WagerTransactionKind.Bet, {
        id: 'tx-bet-2',
        externalTransactionId: 'ext-bet-2',
        idempotencyKey: 'provider-a:ext-bet-2',
      });

      const outcomes = [
        apply(first, w, { ledgerEntryId: 'entry-1' }),
        apply(second, w, { ledgerEntryId: 'entry-2' }),
      ];

      expect<string[]>(outcomes.map((outcome) => outcome.decision)).toEqual(['APPLIED', 'REJECTED']);
      expect<unknown>(outcomes[1]).toEqual({
        decision: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        ledgerEntry: null,
      });
      const entries = outcomes.flatMap((outcome) =>
        outcome.ledgerEntry === null ? [] : [outcome.ledgerEntry],
      );
      expect(entries).toHaveLength(1);
      expect<string | undefined>(entries[0]?.direction).toBe('DEBIT');
      expect(entries[0]?.transactionId).toBe('tx-bet-1');
      expect<string>(first.status).toBe('PROCESSED');
      expect<string>(second.status).toBe('REJECTED');
      expect(second.balanceAfter?.toJSON()).toEqual(brl('20.00').toJSON());
      expect(w.balance.toJSON()).toEqual(brl('20.00').toJSON());
      expect(w.version).toBe(INITIAL_VERSION + 1);
    });
  });
});
