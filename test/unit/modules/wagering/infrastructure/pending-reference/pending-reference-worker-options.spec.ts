import { describe, expect, it } from 'bun:test';

import { loadEnv } from '../../../../../../src/config/env';
import {
  DEFAULT_REFERENCE_RETRY_BACKOFF,
  DEFAULT_REFERENCE_RETRY_MAX_ATTEMPTS,
} from '../../../../../../src/modules/wagering/domain/reference-retry-policy';
import { pendingReferenceWorkerOptionsFromEnv } from '../../../../../../src/modules/wagering/infrastructure/pending-reference/pending-reference-worker-options';

const BASE_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  AWS_REGION: 'us-east-1',
  SQS_WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  SQS_WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wagering-events.fifo',
};

describe('pendingReferenceWorkerOptionsFromEnv', () => {
  it('uses the defaults from a minimal environment, equal to the domain defaults', () => {
    const options = pendingReferenceWorkerOptionsFromEnv(loadEnv(BASE_ENV));

    expect(options).toEqual({
      enabled: true,
      batchSize: 10,
      pollIntervalMs: 1000,
      maxAttempts: 20,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 60000,
    });
    expect(options.maxAttempts).toBe(DEFAULT_REFERENCE_RETRY_MAX_ATTEMPTS);
    expect(options.retryBaseDelayMs).toBe(DEFAULT_REFERENCE_RETRY_BACKOFF.baseDelayMs);
    expect(options.retryMaxDelayMs).toBe(DEFAULT_REFERENCE_RETRY_BACKOFF.maxDelayMs);
  });

  it('turns the worker off with PENDING_REFERENCE_WORKER_ENABLED=false', () => {
    expect(
      pendingReferenceWorkerOptionsFromEnv(loadEnv({ ...BASE_ENV, PENDING_REFERENCE_WORKER_ENABLED: 'false' })).enabled,
    ).toBe(false);
  });

  it('reads the tuning variables', () => {
    const options = pendingReferenceWorkerOptionsFromEnv(
      loadEnv({
        ...BASE_ENV,
        PENDING_REFERENCE_WORKER_BATCH_SIZE: '4',
        PENDING_REFERENCE_WORKER_POLL_INTERVAL_MS: '250',
        PENDING_REFERENCE_MAX_ATTEMPTS: '5',
        PENDING_REFERENCE_RETRY_BASE_DELAY_MS: '50',
        PENDING_REFERENCE_RETRY_MAX_DELAY_MS: '500',
      }),
    );

    expect(options).toEqual({
      enabled: true,
      batchSize: 4,
      pollIntervalMs: 250,
      maxAttempts: 5,
      retryBaseDelayMs: 50,
      retryMaxDelayMs: 500,
    });
  });

  it.each([
    ['a batch above 100', { PENDING_REFERENCE_WORKER_BATCH_SIZE: '101' }],
    ['an empty batch', { PENDING_REFERENCE_WORKER_BATCH_SIZE: '0' }],
    ['a zero poll interval', { PENDING_REFERENCE_WORKER_POLL_INTERVAL_MS: '0' }],
    ['a zero attempt limit', { PENDING_REFERENCE_MAX_ATTEMPTS: '0' }],
    ['an attempt limit above 100', { PENDING_REFERENCE_MAX_ATTEMPTS: '101' }],
    ['a zero base delay', { PENDING_REFERENCE_RETRY_BASE_DELAY_MS: '0' }],
    ['a zero max delay', { PENDING_REFERENCE_RETRY_MAX_DELAY_MS: '0' }],
    ['a non-boolean PENDING_REFERENCE_WORKER_ENABLED', { PENDING_REFERENCE_WORKER_ENABLED: 'maybe' }],
  ])('refuses %s', (_name, extra) => {
    expect(() => loadEnv({ ...BASE_ENV, ...extra })).toThrow('Invalid environment configuration');
  });
});
