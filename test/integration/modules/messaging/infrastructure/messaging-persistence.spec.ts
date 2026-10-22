import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { InboxRepository } from '../../../../../src/modules/messaging/application/inbox-repository';
import { OutboxRepository } from '../../../../../src/modules/messaging/application/outbox-repository';
import { InboxMessage, InboxMessageAlreadyExistsError } from '../../../../../src/modules/messaging/domain/inbox-message';
import {
  DEFAULT_OUTBOX_BACKOFF,
  OutboxMessage,
} from '../../../../../src/modules/messaging/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../../../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionProcessed } from '../../../../../src/modules/wagering/domain/wager-transaction-events';
import { ExponentialBackoff } from '../../../../../src/shared/domain/exponential-backoff';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { inFreshContext, inTransaction, present } from '../../../../support/orm-context';

const RECEIVED_AT = new Date('2026-10-22T10:00:00.123Z');
const PROCESSED_AT = new Date('2026-10-22T10:00:01.456Z');

function processedBetEvent(): WagerTransactionProcessed {
  const id = Bun.randomUUIDv7();
  const bet = WagerTransaction.create({
    id,
    providerId: `provider-${id}`,
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `idem-${id}`,
    payloadHash: `hash-${id}`,
    walletId: Bun.randomUUIDv7(),
    playerId: `player-${id}`,
    roundId: `round-${id}`,
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '0.10', currency: 'BRL' }),
    createdAt: RECEIVED_AT,
  });
  bet.markProcessed({ at: PROCESSED_AT, balanceAfter: Money.from({ amount: '99999999.99', currency: 'BRL' }) });
  return WagerTransactionProcessed.from(bet, {
    eventId: Bun.randomUUIDv7(),
    correlationId: Bun.randomUUIDv7(),
    occurredAt: PROCESSED_AT,
  });
}

describe('messaging persistence (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let inbox: InboxRepository;
  let outbox: OutboxRepository;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    inbox = app.get(InboxRepository);
    outbox = app.get(OutboxRepository);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('inbox', () => {
    const consumerName = 'wager-transactions';
    const readInbox = async (messageId: string) =>
      present(
        await inFreshContext(orm, () => inbox.findByKey(consumerName, messageId)),
        'inbox message',
      );

    it('round-trips a received message and then its processing', async () => {
      const message = InboxMessage.receive({
        messageId: Bun.randomUUIDv7(),
        consumerName,
        payloadHash: 'hash-abc',
        receivedAt: RECEIVED_AT,
      });

      await inTransaction(orm, () => inbox.insert(message));
      const received = await readInbox(message.messageId);

      expect(received.messageId).toBe(message.messageId);
      expect(received.consumerName).toBe(consumerName);
      expect(received.payloadHash).toBe('hash-abc');
      expect(received.receivedAt.getTime()).toBe(RECEIVED_AT.getTime());
      expect(received.isProcessed()).toBe(false);
      expect(received.processedAt).toBeUndefined();

      message.markProcessed(PROCESSED_AT);
      await inTransaction(orm, () => inbox.update(message));
      const processed = await readInbox(message.messageId);

      expect(processed.isProcessed()).toBe(true);
      expect(processed.processedAt?.getTime()).toBe(PROCESSED_AT.getTime());
      expect(processed.receivedAt.getTime()).toBe(RECEIVED_AT.getTime());
    });

    it('finds nothing for an unknown key and refuses to update a message that was never inserted', async () => {
      expect(
        await inFreshContext(orm, () => inbox.findByKey(consumerName, Bun.randomUUIDv7())),
      ).toBeNull();

      const message = InboxMessage.receive({
        messageId: Bun.randomUUIDv7(),
        consumerName,
        payloadHash: 'hash-abc',
        receivedAt: RECEIVED_AT,
      });
      message.markProcessed(PROCESSED_AT);
      await expect(inTransaction(orm, () => inbox.update(message))).rejects.toThrow(
        'not found for update',
      );
    });

    it('translates a repeated (consumerName, messageId) into InboxMessageAlreadyExistsError, per consumer', async () => {
      const messageId = Bun.randomUUIDv7();
      const receive = (name: string) =>
        InboxMessage.receive({ messageId, consumerName: name, payloadHash: 'hash-abc', receivedAt: RECEIVED_AT });
      await inTransaction(orm, () => inbox.insert(receive(consumerName)));

      const error = await inTransaction(orm, () => inbox.insert(receive(consumerName))).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InboxMessageAlreadyExistsError);
      expect((error as InboxMessageAlreadyExistsError).consumerName).toBe(consumerName);
      expect((error as InboxMessageAlreadyExistsError).messageId).toBe(messageId);
      expect((error as InboxMessageAlreadyExistsError).code).toBe(FailureCode.TransientFailure);

      await inTransaction(orm, () => inbox.insert(receive('another-consumer')));
      expect(
        await inFreshContext(orm, () => inbox.findByKey('another-consumer', messageId)),
      ).not.toBeNull();
    });

    it('refuses to write outside em.transactional()', async () => {
      const message = InboxMessage.receive({
        messageId: Bun.randomUUIDv7(),
        consumerName,
        payloadHash: 'hash-abc',
        receivedAt: RECEIVED_AT,
      });

      await expect(inFreshContext(orm, () => inbox.insert(message))).rejects.toThrow(
        'must run inside em.transactional()',
      );
    });
  });

  describe('outbox', () => {
    const readOutbox = async (id: string) =>
      present(await inFreshContext(orm, () => outbox.findById(id)), 'outbox message');

    it('round-trips an enqueued event keeping the payload text and money as strings', async () => {
      const message = OutboxMessage.enqueue(processedBetEvent());

      await inTransaction(orm, () => outbox.insert(message));
      const stored = await readOutbox(message.id);

      expect(stored.id).toBe(message.id);
      expect(stored.aggregateId).toBe(message.aggregateId);
      expect(stored.eventType).toBe('WagerTransactionProcessed');
      expect(stored.occurredAt.getTime()).toBe(PROCESSED_AT.getTime());
      expect(stored.attempts).toBe(0);
      expect(stored.nextAttemptAt.getTime()).toBe(PROCESSED_AT.getTime());
      expect(stored.publishedAt).toBeUndefined();
      expect(stored.isPending()).toBe(true);
      expect(JSON.stringify(stored.payload)).toBe(JSON.stringify(message.payload));

      const data = stored.payload['data'] as { money: { amount: unknown }; balanceAfter: { amount: unknown } };
      expect(data.money.amount).toBe('0.10');
      expect(data.balanceAfter.amount).toBe('99999999.99');
    });

    it('persists a retry schedule and then the publication', async () => {
      const message = OutboxMessage.enqueue(processedBetEvent());
      await inTransaction(orm, () => outbox.insert(message));

      const retryAt = new Date('2026-10-22T10:05:00.789Z');
      message.scheduleRetry(retryAt, new ExponentialBackoff(DEFAULT_OUTBOX_BACKOFF, () => 0));
      await inTransaction(orm, () => outbox.update(message));
      const retried = await readOutbox(message.id);

      expect(retried.attempts).toBe(1);
      expect(retried.nextAttemptAt.getTime()).toBe(retryAt.getTime() + DEFAULT_OUTBOX_BACKOFF.baseDelayMs);
      expect(retried.publishedAt).toBeUndefined();

      const publishedAt = new Date('2026-10-22T10:06:00.321Z');
      message.markPublished(publishedAt);
      await inTransaction(orm, () => outbox.update(message));
      const published = await readOutbox(message.id);

      expect(published.isPending()).toBe(false);
      expect(published.publishedAt?.getTime()).toBe(publishedAt.getTime());
      expect(published.attempts).toBe(1);
      expect(JSON.stringify(published.payload)).toBe(JSON.stringify(message.payload));
    });

    it('finds nothing for an unknown id and refuses to update a message that was never inserted', async () => {
      expect(await inFreshContext(orm, () => outbox.findById(Bun.randomUUIDv7()))).toBeNull();

      const message = OutboxMessage.enqueue(processedBetEvent());
      message.markPublished(PROCESSED_AT);
      await expect(inTransaction(orm, () => outbox.update(message))).rejects.toThrow(
        'not found for update',
      );
    });

    it('refuses to write outside em.transactional()', async () => {
      const message = OutboxMessage.enqueue(processedBetEvent());

      await expect(inFreshContext(orm, () => outbox.insert(message))).rejects.toThrow(
        'must run inside em.transactional()',
      );
    });
  });
});
