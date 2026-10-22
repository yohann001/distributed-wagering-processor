import { describe, expect, it } from 'bun:test';

import {
  FAILURE_ACTIONS,
  FailureAction,
  FailureCode,
  failureActionOf,
} from '../../../../src/shared/domain/failure-code';

const EXPECTED_CLASSIFICATION: ReadonlyArray<readonly [string, FailureAction]> = [
  ['INVALID_PAYLOAD', FailureAction.FixPayload],
  ['INVALID_MONEY', FailureAction.FixPayload],
  ['CURRENCY_MISMATCH', FailureAction.FixPayload],
  ['KIND_NOT_ALLOWED', FailureAction.FixPayload],
  ['REFERENCE_REQUIRED', FailureAction.FixPayload],
  ['IDEMPOTENCY_CONFLICT', FailureAction.FixPayload],
  ['UNAUTHENTICATED', FailureAction.FixPayload],
  ['WALLET_NOT_FOUND', FailureAction.FixPayload],
  ['WALLET_PLAYER_MISMATCH', FailureAction.FixPayload],
  ['WALLET_ALREADY_EXISTS', FailureAction.GiveUp],
  ['TRANSACTION_NOT_FOUND', FailureAction.FixPayload],
  ['INSUFFICIENT_FUNDS', FailureAction.GiveUp],
  ['REVERSAL_INSUFFICIENT_FUNDS', FailureAction.GiveUp],
  ['REFERENCE_NOT_FOUND', FailureAction.FixPayload],
  ['REFERENCE_MISMATCH', FailureAction.FixPayload],
  ['INVALID_REFERENCE_KIND', FailureAction.FixPayload],
  ['REFERENCE_AMOUNT_MISMATCH', FailureAction.FixPayload],
  ['REFERENCE_NOT_PROCESSED', FailureAction.GiveUp],
  ['ALREADY_REVERSED', FailureAction.GiveUp],
  ['TRANSIENT_FAILURE', FailureAction.Retry],
  ['PERMANENT_FAILURE', FailureAction.GiveUp],
  ['INVARIANT_VIOLATION', FailureAction.GiveUp],
];

describe('FailureCode: bet vs reversal insufficient funds', () => {
  it('uses distinct codes for each case', () => {
    expect<string>(FailureCode.InsufficientFunds).toBe('INSUFFICIENT_FUNDS');
    expect<string>(FailureCode.ReversalInsufficientFunds).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(FailureCode.InsufficientFunds).not.toBe(FailureCode.ReversalInsufficientFunds);
  });

  it('classifies both as GIVE_UP', () => {
    expect(failureActionOf(FailureCode.InsufficientFunds)).toBe(FailureAction.GiveUp);
    expect(failureActionOf(FailureCode.ReversalInsufficientFunds)).toBe(FailureAction.GiveUp);
  });
});

describe('FailureCode: stable values', () => {
  it('keeps the exact public list of values', () => {
    expect<string[]>(Object.values(FailureCode).sort()).toEqual(
      [
        'ALREADY_REVERSED',
        'CURRENCY_MISMATCH',
        'IDEMPOTENCY_CONFLICT',
        'INSUFFICIENT_FUNDS',
        'INVALID_MONEY',
        'INVALID_PAYLOAD',
        'INVALID_REFERENCE_KIND',
        'INVARIANT_VIOLATION',
        'KIND_NOT_ALLOWED',
        'PERMANENT_FAILURE',
        'REFERENCE_AMOUNT_MISMATCH',
        'REFERENCE_MISMATCH',
        'REFERENCE_NOT_FOUND',
        'REFERENCE_NOT_PROCESSED',
        'REFERENCE_REQUIRED',
        'REVERSAL_INSUFFICIENT_FUNDS',
        'TRANSACTION_NOT_FOUND',
        'TRANSIENT_FAILURE',
        'UNAUTHENTICATED',
        'WALLET_ALREADY_EXISTS',
        'WALLET_NOT_FOUND',
        'WALLET_PLAYER_MISMATCH',
      ].sort(),
    );
  });

  it.each(Object.values(FailureCode))('%s is SCREAMING_SNAKE_CASE', (code) => {
    expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});

describe('FAILURE_ACTIONS: exhaustive classification', () => {
  it('has exactly one entry per FailureCode', () => {
    expect(Object.keys(FAILURE_ACTIONS).sort()).toEqual(Object.values(FailureCode).sort());
  });

  it.each(Object.values(FailureCode))('%s maps to a valid FailureAction', (code) => {
    expect(Object.values(FailureAction)).toContain(failureActionOf(code));
  });

  it.each(EXPECTED_CLASSIFICATION)('classifies %s as %s', (code, action) => {
    expect(failureActionOf(code as FailureCode)).toBe(action);
  });

  it('covers the whole enum in the expected classification table', () => {
    expect(EXPECTED_CLASSIFICATION.map(([code]) => code).sort()).toEqual(
      Object.values(FailureCode).sort(),
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(FAILURE_ACTIONS)).toBe(true);
  });
});
