import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { OutboxRepository } from '../../../../../../src/modules/messaging/application/outbox-repository';
import { OutboxMessage } from '../../../../../../src/modules/messaging/domain/outbox-message';
import { defaultIdempotencyKey } from '../../../../../../src/modules/wagering/application/payload-hash';
import { SubmitWagerTransaction } from '../../../../../../src/modules/wagering/application/submit-wager-transaction';
import { WagerTransactionKind } from '../../../../../../src/modules/wagering/domain/wager-transaction';
import { Money } from '../../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../../support/create-test-app';
import { resetDatabase } from '../../../../../support/database';
import { newProviderId, openWalletWithBalance } from '../../../../../support/fixtures';
import { inTransaction } from '../../../../../support/orm-context';
import { createTestSqsClient, purgeQueue, receiveAll, testQueueUrls, waitFor } from '../../../../../support/sqs';
import { assertWalletConsistent } from '../../../../../support/wallet-consistency';

const POLL_INTERVAL_MS = 100;

/** Valor da amostra sem labels extras além de `instance_id`; `null` se a métrica não tem amostra. */
function sampleOf(metricsText: string, name: string): number | null {
  const match = new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, 'm').exec(metricsText);
  return match?.[1] === undefined ? null : Number(match[1]);
}

describe('OutboxPublisherWorker (app, Postgres e LocalStack reais)', () => {
  const sqs = createTestSqsClient();
  const urls = testQueueUrls();
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    // Linhas pendentes de outras suítes seriam publicadas assim que o worker subisse: o banco é limpo antes disso.
    const cleaner = await createTestApp();
    await resetDatabase(cleaner.get(MikroORM));
    await cleaner.close();
    app = await createTestApp({ outboxPublisher: { pollIntervalMs: POLL_INTERVAL_MS } });
    orm = app.get(MikroORM);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    // O evento ainda não devido do segundo teste ficaria pendente para sempre no banco compartilhado.
    await resetDatabase(orm);
    await app?.close();
    sqs.destroy();
  });

  beforeEach(async () => {
    await resetDatabase(orm);
    await purgeQueue(sqs, urls.events);
  });

  async function pendingCount(): Promise<number> {
    const [row] = await orm.em
      .fork()
      .execute<{ total: number }[]>('select count(*)::int as total from outbox_messages where published_at is null');
    return row?.total ?? 0;
  }

  async function metricsText(): Promise<string> {
    return (await fetch(`${baseUrl}/metrics`)).text();
  }

  it('publishes committed events on its own and exposes the outbox metrics', async () => {
    const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });
    const providerId = newProviderId();
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;

    await app.get(SubmitWagerTransaction).execute({
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

    await waitFor(async () => ((await pendingCount()) === 0 ? true : null));
    const received = await receiveAll(sqs, urls.events, { expected: 2 });
    expect(received.map((message) => message.MessageAttributes?.['eventType']?.StringValue).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    const text = await waitFor(async () => {
      const current = await metricsText();
      return sampleOf(current, 'outbox_oldest_pending_age_seconds') === 0 ? current : null;
    });
    expect(text).toMatch(/^outbox_messages_published_total\{[^}]*event_type="WagerTransactionProcessed"[^}]*\} 1$/m);
    expect(text).toMatch(/^outbox_messages_published_total\{[^}]*event_type="WalletBalanceChanged"[^}]*\} 1$/m);
    expect(text).toContain('outbox_publish_retries_total');
    expect(text).toMatch(/^outbox_publish_lag_seconds_count\{[^}]*event_type="WagerTransactionProcessed"[^}]*\} 1$/m);
    expect(text).toContain('outbox_publish_lag_seconds_bucket');
    await assertWalletConsistent(orm, wallet.id);
  });

  it('reports the age of a pending event that is not due yet, and does not publish it', async () => {
    const dueLater = new Date(Date.now() + 3_600_000);
    const occurredAt = new Date(Date.now() - 120_000);
    const eventId = Bun.randomUUIDv7();
    const aggregateId = Bun.randomUUIDv7();
    const notDue = OutboxMessage.rehydrate({
      id: eventId,
      aggregateId,
      eventType: 'WagerTransactionProcessed',
      payload: { eventId, eventType: 'WagerTransactionProcessed', aggregateId, correlationId: 'corr-1' },
      occurredAt,
      attempts: 3,
      nextAttemptAt: dueLater,
      publishedAt: undefined,
    });
    await inTransaction(orm, () => app.get(OutboxRepository).insert(notDue));

    const text = await waitFor(async () => {
      const current = await metricsText();
      return (sampleOf(current, 'outbox_oldest_pending_age_seconds') ?? 0) >= 120 ? current : null;
    });

    expect(sampleOf(text, 'outbox_oldest_pending_age_seconds')).toBeLessThan(600);
    expect(await pendingCount()).toBe(1);
    expect(await receiveAll(sqs, urls.events)).toEqual([]);
  });

  it('stops promptly on app.close() even while it waits for the next cycle', async () => {
    const idle = await createTestApp({ outboxPublisher: { pollIntervalMs: 60_000 } });

    const startedAt = performance.now();
    await idle.close();

    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});
