import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { WagerTransactionStatus } from '../../../../src/modules/wagering/domain/wager-transaction';
import type {
  SubmitResponse,
  TransactionResponse,
} from '../../../../src/modules/wagering/presentation/wager-transaction-http.schemas';
import type {
  ReconciliationResponse,
  WalletResponse,
} from '../../../../src/modules/wallet/presentation/wallet-http.schemas';
import { ExponentialBackoff } from '../../../../src/shared/domain/exponential-backoff';
import { createTestApp } from '../../../support/create-test-app';
import { resetDatabase } from '../../../support/database';
import { newProviderId } from '../../../support/fixtures';
import { getJson, postJson } from '../../../support/http';
import { createLogCapture } from '../../../support/log-capture';
import { hasMetricFamily, sampleValue, scrapeMetrics } from '../../../support/metrics';
import {
  buildEnvelope,
  createTestSqsClient,
  purgeQueue,
  sendEnvelope,
  sendRaw,
  testQueueUrls,
  waitFor,
} from '../../../support/sqs';
import { assertWalletConsistent } from '../../../support/wallet-consistency';

const LONG_POLL_SECONDS = 1;

/** Atraso fixo de 1 s (jitter 0): a visibilidade do retry é previsível. */
const FIXED_ONE_SECOND_BACKOFF = () =>
  new ExponentialBackoff({ baseDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }, Math.random);

/** Toda família de métricas documentada na seção "Métricas (§12)" do ARCHITECTURE.md. */
const DOCUMENTED_METRICS = [
  'wager_transactions_total',
  'wager_transaction_duplicates_total',
  'wager_transaction_processing_seconds',
  'sqs_consumer_messages_total',
  'lock_conflicts_total',
  'outbox_messages_published_total',
  'outbox_publish_retries_total',
  'outbox_publish_lag_seconds',
  'outbox_oldest_pending_age_seconds',
  'pending_reference_reprocessed_total',
  'wallet_reconciliation_divergences_total',
];

type Payload = Record<string, unknown>;

function brl(amount: string) {
  return { amount, currency: 'BRL' };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Segura o `FOR UPDATE` da wallet até `release()`: o consumer, preso no lock, falha com `LOCK_TIMEOUT`. */
async function holdWalletLock(orm: MikroORM, walletId: string): Promise<{ release: () => Promise<void> }> {
  const locked = deferred();
  const released = deferred();
  const owner = orm.em.fork().transactional(async (em) => {
    await em.execute('select id from wallets where id = ? for update', [walletId]);
    locked.resolve();
    await released.promise;
  });
  await Promise.race([locked.promise, owner]);
  return {
    release: async () => {
      released.resolve();
      await owner;
    },
  };
}

/** Pendentes e outbox de outras suítes seriam processados assim que os workers subissem: o banco é limpo antes. */
async function resetWithTemporaryApp(): Promise<void> {
  const cleaner = await createTestApp();
  await resetDatabase(cleaner.get(MikroORM));
  await cleaner.close();
}

describe('metrics coverage (app, Postgres e LocalStack reais)', () => {
  const capture = createLogCapture();
  const sqs = createTestSqsClient();
  const urls = testQueueUrls();
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  const providerId = newProviderId();
  const playerId = Bun.randomUUIDv7();
  let walletId: string;
  let firstBetCorrelationId: string;
  let firstBetTransactionId: string;

  async function purgeQueues(): Promise<void> {
    await purgeQueue(sqs, urls.wager);
    await purgeQueue(sqs, urls.dlq);
    await purgeQueue(sqs, urls.events);
  }

  beforeAll(async () => {
    await resetWithTemporaryApp();
    await purgeQueues();
    app = await createTestApp({
      logDestination: capture.stream,
      sqsConsumer: {
        waitTimeSeconds: LONG_POLL_SECONDS,
        retryBackoff: FIXED_ONE_SECOND_BACKOFF(),
        shutdownTimeoutMs: 10000,
      },
      outboxPublisher: { pollIntervalMs: 100 },
      pendingReferenceWorker: { pollIntervalMs: 100, retryBaseDelayMs: 50, retryMaxDelayMs: 100 },
      unitOfWork: { lockTimeoutMs: 200, maxAttempts: 1 },
    });
    orm = app.get(MikroORM);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    // O long poll abortado pelo `stop` segue no servidor até `WaitTimeSeconds` e ficaria com a próxima mensagem.
    await Bun.sleep(LONG_POLL_SECONDS * 1000 + 200);
    await purgeQueues();
    sqs.destroy();
    await resetWithTemporaryApp();
  });

  const scrape = () => scrapeMetrics(baseUrl);

  async function openWallet(owner: string, correlationId?: string): Promise<WalletResponse> {
    const response = await postJson<WalletResponse>(
      baseUrl,
      '/wallets',
      { playerId: owner, initialBalance: brl('100.00') },
      correlationId === undefined ? {} : { 'X-Correlation-Id': correlationId },
    );
    expect(response.status).toBe(201);
    return response.body;
  }

  function payload(externalTransactionId: string, overrides: Payload = {}): Payload {
    return {
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId: `round-${externalTransactionId}`,
      gameId: 'game-1',
      kind: 'BET',
      money: brl('10.00'),
      ...overrides,
    };
  }

  function submit(body: Payload, key: string, correlationId?: string) {
    return postJson<SubmitResponse>(baseUrl, '/wagering/transactions', body, {
      'Idempotency-Key': key,
      ...(correlationId === undefined ? {} : { 'X-Correlation-Id': correlationId }),
    });
  }

  function waitForStatus(externalTransactionId: string, status: WagerTransactionStatus): Promise<TransactionResponse> {
    return waitFor(async () => {
      const response = await getJson<TransactionResponse>(
        baseUrl,
        `/providers/${providerId}/wagering/transactions/${externalTransactionId}`,
      );
      return response.status === 200 && response.body.status === status ? response.body : null;
    });
  }

  function waitForMetric(name: string, labels: Record<string, string>, atLeast: number): Promise<string> {
    return waitFor(async () => {
      const text = await scrape();
      return sampleValue(text, name, labels) >= atLeast ? text : null;
    });
  }

  it('opens a wallet and logs its id on the "request completed" line', async () => {
    const correlationId = `corr-wallet-${Bun.randomUUIDv7()}`;

    const wallet = await openWallet(playerId, correlationId);
    walletId = wallet.id;

    const line = await capture.waitFor((entry) => entry.msg === 'request completed' && entry.correlationId === correlationId);
    expect(line.walletId).toBe(walletId);
  });

  it('counts HTTP decisions, a replay by idempotency key and a REFUND resolved by the worker', async () => {
    firstBetCorrelationId = `corr-bet-${Bun.randomUUIDv7()}`;
    const first = await submit(payload('http-bet-1', { money: brl('25.00') }), 'key-http-bet-1', firstBetCorrelationId);
    expect(first.status).toBe(200);
    expect(first.body.idempotentReplay).toBe(false);
    firstBetTransactionId = first.body.transactionId;

    const replay = await submit(payload('http-bet-1', { money: brl('25.00') }), 'key-http-bet-1');
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);

    const tooBig = await submit(payload('http-bet-too-big', { money: brl('500.00') }), 'key-http-bet-too-big');
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.status).toBe(WagerTransactionStatus.Rejected);

    // A referência exige a mesma rodada da transação revertida.
    const refund = await submit(
      payload('http-refund-1', {
        kind: 'REFUND',
        roundId: 'round-http-bet-2',
        referenceExternalTransactionId: 'http-bet-2',
      }),
      'key-http-refund-1',
    );
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe(WagerTransactionStatus.PendingReference);

    const referenced = await submit(payload('http-bet-2'), 'key-http-bet-2');
    expect(referenced.status).toBe(200);
    await waitForStatus('http-refund-1', WagerTransactionStatus.Processed);
  });

  it('counts SQS decisions, an inbox duplicate, a DLQ message and a lock retry', async () => {
    const messageId = Bun.randomUUIDv7();
    const envelope = buildEnvelope({ messageId, data: payload('sqs-bet-1') });
    await sendEnvelope(sqs, urls.wager, envelope, { groupId: walletId });
    await waitForStatus('sqs-bet-1', WagerTransactionStatus.Processed);

    // Mesmo `messageId` com outro id de deduplicação do FIFO: só a inbox reconhece a reentrega.
    await sendEnvelope(sqs, urls.wager, envelope, { groupId: walletId });
    await waitForMetric('wager_transaction_duplicates_total', { channel: 'sqs', detected_by: 'inbox' }, 1);

    await sendRaw(sqs, urls.wager, 'not json', { groupId: walletId });
    await waitForMetric('sqs_consumer_messages_total', { outcome: 'dead_lettered' }, 1);

    const lock = await holdWalletLock(orm, walletId);
    try {
      await sendEnvelope(sqs, urls.wager, buildEnvelope({ data: payload('sqs-bet-2') }), { groupId: walletId });
      await capture.waitFor((line) => line.msg === 'sqs message retry' && line.walletId === walletId, 10000);
    } finally {
      await lock.release();
    }
    await waitForStatus('sqs-bet-2', WagerTransactionStatus.Processed);
  });

  it('counts a reconciliation divergence forced by SQL on a second wallet', async () => {
    const divergent = await openWallet(Bun.randomUUIDv7());
    await orm.em.fork().execute('update wallets set balance = balance + ?::numeric where id = ?', ['10.00', divergent.id]);

    const reconciliation = await postJson<ReconciliationResponse>(baseUrl, `/wallets/${divergent.id}/reconciliation`, {});

    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body.consistent).toBe(false);
  });

  it('exposes every required counter on GET /metrics after the flow', async () => {
    const text = await waitForMetric('outbox_publish_lag_seconds_count', {}, 1);

    const decisions = (labels: Record<string, string>) => sampleValue(text, 'wager_transactions_total', labels);
    expect(decisions({ status: 'PROCESSED', source: 'http' })).toBeGreaterThanOrEqual(2);
    expect(decisions({ status: 'REJECTED', source: 'http' })).toBe(1);
    expect(decisions({ status: 'PENDING_REFERENCE', source: 'http' })).toBe(1);
    expect(decisions({ status: 'PROCESSED', source: 'sqs' })).toBeGreaterThanOrEqual(2);
    expect(decisions({ status: 'PROCESSED', source: 'pending_reference_worker' })).toBe(1);

    const duplicates = (labels: Record<string, string>) =>
      sampleValue(text, 'wager_transaction_duplicates_total', labels);
    expect(duplicates({ channel: 'http', detected_by: 'idempotency_key' })).toBe(1);
    expect(duplicates({ channel: 'sqs', detected_by: 'inbox' })).toBe(1);

    const latency = (labels: Record<string, string>) =>
      sampleValue(text, 'wager_transaction_processing_seconds_count', labels);
    expect(latency({ channel: 'http' })).toBeGreaterThan(0);
    expect(latency({ channel: 'sqs' })).toBeGreaterThan(0);
    expect(latency({ outcome: 'failed' })).toBeGreaterThanOrEqual(1);
    expect(latency({ outcome: 'replayed' })).toBe(2);

    const consumed = (outcome: string) => sampleValue(text, 'sqs_consumer_messages_total', { outcome });
    expect(consumed('retried')).toBeGreaterThanOrEqual(1);
    expect(consumed('dead_lettered')).toBe(1);
    expect(consumed('replayed')).toBe(1);

    expect(sampleValue(text, 'lock_conflicts_total', { reason: 'lock_timeout' })).toBeGreaterThanOrEqual(1);
    expect(sampleValue(text, 'outbox_publish_lag_seconds_count')).toBeGreaterThan(0);
    expect(sampleValue(text, 'wallet_reconciliation_divergences_total', { currency: 'BRL' })).toBe(1);
    for (const name of DOCUMENTED_METRICS) {
      expect(hasMetricFamily(text, name)).toBe(true);
    }
  });

  it('logs the context ids on the "request completed" line and never a financial value', async () => {
    const line = await capture.waitFor(
      (entry) => entry.msg === 'request completed' && entry.correlationId === firstBetCorrelationId,
    );

    expect(line.walletId).toBe(walletId);
    expect(line.providerId).toBe(providerId);
    expect(line.transactionId).toBe(firstBetTransactionId);
    expect(capture.raw()).not.toContain('"25.00"');
    expect(capture.raw()).not.toContain('"500.00"');
  });

  it('leaves the wallet of the flow consistent with its ledger', async () => {
    const wallet = await getJson<WalletResponse>(baseUrl, `/wallets/${walletId}`);

    // 100.00 - 25.00 (BET) - 10.00 (BET) + 10.00 (REFUND) - 10.00 (SQS) - 10.00 (SQS após o retry)
    expect(wallet.body.balance).toEqual(brl('55.00'));
    await assertWalletConsistent(orm, walletId);
  });
});
