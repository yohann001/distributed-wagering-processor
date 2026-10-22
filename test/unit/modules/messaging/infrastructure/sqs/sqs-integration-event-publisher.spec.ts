import { describe, expect, it } from 'bun:test';

import { OutboxMessage } from '../../../../../../src/modules/messaging/domain/outbox-message';
import { toSendMessageBatchEntries } from '../../../../../../src/modules/messaging/infrastructure/sqs/sqs-integration-event-publisher';

const OCCURRED_AT = new Date('2026-10-22T10:00:00.123Z');

function outboxMessage(overrides: { payload?: Record<string, unknown>; eventType?: string } = {}): OutboxMessage {
  const id = Bun.randomUUIDv7();
  const aggregateId = Bun.randomUUIDv7();
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: overrides.eventType ?? 'WagerTransactionProcessed',
    payload: overrides.payload ?? {
      eventId: id,
      eventType: overrides.eventType ?? 'WagerTransactionProcessed',
      aggregateId,
      correlationId: 'corr-1',
      occurredAt: OCCURRED_AT.toISOString(),
      version: 1,
      data: { money: { amount: '25.00', currency: 'BRL' } },
    },
    occurredAt: OCCURRED_AT,
    attempts: 0,
    nextAttemptAt: OCCURRED_AT,
    publishedAt: undefined,
  });
}

describe('toSendMessageBatchEntries', () => {
  it('maps the outbox message to a FIFO entry: body is the envelope text, group is the aggregate, dedup is the event id', () => {
    const message = outboxMessage();

    const [entry] = toSendMessageBatchEntries([message]);

    expect(entry?.Id).toBe('0');
    expect(entry?.MessageBody).toBe(JSON.stringify(message.payload));
    expect(entry?.MessageGroupId).toBe(message.aggregateId);
    expect(entry?.MessageDeduplicationId).toBe(message.id);
    expect(entry?.MessageAttributes).toEqual({
      eventType: { DataType: 'String', StringValue: 'WagerTransactionProcessed' },
      correlationId: { DataType: 'String', StringValue: 'corr-1' },
    });
  });

  it('keeps the key order of the stored envelope in the body', () => {
    const message = outboxMessage({ payload: { z: 1, a: 2, m: { y: 'b', x: 'a' } } });

    const [entry] = toSendMessageBatchEntries([message]);

    expect(entry?.MessageBody).toBe('{"z":1,"a":2,"m":{"y":"b","x":"a"}}');
  });

  it('numbers the entries by their position and omits correlationId when the envelope has none', () => {
    const first = outboxMessage();
    const second = outboxMessage({ payload: { eventId: 'e-2' }, eventType: 'WalletBalanceChanged' });

    const entries = toSendMessageBatchEntries([first, second]);

    expect(entries.map((entry) => entry.Id)).toEqual(['0', '1']);
    expect(entries[1]?.MessageAttributes).toEqual({
      eventType: { DataType: 'String', StringValue: 'WalletBalanceChanged' },
    });
  });

  it('returns no entries for no messages', () => {
    expect(toSendMessageBatchEntries([])).toEqual([]);
  });
});
