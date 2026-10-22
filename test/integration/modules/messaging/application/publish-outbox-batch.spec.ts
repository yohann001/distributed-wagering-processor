import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { Message } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { loadEnv } from '../../../../../src/config/env';
import { OutboxRepository } from '../../../../../src/modules/messaging/application/outbox-repository';
import { PublishOutboxBatch } from '../../../../../src/modules/messaging/application/publish-outbox-batch';
import { OutboxMessage } from '../../../../../src/modules/messaging/domain/outbox-message';
import { buildSqsClient } from '../../../../../src/modules/messaging/infrastructure/sqs/sqs-client';
import { defaultIdempotencyKey } from '../../../../../src/modules/wagering/application/payload-hash';
import { SubmitWagerTransaction } from '../../../../../src/modules/wagering/application/submit-wager-transaction';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionProcessed } from '../../../../../src/modules/wagering/domain/wager-transaction-events';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { resetDatabase } from '../../../../support/database';
import { newProviderId, openWalletWithBalance } from '../../../../support/fixtures';
import { inTransaction, present } from '../../../../support/orm-context';
import {
  countingSqsClient,
  createTestSqsClient,
  purgeQueue,
  receiveAll,
  testQueueUrls,
  waitFor,
} from '../../../../support/sqs';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload_text: string;
  attempts: number;
  published_at: Date | null;
  retry_is_in_the_future: boolean;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Evento real do domínio (BET processada), com `occurredAt` no passado recente: a mensagem já nasce devida. */
function processedBetEvent(): WagerTransactionProcessed {
  const id = Bun.randomUUIDv7();
  const occurredAt = new Date(Date.now() - 1000);
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
    createdAt: occurredAt,
  });
  bet.markProcessed({ at: occurredAt, balanceAfter: Money.from({ amount: '99.90', currency: 'BRL' }) });
  return WagerTransactionProcessed.from(bet, {
    eventId: Bun.randomUUIDv7(),
    correlationId: Bun.randomUUIDv7(),
    occurredAt,
  });
}

describe('PublishOutboxBatch (Postgres e LocalStack reais)', () => {
  const sqs = createTestSqsClient();
  const urls = testQueueUrls();
  let app: INestApplication;
  let orm: MikroORM;
  let outbox: OutboxRepository;
  let publishBatch: PublishOutboxBatch;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    outbox = app.get(OutboxRepository);
    publishBatch = app.get(PublishOutboxBatch);
  });

  afterAll(async () => {
    await app?.close();
    sqs.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    await purgeQueue(sqs, urls.events);
  });

  async function enqueueEvents(count: number): Promise<OutboxMessage[]> {
    const messages = Array.from({ length: count }, () => OutboxMessage.enqueue(processedBetEvent()));
    await inTransaction(orm, async () => {
      for (const message of messages) {
        await outbox.insert(message);
      }
    });
    return messages;
  }

  function outboxRows(): Promise<OutboxRow[]> {
    return orm.em.fork().execute<OutboxRow[]>(
      `select id, aggregate_id, event_type, payload::text as payload_text, attempts, published_at,
              next_attempt_at > now() as retry_is_in_the_future
         from outbox_messages order by id`,
    );
  }

  async function pendingCount(): Promise<number> {
    const [row] = await orm.em
      .fork()
      .execute<{ total: number }[]>('select count(*)::int as total from outbox_messages where published_at is null');
    return row?.total ?? 0;
  }

  /** Repete `execute` até um ciclo não reivindicar nada, somando o que ele publicou. */
  async function drain(batch: PublishOutboxBatch): Promise<string[]> {
    const publishedIds: string[] = [];
    for (;;) {
      const result = await batch.execute();
      if (result.claimed === 0) {
        return publishedIds;
      }
      publishedIds.push(...result.published.map((message) => message.id));
    }
  }

  const groupIdOf = (message: Message) => message.Attributes?.['MessageGroupId'];
  const deduplicationIdOf = (message: Message) => message.Attributes?.['MessageDeduplicationId'];

  it('never claims nor sends a row of an uncommitted transaction, and publishes it after the commit', async () => {
    const event = OutboxMessage.enqueue(processedBetEvent());
    const inserted = deferred();
    const release = deferred();
    const owner = orm.em.fork().transactional(async () => {
      await outbox.insert(event);
      inserted.resolve();
      await release.promise;
    });
    await Promise.race([inserted.promise, owner]);

    const beforeCommit = await publishBatch.execute();

    expect(beforeCommit.claimed).toBe(0);
    expect(await receiveAll(sqs, urls.events)).toEqual([]);

    release.resolve();
    await owner;
    const afterCommit = await publishBatch.execute();

    expect(afterCommit.published.map((message) => message.id)).toEqual([event.id]);
    const received = present((await receiveAll(sqs, urls.events, { expected: 1 }))[0], 'published message');
    expect(deduplicationIdOf(received)).toBe(event.id);
    const [row] = await outboxRows();
    expect(row?.published_at).not.toBeNull();
    expect(row?.attempts).toBe(0);
  });

  it('publishes rows committed by an instance that never published (it died after the commit) from another instance', async () => {
    const deadApp = await createTestApp();
    const { wallet } = await openWalletWithBalance(deadApp, { amount: '100.00' });
    const providerId = newProviderId();
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
    const result = await deadApp.get(SubmitWagerTransaction).execute({
      idempotencyKey: defaultIdempotencyKey(providerId, externalTransactionId),
      providerId,
      externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: `round-${Bun.randomUUIDv7()}`,
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      correlationId: Bun.randomUUIDv7(),
    });
    await deadApp.close();
    const committed = await outboxRows();
    expect(committed).toHaveLength(2);
    expect(committed.every((row) => row.published_at === null)).toBe(true);
    expect(await receiveAll(sqs, urls.events)).toEqual([]);

    const publishedIds = await drain(publishBatch);

    expect(publishedIds.sort()).toEqual(committed.map((row) => row.id).sort());
    const received = await receiveAll(sqs, urls.events, { expected: committed.length });
    expect(received).toHaveLength(committed.length);
    for (const row of committed) {
      const message = present(
        received.find((candidate) => deduplicationIdOf(candidate) === row.id),
        `message of event ${row.id}`,
      );
      expect(message.Body).toBe(row.payload_text);
      expect(groupIdOf(message)).toBe(row.aggregate_id);
      expect(message.MessageAttributes?.['eventType']?.StringValue).toBe(row.event_type);
      expect((JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId).toBe(row.id);
    }
    expect((await outboxRows()).every((row) => row.published_at !== null)).toBe(true);
    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
    await assertWalletConsistent(orm, wallet.id);
  });

  it('skips rows locked by another transaction without waiting, and publishes them once they are released', async () => {
    const messages = await enqueueEvents(6);
    const lockedIds = messages.slice(0, 3).map((message) => message.id);
    const freeIds = messages.slice(3).map((message) => message.id);
    const locked = deferred();
    const release = deferred();
    const owner = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from outbox_messages where id in (?, ?, ?) for update', lockedIds);
      locked.resolve();
      await release.promise;
    });
    await Promise.race([locked.promise, owner]);

    const startedAt = performance.now();
    const whileLocked = await publishBatch.execute();
    const elapsedMs = performance.now() - startedAt;

    // O lock_timeout da transação é 2 s: esperar a linha travada passaria disso.
    expect(elapsedMs).toBeLessThan(1500);
    expect(whileLocked.claimed).toBe(3);
    expect(whileLocked.published.map((message) => message.id).sort()).toEqual([...freeIds].sort());
    expect(await receiveAll(sqs, urls.events, { expected: 3 })).toHaveLength(3);
    expect(await pendingCount()).toBe(3);

    release.resolve();
    await owner;
    const afterRelease = await publishBatch.execute();

    expect(afterRelease.published.map((message) => message.id).sort()).toEqual([...lockedIds].sort());
    expect(await receiveAll(sqs, urls.events, { expected: 3 })).toHaveLength(3);
    expect(await pendingCount()).toBe(0);
  });

  it('sends each event exactly once when two instances publish the same outbox concurrently', async () => {
    const messages = await enqueueEvents(40);
    const first = countingSqsClient();
    const second = countingSqsClient();
    const firstApp = await createTestApp({ sqsClient: first.client });
    const secondApp = await createTestApp({ sqsClient: second.client });

    try {
      const [firstPublished, secondPublished] = await Promise.all([
        drain(firstApp.get(PublishOutboxBatch)),
        drain(secondApp.get(PublishOutboxBatch)),
      ]);

      const sent = [...first.sentEventIds, ...second.sentEventIds];
      expect(sent).toHaveLength(40);
      expect(new Set(sent).size).toBe(40);
      expect([...sent].sort()).toEqual(messages.map((message) => message.id).sort());
      expect(firstPublished.length + secondPublished.length).toBe(40);
      expect(await pendingCount()).toBe(0);
      expect(await receiveAll(sqs, urls.events, { expected: 40, timeoutMs: 15000 })).toHaveLength(40);
    } finally {
      await firstApp.close();
      await secondApp.close();
    }
  });

  it('keeps the row pending with a backoff when SQS is unreachable, and publishes it once SQS answers', async () => {
    const message = present((await enqueueEvents(1))[0], 'enqueued event');
    const unreachable = await createTestApp({
      sqsClient: buildSqsClient({ ...loadEnv(), AWS_ENDPOINT_URL: 'http://127.0.0.1:1' }),
    });

    try {
      const failed = await unreachable.get(PublishOutboxBatch).execute();

      expect(failed.claimed).toBe(1);
      expect(failed.published).toHaveLength(0);
      expect(failed.retried).toHaveLength(1);
      expect(failed.retried[0]?.message.id).toBe(message.id);
      expect(failed.retried[0]?.reason).not.toBe('');
      const [row] = await outboxRows();
      expect(row?.attempts).toBe(1);
      expect(row?.published_at).toBeNull();
      expect(row?.retry_is_in_the_future).toBe(true);
      expect(await receiveAll(sqs, urls.events)).toEqual([]);
    } finally {
      await unreachable.close();
    }

    // Backoff da primeira falha: entre 0,5 s e 1 s.
    await waitFor(async () => {
      const result = await publishBatch.execute();
      return result.published.length === 1 ? result : null;
    });
    expect(await pendingCount()).toBe(0);
    expect(await receiveAll(sqs, urls.events, { expected: 1 })).toHaveLength(1);
  });

  it('is safe to publish the same event twice: the FIFO queue keeps one message and the envelope carries the eventId', async () => {
    const counting = countingSqsClient();
    const countingApp = await createTestApp({ sqsClient: counting.client });
    const eventId = present((await enqueueEvents(1))[0], 'enqueued event').id;

    try {
      const batch = countingApp.get(PublishOutboxBatch);
      expect((await batch.execute()).published).toHaveLength(1);
      await orm.em.fork().execute('update outbox_messages set published_at = null where id = ?', [eventId]);
      expect((await batch.execute()).published).toHaveLength(1);

      expect(counting.sentEventIds).toEqual([eventId, eventId]);
      const received = await receiveAll(sqs, urls.events);
      expect(received).toHaveLength(1);
      const [only] = received;
      expect(deduplicationIdOf(present(only, 'queued message'))).toBe(eventId);
      expect((JSON.parse(only?.Body ?? '{}') as { eventId: string }).eventId).toBe(eventId);
      expect(await pendingCount()).toBe(0);
    } finally {
      await countingApp.close();
    }
  });
});
