import { describe, expect, it } from 'bun:test';

import { DomainError } from '../../../../src/shared/domain/domain-error';
import { FailureAction, FailureCode } from '../../../../src/shared/domain/failure-code';
import {
  IntegrationEvent,
  InvalidIntegrationEventError,
  type IntegrationEventProps,
} from '../../../../src/shared/domain/integration-event';

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

const props = (
  overrides: Partial<IntegrationEventProps<TestData>> = {},
): IntegrationEventProps<TestData> => ({
  eventId: 'event-1',
  aggregateId: 'aggregate-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: OCCURRED_AT,
  data: { value: 'v', nested: { items: ['a', 'b'] } },
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

describe('IntegrationEvent: envelope', () => {
  it('exposes the identity fields, the type and the version', () => {
    const event = TestEvent.make(props());

    expect(event.eventId).toBe('event-1');
    expect(event.aggregateId).toBe('aggregate-1');
    expect(event.correlationId).toBe('corr-1');
    expect(event.causationId).toBe('msg-1');
    expect(event.occurredAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(event.eventType).toBe('TestEvent');
    expect(event.version).toBe(3);
    expect(event.data).toEqual({ value: 'v', nested: { items: ['a', 'b'] } });
  });

  it('serializes the keys in a fixed order with occurredAt as an ISO-8601 string', () => {
    const json = TestEvent.make(props()).toJSON();

    expect(Object.keys(json)).toEqual([
      'eventId',
      'eventType',
      'aggregateId',
      'correlationId',
      'causationId',
      'occurredAt',
      'version',
      'data',
    ]);
    expect(json.occurredAt).toBe('2026-10-21T12:00:00.000Z');
    expect(json.version).toBe(3);
  });

  it('keeps the golden string for the reference event', () => {
    expect(JSON.stringify(TestEvent.make(props()))).toBe(
      '{"eventId":"event-1","eventType":"TestEvent","aggregateId":"aggregate-1","correlationId":"corr-1",' +
        '"causationId":"msg-1","occurredAt":"2026-10-21T12:00:00.000Z","version":3,' +
        '"data":{"value":"v","nested":{"items":["a","b"]}}}',
    );
  });

  it('omits causationId when absent, keeping the other keys in order', () => {
    const { causationId: _omitted, ...withoutCausation } = props();
    const event = TestEvent.make(withoutCausation);

    expect(event.causationId).toBeUndefined();
    expect(Object.keys(event.toJSON())).toEqual([
      'eventId',
      'eventType',
      'aggregateId',
      'correlationId',
      'occurredAt',
      'version',
      'data',
    ]);
  });

  it('omits causationId when it is explicitly undefined', () => {
    const event = TestEvent.make(props({ causationId: undefined }));
    expect('causationId' in event.toJSON()).toBe(false);
  });

  it('survives a JSON round trip unchanged', () => {
    const event = TestEvent.make(props());
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });
});

describe('IntegrationEvent: invalid input', () => {
  it.each<[string, Partial<IntegrationEventProps<TestData>>]>([
    ['empty eventId', { eventId: '' }],
    ['empty aggregateId', { aggregateId: '' }],
    ['empty correlationId', { correlationId: '' }],
    ['empty causationId', { causationId: '' }],
    ['invalid occurredAt', { occurredAt: new Date('x') }],
    ['non-date occurredAt', { occurredAt: '2026-10-21T12:00:00.000Z' as unknown as Date }],
  ])('rejects %s', (_label, overrides) => {
    const error = caught(() => TestEvent.make(props(overrides)));

    expect(error).toBeInstanceOf(InvalidIntegrationEventError);
    expect<string>((error as InvalidIntegrationEventError).code).toBe('INVARIANT_VIOLATION');
  });
});

describe('IntegrationEvent: immutability', () => {
  it('is not affected by mutating the Date passed in', () => {
    const occurredAt = new Date(OCCURRED_AT.getTime());
    const event = TestEvent.make(props({ occurredAt }));
    occurredAt.setUTCFullYear(2000);

    expect(event.occurredAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(event.toJSON().occurredAt).toBe('2026-10-21T12:00:00.000Z');
  });

  it('is not affected by mutating the Date it returns', () => {
    const event = TestEvent.make(props());
    event.occurredAt.setUTCFullYear(2000);

    expect(event.occurredAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(event.toJSON().occurredAt).toBe('2026-10-21T12:00:00.000Z');
  });

  it('freezes data and every nested object and array', () => {
    const event = TestEvent.make(props());

    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.nested)).toBe(true);
    expect(Object.isFrozen(event.data.nested.items)).toBe(true);
    expect(() => {
      (event.data as TestData).value = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      event.data.nested.items.push('c');
    }).toThrow(TypeError);
    expect(event.data.value).toBe('v');
  });
});

describe('InvalidIntegrationEventError', () => {
  it('is an invariant violation that must not be retried', () => {
    const error = new InvalidIntegrationEventError('x');

    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('InvalidIntegrationEventError');
    expect(error.message).toBe('Invalid integration event: x');
    expect(error.code).toBe(FailureCode.InvariantViolation);
    expect(error.action).toBe(FailureAction.GiveUp);
  });
});
