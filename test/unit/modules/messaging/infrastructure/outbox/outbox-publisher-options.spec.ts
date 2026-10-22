import { describe, expect, it } from 'bun:test';

import { loadEnv } from '../../../../../../src/config/env';
import { outboxPublisherOptionsFromEnv } from '../../../../../../src/modules/messaging/infrastructure/outbox/outbox-publisher-options';

const BASE_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  AWS_REGION: 'us-east-1',
  SQS_WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  SQS_WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_URL: 'http://localhost:4566/000000000000/wagering-events.fifo',
};

describe('outboxPublisherOptionsFromEnv', () => {
  it('uses the defaults from a minimal environment', () => {
    expect(outboxPublisherOptionsFromEnv(loadEnv(BASE_ENV))).toEqual({
      enabled: true,
      queueUrl: BASE_ENV.SQS_EVENTS_QUEUE_URL,
      batchSize: 10,
      pollIntervalMs: 1000,
      publishTimeoutMs: 5000,
    });
  });

  it('turns the publisher off with OUTBOX_PUBLISHER_ENABLED=false', () => {
    expect(outboxPublisherOptionsFromEnv(loadEnv({ ...BASE_ENV, OUTBOX_PUBLISHER_ENABLED: 'false' })).enabled).toBe(
      false,
    );
  });

  it('reads the tuning variables', () => {
    const options = outboxPublisherOptionsFromEnv(
      loadEnv({
        ...BASE_ENV,
        OUTBOX_PUBLISHER_BATCH_SIZE: '4',
        OUTBOX_PUBLISHER_POLL_INTERVAL_MS: '250',
        OUTBOX_PUBLISH_TIMEOUT_MS: '1500',
      }),
    );

    expect(options.batchSize).toBe(4);
    expect(options.pollIntervalMs).toBe(250);
    expect(options.publishTimeoutMs).toBe(1500);
  });

  it.each([
    ['a batch above the SendMessageBatch limit of 10', { OUTBOX_PUBLISHER_BATCH_SIZE: '11' }],
    ['an empty batch', { OUTBOX_PUBLISHER_BATCH_SIZE: '0' }],
    ['a zero poll interval', { OUTBOX_PUBLISHER_POLL_INTERVAL_MS: '0' }],
    ['a zero publish timeout', { OUTBOX_PUBLISH_TIMEOUT_MS: '0' }],
    ['a non-boolean OUTBOX_PUBLISHER_ENABLED', { OUTBOX_PUBLISHER_ENABLED: 'maybe' }],
  ])('refuses %s', (_name, extra) => {
    expect(() => loadEnv({ ...BASE_ENV, ...extra })).toThrow('Invalid environment configuration');
  });

  it('requires the events queue URL', () => {
    const { SQS_EVENTS_QUEUE_URL: _omitted, ...withoutEventsQueue } = BASE_ENV;
    expect(() => loadEnv(withoutEventsQueue)).toThrow('SQS_EVENTS_QUEUE_URL');
  });
});
