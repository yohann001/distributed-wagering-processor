import { describe, expect, it } from 'bun:test';

import { classifyConcurrencyConflict } from '../../../../src/infrastructure/database/mikro-orm-unit-of-work';
import {
  ConcurrencyConflictError,
  ConcurrencyConflictReason,
} from '../../../../src/shared/application/unit-of-work';
import { FailureAction, FailureCode } from '../../../../src/shared/domain/failure-code';

describe('classifyConcurrencyConflict', () => {
  it.each([
    ['40P01', ConcurrencyConflictReason.Deadlock],
    ['40001', ConcurrencyConflictReason.SerializationFailure],
    ['55P03', ConcurrencyConflictReason.LockTimeout],
  ])('maps SQLSTATE %s to %s', (code, reason) => {
    const conflict = classifyConcurrencyConflict({ code });

    expect(conflict).toBeInstanceOf(ConcurrencyConflictError);
    expect(conflict?.reason).toBe(reason);
    expect(conflict?.message).toContain(`SQLSTATE ${code}`);
  });

  it('returns an existing ConcurrencyConflictError as is', () => {
    const original = new ConcurrencyConflictError(ConcurrencyConflictReason.VersionConflict, 'test');

    expect(classifyConcurrencyConflict(original)).toBe(original);
  });

  it.each([
    ['unique violation', { code: '23505' }],
    ['plain error', new Error('x')],
    ['null', null],
    ['undefined', undefined],
    ['bare SQLSTATE string', '40P01'],
    ['non-string code', { code: 40001 }],
  ])('returns null for %s', (_name, error) => {
    expect(classifyConcurrencyConflict(error)).toBeNull();
  });

  it('flags the mapped error as a retryable transient failure', () => {
    const conflict = classifyConcurrencyConflict({ code: '40P01' });

    expect(conflict).not.toBeNull();
    expect<string | undefined>(conflict?.code).toBe(FailureCode.TransientFailure);
    expect(conflict?.action).toBe(FailureAction.Retry);
  });
});
