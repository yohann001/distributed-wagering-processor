import { describe, expect, it } from 'bun:test';

import { ConnectionException, DriverException } from '@mikro-orm/core';

import { isTransientDatabaseFailure } from '../../../../src/infrastructure/database/mikro-orm-unit-of-work';
import {
  ConcurrencyConflictError,
  ConcurrencyConflictReason,
} from '../../../../src/shared/application/unit-of-work';

describe('isTransientDatabaseFailure', () => {
  it('is true for a ConcurrencyConflictError', () => {
    expect(
      isTransientDatabaseFailure(new ConcurrencyConflictError(ConcurrencyConflictReason.VersionConflict, 'test')),
    ).toBe(true);
  });

  it.each([
    ['deadlock', '40P01'],
    ['lock timeout', '55P03'],
    ['connection failure', '08006'],
    ['too many connections', '53300'],
    ['admin shutdown', '57P01'],
    ['connection refused', 'ECONNREFUSED'],
  ])('is true for %s (%s)', (_name, code) => {
    expect(isTransientDatabaseFailure({ code })).toBe(true);
  });

  it('is true for a pool acquire timeout', () => {
    const error = new Error('Knex: Timeout acquiring a connection');
    error.name = 'KnexTimeoutError';

    expect(isTransientDatabaseFailure(error)).toBe(true);
  });

  it('is true for a pool acquire timeout wrapped by MikroORM, as the read paths receive it', () => {
    const timeout = new Error(
      'Knex: Timeout acquiring a connection. The pool is probably full. Are you missing a .transacting(trx) call?',
    );
    timeout.name = 'KnexTimeoutError';

    // O `driver.rethrow` do MikroORM embrulha o erro: o `name` vira 'DriverException' e não há `code`.
    const wrapped = new DriverException(timeout);

    expect(wrapped.name).toBe('DriverException');
    expect(isTransientDatabaseFailure(wrapped)).toBe(true);
  });

  it('is true for a MikroORM ConnectionException without a SQLSTATE', () => {
    expect(isTransientDatabaseFailure(new ConnectionException(new Error('connect ECONNREFUSED 127.0.0.1:5432')))).toBe(
      true,
    );
  });

  it.each([
    ['unique violation', { code: '23505' }],
    ['invalid text representation', { code: '22P02' }],
    ['plain error', new Error('x')],
    ['null', null],
    ['bare string', 'x'],
    ['non-string code', { code: 8006 }],
  ])('is false for %s', (_name, error) => {
    expect(isTransientDatabaseFailure(error)).toBe(false);
  });
});
