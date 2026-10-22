import { describe, expect, it } from 'bun:test';

import {
  InboxMessageAlreadyExistsError,
  InboxMessageConflictError,
} from '../../../../../../src/modules/messaging/domain/inbox-message';
import { classifyConsumerFailure } from '../../../../../../src/modules/messaging/infrastructure/sqs/consumer-failure';
import { InvalidEnvelopeError } from '../../../../../../src/modules/messaging/infrastructure/sqs/wager-transaction-envelope';
import {
  IdempotencyConflictError,
  KindNotAllowedError,
  WagerTransactionAlreadyExistsError,
} from '../../../../../../src/modules/wagering/domain/wager-transaction';
import {
  ConcurrencyConflictError,
  ConcurrencyConflictReason,
} from '../../../../../../src/shared/application/unit-of-work';
import { InvalidTransactionStateError } from '../../../../../../src/shared/domain/domain-error';
import { FailureCode } from '../../../../../../src/shared/domain/failure-code';
import { InvalidMoneyError } from '../../../../../../src/shared/domain/money';

function knexTimeout(): Error {
  const error = new Error('Knex: Timeout acquiring a connection');
  error.name = 'KnexTimeoutError';
  return error;
}

describe('classifyConsumerFailure', () => {
  it.each([
    ['a lock timeout', new ConcurrencyConflictError(ConcurrencyConflictReason.LockTimeout, 'test')],
    ['an inbox primary key race', new InboxMessageAlreadyExistsError('consumer', 'message-1')],
    ['a transaction insert race', new WagerTransactionAlreadyExistsError('provider-1', 'constraint')],
    ['a database shutting down (57P01)', { code: '57P01' }],
    ['a pool acquire timeout', knexTimeout()],
    ['an unknown error, so the retry limit decides before the DLQ', new TypeError('unexpected')],
    ['a value that is not an Error', 'boom'],
  ])('retries %s', (_name, error) => {
    expect(classifyConsumerFailure(error)).toEqual({
      disposition: 'retry',
      failureCode: FailureCode.TransientFailure,
    });
  });

  it.each([
    ['an invalid envelope', new InvalidEnvelopeError([{ path: 'body', message: 'x' }]), FailureCode.InvalidPayload],
    ['a kind that is not allowed', new KindNotAllowedError('OPENING'), FailureCode.KindNotAllowed],
    ['an invalid money', new InvalidMoneyError('amount must be a decimal string'), FailureCode.InvalidMoney],
    [
      'an inbox message with another payload',
      new InboxMessageConflictError('consumer', 'message-1'),
      FailureCode.IdempotencyConflict,
    ],
    [
      'an idempotency conflict',
      new IdempotencyConflictError('provider-1', 'key-1'),
      FailureCode.IdempotencyConflict,
    ],
    [
      'an invariant violation',
      new InvalidTransactionStateError('tx-1', 'PROCESSED', 'reject'),
      FailureCode.InvariantViolation,
    ],
  ])('dead-letters %s with its own failure code', (_name, error, failureCode) => {
    expect(classifyConsumerFailure(error)).toEqual({ disposition: 'dead-letter', failureCode });
  });
});
