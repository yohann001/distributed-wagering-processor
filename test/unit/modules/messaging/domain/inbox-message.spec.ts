import { describe, expect, it } from 'bun:test';

import {
  InboxMessage,
  InvalidInboxMessageError,
  type ReceiveInboxProps,
} from '../../../../../src/modules/messaging/domain/inbox-message';
import { DomainError } from '../../../../../src/shared/domain/domain-error';
import { FailureAction, FailureCode } from '../../../../../src/shared/domain/failure-code';

const RECEIVED_AT = new Date('2026-10-21T12:00:00.000Z');
const PROCESSED_AT = new Date('2026-10-21T12:00:05.000Z');
const LATER = new Date('2026-10-21T12:10:00.000Z');

const props = (overrides: Partial<ReceiveInboxProps> = {}): ReceiveInboxProps => ({
  messageId: 'msg-1',
  consumerName: 'wager-transactions',
  payloadHash: 'hash-1',
  receivedAt: RECEIVED_AT,
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

describe('InboxMessage.receive: happy path', () => {
  it('starts not processed with the identity fields and the reception time', () => {
    const message = InboxMessage.receive(props());

    expect(message.messageId).toBe('msg-1');
    expect(message.consumerName).toBe('wager-transactions');
    expect(message.payloadHash).toBe('hash-1');
    expect(message.receivedAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(message.processedAt).toBeUndefined();
    expect(message.isProcessed()).toBe(false);
  });
});

describe('InboxMessage.receive: invalid input', () => {
  it.each<[string, Partial<ReceiveInboxProps>]>([
    ['empty messageId', { messageId: '' }],
    ['empty consumerName', { consumerName: '' }],
    ['empty payloadHash', { payloadHash: '' }],
    ['non-string messageId', { messageId: 1 as unknown as string }],
    ['invalid receivedAt', { receivedAt: new Date('x') }],
    ['non-date receivedAt', { receivedAt: '2026-10-21T12:00:00.000Z' as unknown as Date }],
  ])('rejects %s', (_label, overrides) => {
    const error = caught(() => InboxMessage.receive(props(overrides)));

    expect(error).toBeInstanceOf(InvalidInboxMessageError);
    expect<string>((error as InvalidInboxMessageError).code).toBe('INVARIANT_VIOLATION');
  });
});

describe('InboxMessage.markProcessed', () => {
  it('records when the message was processed', () => {
    const message = InboxMessage.receive(props());

    message.markProcessed(PROCESSED_AT);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe('2026-10-21T12:00:05.000Z');
  });

  it('throws on a second call and keeps the first processedAt', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(PROCESSED_AT);

    const error = caught(() => message.markProcessed(LATER));

    expect(error).toBeInstanceOf(InvalidInboxMessageError);
    expect<string>((error as InvalidInboxMessageError).code).toBe('INVARIANT_VIOLATION');
    expect((error as InvalidInboxMessageError).message).toBe(
      'Invalid inbox message: message msg-1 for consumer wager-transactions is already processed',
    );
    expect(message.processedAt?.toISOString()).toBe('2026-10-21T12:00:05.000Z');
  });

  it('throws on an invalid date and leaves the message unprocessed', () => {
    const message = InboxMessage.receive(props());

    const error = caught(() => message.markProcessed(new Date('x')));

    expect(error).toBeInstanceOf(InvalidInboxMessageError);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });
});

describe('InboxMessage.rehydrate', () => {
  it('restores an unprocessed message', () => {
    const message = InboxMessage.rehydrate(props());

    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('restores a processed message', () => {
    const message = InboxMessage.rehydrate({ ...props(), processedAt: PROCESSED_AT });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe('2026-10-21T12:00:05.000Z');
  });

  it('does not revalidate the persisted state', () => {
    const message = InboxMessage.rehydrate(props({ messageId: '', payloadHash: '' }));

    expect(message.messageId).toBe('');
    expect(message.payloadHash).toBe('');
  });

  it('still refuses a second markProcessed after rehydrating a processed message', () => {
    const message = InboxMessage.rehydrate({ ...props(), processedAt: PROCESSED_AT });

    expect(caught(() => message.markProcessed(LATER))).toBeInstanceOf(InvalidInboxMessageError);
    expect(message.processedAt?.toISOString()).toBe('2026-10-21T12:00:05.000Z');
  });
});

describe('InboxMessage: immutability of dates', () => {
  it('is not affected by mutating the receivedAt passed in', () => {
    const receivedAt = new Date(RECEIVED_AT.getTime());
    const message = InboxMessage.receive(props({ receivedAt }));
    receivedAt.setUTCFullYear(2000);

    expect(message.receivedAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
  });

  it('is not affected by mutating the processedAt passed to markProcessed or rehydrate', () => {
    const at = new Date(PROCESSED_AT.getTime());
    const message = InboxMessage.receive(props());
    message.markProcessed(at);
    at.setUTCFullYear(2000);

    const stored = new Date(PROCESSED_AT.getTime());
    const rehydrated = InboxMessage.rehydrate({ ...props(), processedAt: stored });
    stored.setUTCFullYear(2000);

    expect(message.processedAt?.toISOString()).toBe('2026-10-21T12:00:05.000Z');
    expect(rehydrated.processedAt?.toISOString()).toBe('2026-10-21T12:00:05.000Z');
  });

  it('is not affected by mutating the dates it returns', () => {
    const message = InboxMessage.rehydrate({ ...props(), processedAt: PROCESSED_AT });
    message.receivedAt.setUTCFullYear(2000);
    message.processedAt?.setUTCFullYear(2000);

    expect(message.receivedAt.toISOString()).toBe('2026-10-21T12:00:00.000Z');
    expect(message.processedAt?.toISOString()).toBe('2026-10-21T12:00:05.000Z');
  });
});

describe('InvalidInboxMessageError', () => {
  it('is an invariant violation that must not be retried', () => {
    const error = new InvalidInboxMessageError('x');

    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('InvalidInboxMessageError');
    expect(error.message).toBe('Invalid inbox message: x');
    expect(error.code).toBe(FailureCode.InvariantViolation);
    expect(error.action).toBe(FailureAction.GiveUp);
  });
});
