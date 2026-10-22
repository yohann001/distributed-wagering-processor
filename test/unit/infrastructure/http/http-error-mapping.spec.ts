import { describe, expect, it } from 'bun:test';

import { BadRequestException, NotFoundException } from '@nestjs/common';

import { InvalidRequestError, ResourceNotFoundError } from '../../../../src/infrastructure/http/http-errors';
import {
  HTTP_STATUS_BY_FAILURE_CODE,
  RETRY_AFTER_SECONDS,
  mapErrorToHttp,
} from '../../../../src/infrastructure/http/http-error-mapping';
import {
  InboxMessageAlreadyExistsError,
  InboxMessageConflictError,
} from '../../../../src/modules/messaging/domain/inbox-message';
import {
  IdempotencyConflictError,
  KindNotAllowedError,
  ReferenceRequiredError,
  WagerTransactionAlreadyExistsError,
} from '../../../../src/modules/wagering/domain/wager-transaction';
import { WalletAlreadyExistsError } from '../../../../src/modules/wallet/domain/wallet';
import {
  ConcurrencyConflictError,
  ConcurrencyConflictReason,
} from '../../../../src/shared/application/unit-of-work';
import { InvalidTransactionStateError } from '../../../../src/shared/domain/domain-error';
import { FailureAction, FailureCode } from '../../../../src/shared/domain/failure-code';
import { InvalidMoneyError } from '../../../../src/shared/domain/money';

describe('mapErrorToHttp', () => {
  it('maps an InvalidRequestError to 400 with its issues', () => {
    const issues = [{ path: 'body.playerId', message: 'Invalid input' }];

    const mapped = mapErrorToHttp(new InvalidRequestError(issues));

    expect(mapped.status).toBe(400);
    expect(mapped.body).toEqual({
      failureCode: FailureCode.InvalidPayload,
      action: FailureAction.FixPayload,
      message: 'Invalid request',
      issues,
    });
    expect(mapped.logLevel).toBe('none');
  });

  it.each([
    ['InvalidMoneyError', new InvalidMoneyError('amount must be a decimal string'), FailureCode.InvalidMoney],
    ['KindNotAllowedError', new KindNotAllowedError('OPENING'), FailureCode.KindNotAllowed],
    ['ReferenceRequiredError', new ReferenceRequiredError('REFUND'), FailureCode.ReferenceRequired],
  ])('maps %s to 400', (_name, error, failureCode) => {
    const mapped = mapErrorToHttp(error);

    expect(mapped.status).toBe(400);
    expect(mapped.body.failureCode).toBe(failureCode);
    expect(mapped.body.issues).toBeUndefined();
  });

  it('maps an idempotency conflict to 409 without leaking the key', () => {
    const mapped = mapErrorToHttp(new IdempotencyConflictError('provider-1', 'secret-key-123'));

    expect(mapped.status).toBe(409);
    expect(mapped.body.failureCode).toBe(FailureCode.IdempotencyConflict);
    expect(mapped.body.message).not.toContain('secret-key-123');
  });

  it('maps an inbox conflict to 409', () => {
    const mapped = mapErrorToHttp(new InboxMessageConflictError('consumer', 'message-1'));

    expect(mapped.status).toBe(409);
    expect(mapped.body.failureCode).toBe(FailureCode.IdempotencyConflict);
  });

  it('maps a duplicate wallet to 409 with a code distinct from the idempotency conflict', () => {
    const mapped = mapErrorToHttp(new WalletAlreadyExistsError('player-1', 'BRL'));

    expect(mapped.status).toBe(409);
    expect(mapped.body.failureCode).toBe(FailureCode.WalletAlreadyExists);
    expect(mapped.body.action).toBe(FailureAction.GiveUp);
  });

  it.each([FailureCode.WalletNotFound, FailureCode.TransactionNotFound] as const)(
    'maps a ResourceNotFoundError(%s) to 404 without naming the id',
    (code) => {
      const mapped = mapErrorToHttp(new ResourceNotFoundError(code, 'thing'));

      expect(mapped.status).toBe(404);
      expect(mapped.body.failureCode).toBe(code);
      expect(mapped.body.message).toBe('thing not found');
    },
  );

  it('maps a concurrency conflict to 503 with Retry-After', () => {
    const mapped = mapErrorToHttp(new ConcurrencyConflictError(ConcurrencyConflictReason.LockTimeout, 'x'));

    expect(mapped.status).toBe(503);
    expect(mapped.retryAfterSeconds).toBe(RETRY_AFTER_SECONDS);
    expect(mapped.body.failureCode).toBe(FailureCode.TransientFailure);
    expect(mapped.body.action).toBe(FailureAction.Retry);
    expect(mapped.logLevel).toBe('warn');
  });

  it.each([
    ['WagerTransactionAlreadyExistsError', new WagerTransactionAlreadyExistsError('provider-1', 'uq')],
    ['InboxMessageAlreadyExistsError', new InboxMessageAlreadyExistsError('consumer', 'message-1')],
    ['a connection failure SQLSTATE', { code: '08006' }],
  ])('maps %s to 503 with Retry-After', (_name, error) => {
    const mapped = mapErrorToHttp(error);

    expect(mapped.status).toBe(503);
    expect(mapped.retryAfterSeconds).toBe(RETRY_AFTER_SECONDS);
    expect(mapped.body.failureCode).toBe(FailureCode.TransientFailure);
  });

  it('maps a programming error from the domain to 500 with a generic message', () => {
    const mapped = mapErrorToHttp(new InvalidTransactionStateError('tx-1', 'PROCESSED', 'reject'));

    expect(mapped.status).toBe(500);
    expect(mapped.body.failureCode).toBe(FailureCode.InvariantViolation);
    expect(mapped.body.message).toBe('Internal error');
    expect(mapped.logLevel).toBe('error');
  });

  it('maps an unknown error to 500 without echoing its message', () => {
    const mapped = mapErrorToHttp(new Error('secret'));

    expect(mapped.status).toBe(500);
    expect(mapped.body.failureCode).toBe(FailureCode.InvariantViolation);
    expect(mapped.body.message).not.toContain('secret');
    expect(mapped.logLevel).toBe('error');
  });

  it('maps a malformed-body framework error to 400 without echoing the framework message', () => {
    const mapped = mapErrorToHttp(new BadRequestException('Unexpected token'));

    expect(mapped.status).toBe(400);
    expect(mapped.body.failureCode).toBe(FailureCode.InvalidPayload);
    expect(mapped.body.message).not.toContain('Unexpected');
    expect(mapped.logLevel).toBe('none');
  });

  it('maps an unknown route to 404 with INVALID_PAYLOAD', () => {
    const mapped = mapErrorToHttp(new NotFoundException());

    expect(mapped.status).toBe(404);
    expect(mapped.body.failureCode).toBe(FailureCode.InvalidPayload);
    expect(mapped.body.message).toBe('Route not found');
  });
});

describe('HTTP_STATUS_BY_FAILURE_CODE', () => {
  it.each(Object.values(FailureCode))('has a valid HTTP status for %s', (code) => {
    const status = HTTP_STATUS_BY_FAILURE_CODE[code];

    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(600);
  });

  it('has exactly one entry per FailureCode', () => {
    expect(Object.keys(HTTP_STATUS_BY_FAILURE_CODE).sort()).toEqual(Object.values(FailureCode).sort());
  });
});
