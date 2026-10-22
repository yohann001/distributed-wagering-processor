import { describe, expect, it } from 'bun:test';

import { loadEnv } from '../../../../../../src/config/env';
import { sqsConsumerOptionsFromEnv } from '../../../../../../src/modules/messaging/infrastructure/sqs/sqs-consumer-options';

const BASE_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  AWS_REGION: 'us-east-1',
  SQS_WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  SQS_WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wagering-events.fifo',
};

describe('sqsConsumerOptionsFromEnv', () => {
  it('uses the defaults from a minimal environment', () => {
    const options = sqsConsumerOptionsFromEnv(loadEnv(BASE_ENV));

    expect(options.enabled).toBe(true);
    expect(options.queueUrl).toBe(BASE_ENV.SQS_WAGER_QUEUE_URL);
    expect(options.deadLetterQueueUrl).toBe(BASE_ENV.SQS_WAGER_DLQ_URL);
    expect(options.waitTimeSeconds).toBe(20);
    expect(options.batchSize).toBe(10);
    expect(options.maxReceives).toBe(5);
    expect(options.shutdownTimeoutMs).toBe(20000);
    expect(options.retryBackoff.options).toEqual({ baseDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.5 });
  });

  it('turns the consumer off with SQS_CONSUMER_ENABLED=false', () => {
    expect(sqsConsumerOptionsFromEnv(loadEnv({ ...BASE_ENV, SQS_CONSUMER_ENABLED: 'false' })).enabled).toBe(false);
  });

  it('reads the tuning variables', () => {
    const options = sqsConsumerOptionsFromEnv(
      loadEnv({
        ...BASE_ENV,
        SQS_CONSUMER_WAIT_TIME_SECONDS: '5',
        SQS_CONSUMER_BATCH_SIZE: '3',
        SQS_CONSUMER_MAX_RECEIVES: '2',
        SQS_CONSUMER_RETRY_BASE_DELAY_MS: '2000',
        SQS_CONSUMER_RETRY_MAX_DELAY_MS: '8000',
        SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: '1500',
      }),
    );

    expect(options.waitTimeSeconds).toBe(5);
    expect(options.batchSize).toBe(3);
    expect(options.maxReceives).toBe(2);
    expect(options.retryBackoff.options).toEqual({ baseDelayMs: 2000, maxDelayMs: 8000, jitterRatio: 0.5 });
    expect(options.shutdownTimeoutMs).toBe(1500);
  });

  it.each([
    ['a wait time above the SQS limit of 20 s', { SQS_CONSUMER_WAIT_TIME_SECONDS: '21' }],
    ['a batch above the SQS limit of 10', { SQS_CONSUMER_BATCH_SIZE: '11' }],
    ['an empty batch', { SQS_CONSUMER_BATCH_SIZE: '0' }],
    ['no receives before the DLQ', { SQS_CONSUMER_MAX_RECEIVES: '0' }],
    ['a non-boolean SQS_CONSUMER_ENABLED', { SQS_CONSUMER_ENABLED: 'maybe' }],
  ])('refuses %s', (_name, extra) => {
    expect(() => loadEnv({ ...BASE_ENV, ...extra })).toThrow('Invalid environment configuration');
  });
});
