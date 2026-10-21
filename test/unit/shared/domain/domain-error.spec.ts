import { describe, expect, it } from 'bun:test';

import {
  DomainError,
  InvalidTransactionStateError,
} from '../../../../src/shared/domain/domain-error';
import { FailureAction, FailureCode } from '../../../../src/shared/domain/failure-code';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../../src/shared/domain/money';

describe('InvalidTransactionStateError', () => {
  const error = new InvalidTransactionStateError('tx-1', 'PROCESSED', 'reject');

  it('is a DomainError and an Error', () => {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvalidTransactionStateError');
  });

  it('is an invariant violation that must not be retried', () => {
    expect(error.code).toBe(FailureCode.InvariantViolation);
    expect(error.action).toBe(FailureAction.GiveUp);
  });

  it('mentions transaction, status and transition in the message', () => {
    expect(error.message).toContain('tx-1');
    expect(error.message).toContain('PROCESSED');
    expect(error.message).toContain('reject');
  });

  it('exposes its data', () => {
    expect(error.transactionId).toBe('tx-1');
    expect(error.currentStatus).toBe('PROCESSED');
    expect(error.attemptedTransition).toBe('reject');
  });
});

describe('DomainError subclasses from money', () => {
  it('CurrencyMismatchError is a FIX_PAYLOAD DomainError', () => {
    const error = new CurrencyMismatchError('BRL', 'USD');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe(FailureCode.CurrencyMismatch);
    expect(error.action).toBe(FailureAction.FixPayload);
  });

  it('InvalidMoneyError is a DomainError with INVALID_MONEY', () => {
    const error = new InvalidMoneyError('x');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe(FailureCode.InvalidMoney);
    expect(error.action).toBe(FailureAction.FixPayload);
  });
});
