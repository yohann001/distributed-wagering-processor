import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_OUTBOX_BACKOFF,
  InvalidOutboxMessageError,
  OutboxMessage,
  type OutboxMessageState,
} from '../../../../../src/modules/messaging/domain/outbox-message';
import { DomainError } from '../../../../../src/shared/domain/domain-error';
import {
  ExponentialBackoff,
  InvalidBackoffError,
} from '../../../../../src/shared/domain/exponential-backoff';
import { FailureAction, FailureCode } from '../../../../../src/shared/domain/failure-code';
import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../../../src/shared/domain/integration-event';

interface TestData {
  value: string;
  nested: { items: string[] };
}

class TestEvent extends IntegrationEvent<TestData> {
  readonly eventType = 'TestEvent';
  readonly version = 3;

  private constructor(props: IntegrationEventProps<TestData>) {
    super(props);
  }

  static make(props: IntegrationEventProps<TestData>): TestEvent {
    return new TestEvent(props);
  }
}

const OCCURRED_AT = new Date('2026-10-21T12:00:00.000Z');
const PUBLISHED_AT = new Date('2026-10-21T12:00:03.000Z');
const LATER = new Date('2026-10-21T12:10:00.000Z');

const event = (overrides: Partial<IntegrationEventProps<TestData>> = {}): TestEvent =>
  TestEvent.make({
    eventId: 'event-1',
    aggregateId: 'aggregate-1',
    correlationId: 'corr-1',
    causationId: 'msg-1',
    occurredAt: OCCURRED_AT,
    data: { value: 'v', nested: { items: ['a', 'b'] } },
    ...overrides,
  });

const plusMs = (date: Date, ms: number): Date => new Date(date.getTime() + ms);

const noJitter = (): ExponentialBackoff => new ExponentialBackoff(DEFAULT_OUTBOX_BACKOFF, () => 0);

const state = (overrides: Partial<OutboxMessageState> = {}): OutboxMessageState => ({
  id: 'event-1',
  aggregateId: 'aggregate-1',
  eventType: 'TestEvent',
  payload: { eventId: 'event-1', data: { items: ['a'] } },
  occurredAt: OCCURRED_AT,
  attempts: 0,
  nextAttemptAt: OCCURRED_AT,
  ...overrides,
});

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('OutboxMessage.enqueue', () => {
  it('copies the event identity and starts pending, due immediately, with no attempts', () => {
    const outbox = OutboxMessage.enqueue(event());

    expect(outbox.id).toBe('event-1');
    expect(outbox.aggregateId).toBe('aggregate-1');
    expect(outbox.eventType).toBe('TestEvent');
    expect(outbox.occurredAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(outbox.attempts).toBe(0);
    expect(outbox.nextAttemptAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(outbox.publishedAt).toBeUndefined();
    expect(outbox.isPending()).toBe(true);
  });

  it('keeps the serialized envelope as the payload', () => {
    const source = event();
    const outbox = OutboxMessage.enqueue(source);

    expect(JSON.stringify(outbox.payload)).toBe(JSON.stringify(source));
    expect(outbox.payload).toEqual(JSON.parse(JSON.stringify(source)));
  });

  it('keeps the serialized envelope when causationId is absent', () => {
    const source = event({ causationId: undefined });
    const outbox = OutboxMessage.enqueue(source);

    expect(JSON.stringify(outbox.payload)).toBe(JSON.stringify(source));
    expect('causationId' in outbox.payload).toBe(false);
  });

  it('freezes the payload and every nested object and array', () => {
    const outbox = OutboxMessage.enqueue(event());
    const data = outbox.payload['data'] as TestData;

    expect(Object.isFrozen(outbox.payload)).toBe(true);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.nested)).toBe(true);
    expect(Object.isFrozen(data.nested.items)).toBe(true);
    expect(() => {
      data.nested.items.push('c');
    }).toThrow(TypeError);
  });

  it('is a copy: the event data stays untouched and the payload is not the event object', () => {
    const source = event();
    const outbox = OutboxMessage.enqueue(source);

    expect(outbox.payload['data']).not.toBe(source.data);
    expect(source.data).toEqual({ value: 'v', nested: { items: ['a', 'b'] } });
  });
});

describe('OutboxMessage.isDue', () => {
  it('is due exactly at nextAttemptAt, not one ms before and due after', () => {
    const outbox = OutboxMessage.enqueue(event());

    expect(outbox.isDue(plusMs(OCCURRED_AT, -1))).toBe(false);
    expect(outbox.isDue(OCCURRED_AT)).toBe(true);
    expect(outbox.isDue(plusMs(OCCURRED_AT, 1))).toBe(true);
    expect(outbox.isDue(LATER)).toBe(true);
  });

  it('is never due once published', () => {
    const outbox = OutboxMessage.enqueue(event());
    outbox.markPublished(PUBLISHED_AT);

    expect(outbox.isDue(OCCURRED_AT)).toBe(false);
    expect(outbox.isDue(new Date('2099-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('rejects an invalid now', () => {
    const error = caught(() => OutboxMessage.enqueue(event()).isDue(new Date('x')));

    expect(error).toBeInstanceOf(InvalidOutboxMessageError);
    expect<string>((error as InvalidOutboxMessageError).code).toBe('INVARIANT_VIOLATION');
  });
});

describe('OutboxMessage.scheduleRetry', () => {
  it('increments attempts and postpones nextAttemptAt by the backoff delay', () => {
    const outbox = OutboxMessage.enqueue(event());
    const now = plusMs(OCCURRED_AT, 50);

    outbox.scheduleRetry(now, noJitter());

    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt.getTime()).toBe(now.getTime() + 1000);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(plusMs(now, 999))).toBe(false);
    expect(outbox.isDue(plusMs(now, 1000))).toBe(true);
  });

  it('pushes the next attempt further out on every retry', () => {
    const outbox = OutboxMessage.enqueue(event());
    const backoff = noJitter();
    let now = OCCURRED_AT;

    for (const expectedDelay of [1000, 2000, 4000]) {
      outbox.scheduleRetry(now, backoff);
      expect(outbox.nextAttemptAt.getTime()).toBe(now.getTime() + expectedDelay);
      now = outbox.nextAttemptAt;
    }
    expect(outbox.attempts).toBe(3);
  });

  it('stops growing at the backoff cap', () => {
    const outbox = OutboxMessage.enqueue(event());
    const backoff = noJitter();

    for (let i = 0; i < 20; i += 1) {
      outbox.scheduleRetry(LATER, backoff);
    }

    expect(outbox.attempts).toBe(20);
    expect(outbox.nextAttemptAt.getTime()).toBe(LATER.getTime() + 60_000);
  });

  it('throws after the message is published and changes nothing', () => {
    const outbox = OutboxMessage.enqueue(event());
    outbox.scheduleRetry(OCCURRED_AT, noJitter());
    outbox.markPublished(PUBLISHED_AT);
    const nextAttemptAt = outbox.nextAttemptAt.getTime();

    const error = caught(() => outbox.scheduleRetry(LATER, noJitter()));

    expect(error).toBeInstanceOf(InvalidOutboxMessageError);
    expect<string>((error as InvalidOutboxMessageError).code).toBe('INVARIANT_VIOLATION');
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt.getTime()).toBe(nextAttemptAt);
  });

  it('leaves attempts and nextAttemptAt unchanged when the backoff throws', () => {
    const outbox = OutboxMessage.enqueue(event());
    const broken = new ExponentialBackoff(DEFAULT_OUTBOX_BACKOFF, () => 1);

    const error = caught(() => outbox.scheduleRetry(LATER, broken));

    expect(error).toBeInstanceOf(InvalidBackoffError);
    expect(outbox.attempts).toBe(0);
    expect(outbox.nextAttemptAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
  });

  it('rejects an invalid now and changes nothing', () => {
    const outbox = OutboxMessage.enqueue(event());

    const error = caught(() => outbox.scheduleRetry(new Date('x'), noJitter()));

    expect(error).toBeInstanceOf(InvalidOutboxMessageError);
    expect(outbox.attempts).toBe(0);
    expect(outbox.nextAttemptAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
  });
});

describe('OutboxMessage.markPublished', () => {
  it('records the publication and stops being pending', () => {
    const outbox = OutboxMessage.enqueue(event());

    outbox.markPublished(PUBLISHED_AT);

    expect(outbox.isPending()).toBe(false);
    expect(outbox.publishedAt?.toISOString()).toBe('2026-10-21T12:00:03.000Z');
  });

  it('throws on a second call (programming error) and keeps the first publishedAt', () => {
    const outbox = OutboxMessage.enqueue(event());
    outbox.markPublished(PUBLISHED_AT);

    const error = caught(() => outbox.markPublished(LATER));

    expect(error).toBeInstanceOf(InvalidOutboxMessageError);
    expect<string>((error as InvalidOutboxMessageError).code).toBe('INVARIANT_VIOLATION');
    expect((error as InvalidOutboxMessageError).message).toBe(
      'Invalid outbox message: message event-1 is already published (markPublished)',
    );
    expect(outbox.publishedAt?.toISOString()).toBe('2026-10-21T12:00:03.000Z');
  });

  it('throws on an invalid date and leaves the message pending', () => {
    const outbox = OutboxMessage.enqueue(event());

    const error = caught(() => outbox.markPublished(new Date('x')));

    expect(error).toBeInstanceOf(InvalidOutboxMessageError);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.publishedAt).toBeUndefined();
  });
});

describe('OutboxMessage.rehydrate', () => {
  it('restores a pending message with its attempts and schedule', () => {
    const nextAttemptAt = new Date('2026-10-21T12:00:07.000Z');
    const outbox = OutboxMessage.rehydrate(state({ attempts: 3, nextAttemptAt }));

    expect(outbox.id).toBe('event-1');
    expect(outbox.aggregateId).toBe('aggregate-1');
    expect(outbox.eventType).toBe('TestEvent');
    expect(outbox.payload).toEqual({ eventId: 'event-1', data: { items: ['a'] } });
    expect(outbox.attempts).toBe(3);
    expect(outbox.nextAttemptAt.toISOString()).toBe('2026-10-21T12:00:07.000Z');
    expect(outbox.publishedAt).toBeUndefined();
    expect(outbox.isPending()).toBe(true);
  });

  it('restores a published message', () => {
    const outbox = OutboxMessage.rehydrate(state({ attempts: 2, publishedAt: PUBLISHED_AT }));

    expect(outbox.isPending()).toBe(false);
    expect(outbox.publishedAt?.toISOString()).toBe('2026-10-21T12:00:03.000Z');
    expect(outbox.isDue(LATER)).toBe(false);
    expect(caught(() => outbox.markPublished(LATER))).toBeInstanceOf(InvalidOutboxMessageError);
  });

  it('does not revalidate the persisted state', () => {
    const outbox = OutboxMessage.rehydrate(state({ id: '', attempts: -1 }));

    expect(outbox.id).toBe('');
    expect(outbox.attempts).toBe(-1);
  });

  it('freezes its own copy of the payload and leaves the object it received alone', () => {
    const payload = { eventId: 'event-1', data: { items: ['a'] } };
    const outbox = OutboxMessage.rehydrate(state({ payload }));

    expect(Object.isFrozen(outbox.payload)).toBe(true);
    expect(Object.isFrozen(outbox.payload['data'])).toBe(true);
    expect(outbox.payload).not.toBe(payload);
    expect(Object.isFrozen(payload)).toBe(false);
    payload.data.items.push('b');
    expect(outbox.payload).toEqual({ eventId: 'event-1', data: { items: ['a'] } });
  });
});

describe('OutboxMessage: immutability of dates', () => {
  it('is not affected by mutating the dates passed in', () => {
    const occurredAt = new Date(OCCURRED_AT.getTime());
    const nextAttemptAt = new Date(OCCURRED_AT.getTime());
    const publishedAt = new Date(PUBLISHED_AT.getTime());
    const outbox = OutboxMessage.rehydrate(state({ occurredAt, nextAttemptAt, publishedAt }));
    occurredAt.setUTCFullYear(2000);
    nextAttemptAt.setUTCFullYear(2000);
    publishedAt.setUTCFullYear(2000);

    expect(outbox.occurredAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(outbox.nextAttemptAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(outbox.publishedAt?.toISOString()).toBe('2026-10-21T12:00:03.000Z');
  });

  it('is not affected by mutating the date passed to markPublished or scheduleRetry', () => {
    const published = OutboxMessage.enqueue(event());
    const at = new Date(PUBLISHED_AT.getTime());
    published.markPublished(at);
    at.setUTCFullYear(2000);

    const retried = OutboxMessage.enqueue(event());
    const now = new Date(OCCURRED_AT.getTime());
    retried.scheduleRetry(now, noJitter());
    now.setUTCFullYear(2000);

    expect(published.publishedAt?.toISOString()).toBe('2026-10-21T12:00:03.000Z');
    expect(retried.nextAttemptAt.toISOString()).toBe('2026-10-21T12:00:01.000Z');
  });

  it('is not affected by mutating the dates it returns', () => {
    const outbox = OutboxMessage.rehydrate(state({ publishedAt: PUBLISHED_AT }));
    outbox.occurredAt.setUTCFullYear(2000);
    outbox.nextAttemptAt.setUTCFullYear(2000);
    outbox.publishedAt?.setUTCFullYear(2000);

    expect(outbox.occurredAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(outbox.nextAttemptAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(outbox.publishedAt?.toISOString()).toBe('2026-10-21T12:00:03.000Z');
  });
});

describe('DEFAULT_OUTBOX_BACKOFF', () => {
  it('is 1 s doubling up to 60 s with up to 50% jitter, and is frozen', () => {
    expect(DEFAULT_OUTBOX_BACKOFF).toEqual({ baseDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.5 });
    expect(Object.isFrozen(DEFAULT_OUTBOX_BACKOFF)).toBe(true);
  });
});

describe('InvalidOutboxMessageError', () => {
  it('is an invariant violation that must not be retried', () => {
    const error = new InvalidOutboxMessageError('x');

    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('InvalidOutboxMessageError');
    expect(error.message).toBe('Invalid outbox message: x');
    expect(error.code).toBe(FailureCode.InvariantViolation);
    expect(error.action).toBe(FailureAction.GiveUp);
  });
});
