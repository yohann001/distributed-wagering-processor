import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Registry } from 'prom-client';

import { WAGER_TRANSACTIONS_CONSUMER } from '../../../../../../src/modules/messaging/infrastructure/sqs/sqs-consumer-options';
import { WagerTransactionStatus } from '../../../../../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../../../../../src/shared/domain/failure-code';
import { ExponentialBackoff } from '../../../../../../src/shared/domain/exponential-backoff';
import { createTestApp } from '../../../../../support/create-test-app';
import { newProviderId, openWalletWithBalance } from '../../../../../support/fixtures';
import { createLogCapture, type LogCapture, type LogLine } from '../../../../../support/log-capture';
import { sampleValue, scrapeMetrics } from '../../../../../support/metrics';
import {
  buildEnvelope,
  createTestSqsClient,
  purgeQueue,
  queueDepth,
  receiveAll,
  sendEnvelope,
  sendRaw,
  testQueueUrls,
  waitFor,
} from '../../../../../support/sqs';
import { assertWalletConsistent } from '../../../../../support/wallet-consistency';

interface Scenario {
  walletId: string;
  playerId: string;
  providerId: string;
}

interface TransactionRow {
  id: string;
  status: string;
  failure_code: string | null;
  balance_after: string | null;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function betData(scenario: Scenario, externalTransactionId: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId: scenario.providerId,
    externalTransactionId,
    playerId: scenario.playerId,
    walletId: scenario.walletId,
    roundId: `round-${externalTransactionId}`,
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
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

async function transactionRow(
  orm: MikroORM,
  providerId: string,
  externalTransactionId: string,
): Promise<TransactionRow | null> {
  const rows = await orm.em
    .fork()
    .execute<TransactionRow[]>(
      `select id, status, failure_code, balance_after::text as balance_after
         from wager_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
  return rows[0] ?? null;
}

async function waitForStatus(
  orm: MikroORM,
  providerId: string,
  externalTransactionId: string,
  status: WagerTransactionStatus,
): Promise<TransactionRow> {
  return waitFor(async () => {
    const row = await transactionRow(orm, providerId, externalTransactionId);
    return row?.status === status ? row : null;
  });
}

async function count(orm: MikroORM, sql: string, params: unknown[]): Promise<number> {
  const rows = await orm.em.fork().execute<{ total: number }[]>(`select count(*)::int as total ${sql}`, params);
  return rows[0]?.total ?? 0;
}

const debitCount = (orm: MikroORM, walletId: string) =>
  count(orm, "from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]);

const inboxCount = (orm: MikroORM, messageId: string) =>
  count(orm, 'from inbox_messages where consumer_name = ? and message_id = ?', [
    WAGER_TRANSACTIONS_CONSUMER,
    messageId,
  ]);

const transactionCount = (orm: MikroORM, providerId: string) =>
  count(orm, 'from wager_transactions where provider_id = ?', [providerId]);

/** A confirmação (`DeleteMessage`) vem depois do commit, então o esvaziamento da fila é esperado, não instantâneo. */
async function waitForEmptyQueue(client: SQSClient, queueUrl: string): Promise<void> {
  await waitFor(async () => {
    const depth = await queueDepth(client, queueUrl);
    return depth.visible === 0 && depth.inFlight === 0 ? true : null;
  });
}

function processedLines(capture: LogCapture, predicate: (line: LogLine) => boolean): LogLine[] {
  return capture.lines().filter((line) => line.msg === 'sqs message processed' && predicate(line));
}

function timeOf(line: LogLine): number {
  return Date.parse(String(line.time));
}

function failureCodeOf(message: Message | undefined): string | undefined {
  return message?.MessageAttributes?.failureCode?.StringValue;
}

function receiveCountOf(message: Message | undefined): string | undefined {
  return message?.MessageAttributes?.receiveCount?.StringValue;
}

/** Atraso fixo de 1 s (jitter 0): a visibilidade do retry é previsível. */
const FIXED_ONE_SECOND_BACKOFF = () =>
  new ExponentialBackoff({ baseDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }, Math.random);

const LONG_POLL_SECONDS = 1;

/**
 * Fecha o app e espera o fim do long poll que o `stop` abortou. O servidor segue com o `ReceiveMessage` até
 * `WaitTimeSeconds` e entrega a próxima mensagem a essa conexão morta: ela fica em voo até a visibilidade
 * expirar. Sem a espera, esse long poll roubaria a primeira mensagem do teste seguinte.
 */
async function closeAndWaitForAbortedLongPoll(app: INestApplication): Promise<void> {
  await app.close();
  await Bun.sleep(LONG_POLL_SECONDS * 1000 + 200);
}

describe('SQS wager consumer (app, Postgres e LocalStack reais)', () => {
  const capture = createLogCapture();
  const sqs = createTestSqsClient();
  const urls = testQueueUrls();
  let app: INestApplication;
  let orm: MikroORM;

  beforeAll(async () => {
    app = await createTestApp({
      logDestination: capture.stream,
      sqsConsumer: {
        waitTimeSeconds: LONG_POLL_SECONDS,
        maxReceives: 2,
        retryBackoff: FIXED_ONE_SECOND_BACKOFF(),
        shutdownTimeoutMs: 10000,
      },
      unitOfWork: { lockTimeoutMs: 200, maxAttempts: 1 },
    });
    orm = app.get(MikroORM);
  });

  afterAll(async () => {
    await closeAndWaitForAbortedLongPoll(app);
    sqs.destroy();
  });

  beforeEach(async () => {
    await purgeQueue(sqs, urls.wager);
    await purgeQueue(sqs, urls.dlq);
  });

  async function newScenario(balance = '100.00'): Promise<Scenario> {
    const { wallet } = await openWalletWithBalance(app, { amount: balance });
    return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
  }

  it('processes a valid envelope, records it in the inbox and deletes the message', async () => {
    const scenario = await newScenario();
    const messageId = Bun.randomUUIDv7();

    await sendEnvelope(sqs, urls.wager, buildEnvelope({ messageId, data: betData(scenario, 'bet-1') }), {
      groupId: scenario.walletId,
    });

    const row = await waitForStatus(orm, scenario.providerId, 'bet-1', WagerTransactionStatus.Processed);
    expect(row.balance_after).toBe('75.00');
    const inbox = await orm.em
      .fork()
      .execute<{ processed_at: Date | null }[]>(
        'select processed_at from inbox_messages where consumer_name = ? and message_id = ?',
        [WAGER_TRANSACTIONS_CONSUMER, messageId],
      );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.processed_at).not.toBeNull();
    await waitForEmptyQueue(sqs, urls.wager);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('logs the processed message with the correlation id from the message attribute and the ids of the context', async () => {
    const scenario = await newScenario();
    const messageId = Bun.randomUUIDv7();
    const correlationId = `corr-${Bun.randomUUIDv7()}`;

    await sendEnvelope(sqs, urls.wager, buildEnvelope({ messageId, data: betData(scenario, 'bet-1') }), {
      groupId: scenario.walletId,
      correlationId,
    });

    const line = await capture.waitFor(
      (entry) => entry.msg === 'sqs message processed' && entry.correlationId === correlationId,
      10000,
    );
    expect(line.messageId).toBe(messageId);
    expect(line.walletId).toBe(scenario.walletId);
    expect(line.providerId).toBe(scenario.providerId);
    expect(typeof line.transactionId).toBe('string');
    expect(line.status).toBe(WagerTransactionStatus.Processed);
    // Valores financeiros e o corpo nunca vão para o log (§12).
    expect(JSON.stringify(line)).not.toContain('25.00');
    await waitForEmptyQueue(sqs, urls.wager);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('applies the effect once when the same message is delivered twice, and acks both deliveries', async () => {
    const scenario = await newScenario();
    const messageId = Bun.randomUUIDv7();
    const envelope = buildEnvelope({ messageId, data: betData(scenario, 'bet-1') });

    // Ids de deduplicação diferentes: o dedup do FIFO não segura a segunda, só a inbox e a idempotency key.
    await sendEnvelope(sqs, urls.wager, envelope, { groupId: scenario.walletId });
    await sendEnvelope(sqs, urls.wager, envelope, { groupId: scenario.walletId });

    await waitFor(async () => {
      const lines = processedLines(capture, (line) => line.messageId === messageId);
      return lines.length === 2 ? lines : null;
    });
    const replays = processedLines(capture, (line) => line.messageId === messageId).map((line) => line.idempotentReplay);
    expect(replays.sort()).toEqual([false, true]);
    expect(await transactionCount(orm, scenario.providerId)).toBe(1);
    expect(await debitCount(orm, scenario.walletId)).toBe(1);
    expect(await inboxCount(orm, messageId)).toBe(1);
    await waitForEmptyQueue(sqs, urls.wager);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('sends the same messageId with another payload to the DLQ and leaves the original untouched', async () => {
    const scenario = await newScenario();
    const messageId = Bun.randomUUIDv7();

    await sendEnvelope(sqs, urls.wager, buildEnvelope({ messageId, data: betData(scenario, 'bet-a') }), {
      groupId: scenario.walletId,
    });
    await waitForStatus(orm, scenario.providerId, 'bet-a', WagerTransactionStatus.Processed);

    const conflicting = buildEnvelope({ messageId, data: betData(scenario, 'bet-b') });
    await sendEnvelope(sqs, urls.wager, conflicting, { groupId: scenario.walletId });

    const [dead, ...others] = await receiveAll(sqs, urls.dlq, { expected: 1, timeoutMs: 10000 });
    expect(others).toHaveLength(0);
    expect(failureCodeOf(dead)).toBe(FailureCode.IdempotencyConflict);
    expect(receiveCountOf(dead)).toBe('1');
    expect(dead?.Body).toBe(JSON.stringify(conflicting));
    expect(await transactionRow(orm, scenario.providerId, 'bet-b')).toBeNull();
    expect((await transactionRow(orm, scenario.providerId, 'bet-a'))?.balance_after).toBe('75.00');
    expect(await debitCount(orm, scenario.walletId)).toBe(1);
    await waitForEmptyQueue(sqs, urls.wager);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('persists a business rejection as REJECTED and acks it, without touching the DLQ', async () => {
    const scenario = await newScenario();

    await sendEnvelope(
      sqs,
      urls.wager,
      buildEnvelope({
        data: betData(scenario, 'bet-too-big', { money: { amount: '500.00', currency: 'BRL' } }),
      }),
      { groupId: scenario.walletId },
    );

    const row = await waitForStatus(orm, scenario.providerId, 'bet-too-big', WagerTransactionStatus.Rejected);
    expect(row.failure_code).toBe(FailureCode.InsufficientFunds);
    await waitForEmptyQueue(sqs, urls.wager);
    expect(await receiveAll(sqs, urls.dlq)).toEqual([]);
    expect(await debitCount(orm, scenario.walletId)).toBe(0);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('retries a transient failure after the backoff and processes it exactly once when the lock is released', async () => {
    const scenario = await newScenario();
    const lock = await holdWalletLock(orm, scenario.walletId);
    let retryLine: LogLine;

    try {
      await sendEnvelope(sqs, urls.wager, buildEnvelope({ data: betData(scenario, 'bet-1') }), {
        groupId: scenario.walletId,
      });
      retryLine = await capture.waitFor(
        (line) => line.msg === 'sqs message retry' && line.walletId === scenario.walletId,
        10000,
      );
    } finally {
      await lock.release();
    }

    expect(retryLine.failureCode).toBe(FailureCode.TransientFailure);
    expect(retryLine.visibilityTimeoutSeconds).toBe(1);
    await waitForStatus(orm, scenario.providerId, 'bet-1', WagerTransactionStatus.Processed);
    const [processed] = processedLines(capture, (line) => line.walletId === scenario.walletId);
    expect(Number(processed?.receiveCount)).toBeGreaterThanOrEqual(2);
    // A visibilidade de 1 s adia a segunda tentativa; a folga cobre o intervalo entre a mudança e o log do retry.
    expect(timeOf(processed ?? {}) - timeOf(retryLine)).toBeGreaterThanOrEqual(900);
    expect(await debitCount(orm, scenario.walletId)).toBe(1);
    await waitForEmptyQueue(sqs, urls.wager);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('dead-letters a message that keeps failing transiently once the receive limit is reached', async () => {
    const scenario = await newScenario();
    const lock = await holdWalletLock(orm, scenario.walletId);
    let dead: Message[];

    try {
      await sendEnvelope(sqs, urls.wager, buildEnvelope({ data: betData(scenario, 'bet-poison') }), {
        groupId: scenario.walletId,
      });
      dead = await receiveAll(sqs, urls.dlq, { expected: 1, timeoutMs: 15000 });
    } finally {
      await lock.release();
    }

    expect(dead).toHaveLength(1);
    expect(failureCodeOf(dead[0])).toBe(FailureCode.TransientFailure);
    expect(receiveCountOf(dead[0])).toBe('2');
    expect(await transactionRow(orm, scenario.providerId, 'bet-poison')).toBeNull();
    await waitForEmptyQueue(sqs, urls.wager);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('sends invalid envelopes straight to the DLQ on the first receive', async () => {
    const scenario = await newScenario();
    const notJson = 'not json';
    const wrongType = JSON.stringify({ ...buildEnvelope({ data: betData(scenario, 'bet-1') }), type: 'Other' });
    const openingKind = JSON.stringify(buildEnvelope({ data: betData(scenario, 'bet-2', { kind: 'OPENING' }) }));
    const colonProvider = JSON.stringify(
      buildEnvelope({ data: betData(scenario, 'bet-3', { providerId: 'provider:with-colon' }) }),
    );
    const numericAmount = JSON.stringify(
      buildEnvelope({ data: betData(scenario, 'bet-4', { money: { amount: 25, currency: 'BRL' } }) }),
    );

    for (const body of [notJson, wrongType, openingKind, colonProvider, numericAmount]) {
      await sendRaw(sqs, urls.wager, body, { groupId: scenario.walletId });
    }

    const dead = await receiveAll(sqs, urls.dlq, { expected: 5, timeoutMs: 15000 });
    const codeByBody = new Map(dead.map((message) => [message.Body, failureCodeOf(message)]));
    expect(dead).toHaveLength(5);
    expect(codeByBody.get(notJson)).toBe(FailureCode.InvalidPayload);
    expect(codeByBody.get(wrongType)).toBe(FailureCode.InvalidPayload);
    expect(codeByBody.get(openingKind)).toBe(FailureCode.KindNotAllowed);
    expect(codeByBody.get(colonProvider)).toBe(FailureCode.InvalidPayload);
    expect(codeByBody.get(numericAmount)).toBe(FailureCode.InvalidMoney);
    expect(dead.every((message) => receiveCountOf(message) === '1')).toBe(true);
    expect(await transactionCount(orm, scenario.providerId)).toBe(0);
    await waitForEmptyQueue(sqs, urls.wager);
  });
});

describe('SQS wager consumer: shutdown (app, Postgres e LocalStack reais)', () => {
  const capture = createLogCapture();
  const sqs = createTestSqsClient();
  const urls = testQueueUrls();
  let fixtureApp: INestApplication;
  let orm: MikroORM;

  /** O consumer só liga com `sqsConsumer`; sem ele, `fixtureApp` abre wallets e lê o banco sem roubar mensagens. */
  function createConsumerApp(): Promise<INestApplication> {
    return createTestApp({
      logDestination: capture.stream,
      sqsConsumer: { waitTimeSeconds: LONG_POLL_SECONDS, batchSize: 10, shutdownTimeoutMs: 10000 },
      unitOfWork: { lockTimeoutMs: 5000, maxAttempts: 1 },
    });
  }

  beforeAll(async () => {
    fixtureApp = await createTestApp();
    orm = fixtureApp.get(MikroORM);
    await purgeQueue(sqs, urls.wager);
    await purgeQueue(sqs, urls.dlq);
  });

  afterAll(async () => {
    await fixtureApp?.close();
    sqs.destroy();
  });

  /** Há uma query esperando por lock de linha em `wallets`: o consumer está preso na transação do lock. */
  async function consumerBlockedOnWalletLock(): Promise<true | null> {
    const blocked = await count(
      orm,
      `from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike '%wallets%'`,
      [],
    );
    return blocked > 0 ? true : null;
  }

  it('lets the message in flight finish, releases the one that did not start, and loses nothing', async () => {
    const { wallet } = await openWalletWithBalance(fixtureApp, { amount: '100.00' });
    const scenario: Scenario = { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
    const lock = await holdWalletLock(orm, scenario.walletId);
    let first: INestApplication | undefined;
    let closing: Promise<void> | undefined;
    let releasedBeforeStop: number | undefined;

    try {
      // As duas mensagens entram antes do consumer subir, para o mesmo receive trazer as duas.
      for (const externalTransactionId of ['bet-1', 'bet-2']) {
        await sendEnvelope(
          sqs,
          urls.wager,
          buildEnvelope({
            data: betData(scenario, externalTransactionId, { money: { amount: '10.00', currency: 'BRL' } }),
          }),
          { groupId: scenario.walletId },
        );
      }
      first = await createConsumerApp();
      const registry = first.get(Registry);
      await waitFor(consumerBlockedOnWalletLock);

      closing = first.close();
      await Bun.sleep(200);
      await lock.release();
      await closing;
      releasedBeforeStop = (await registry.getSingleMetric('sqs_consumer_messages_total')?.get())?.values.find(
        (value) => value.labels.outcome === 'released',
      )?.value;
    } finally {
      await lock.release();
      await (closing ?? first?.close());
    }

    expect((await transactionRow(orm, scenario.providerId, 'bet-1'))?.status).toBe(WagerTransactionStatus.Processed);
    expect(await transactionRow(orm, scenario.providerId, 'bet-2')).toBeNull();
    expect(releasedBeforeStop).toBe(1);
    await waitFor(async () => {
      const depth = await queueDepth(sqs, urls.wager);
      return depth.visible === 1 && depth.inFlight === 0 ? true : null;
    });

    const second = await createConsumerApp();
    try {
      await waitForStatus(orm, scenario.providerId, 'bet-2', WagerTransactionStatus.Processed);
      await waitForEmptyQueue(sqs, urls.wager);
      expect(await debitCount(orm, scenario.walletId)).toBe(2);
      await assertWalletConsistent(orm, scenario.walletId);
    } finally {
      await closeAndWaitForAbortedLongPoll(second);
    }
  });
});

describe('SQS wager consumer: DLQ unavailable (app, Postgres e LocalStack reais)', () => {
  const capture = createLogCapture();
  const sqs = createTestSqsClient();
  const urls = testQueueUrls();
  let app: INestApplication;

  beforeAll(async () => {
    await purgeQueue(sqs, urls.wager);
    await purgeQueue(sqs, urls.dlq);
    // Mesmo LocalStack, fila que não existe: o `SendMessage` à DLQ falha com `QueueDoesNotExist`.
    const missingDlq = urls.dlq.replace(/[^/]+$/, `does-not-exist-${Bun.randomUUIDv7()}.fifo`);
    app = await createTestApp({
      logDestination: capture.stream,
      sqsConsumer: { waitTimeSeconds: LONG_POLL_SECONDS, deadLetterQueueUrl: missingDlq, shutdownTimeoutMs: 10000 },
    });
  });

  afterAll(async () => {
    await closeAndWaitForAbortedLongPoll(app);
    await purgeQueue(sqs, urls.wager);
    sqs.destroy();
  });

  it('neither counts nor logs a dead-letter when the send to the DLQ fails, and keeps the message in the queue', async () => {
    await sendRaw(sqs, urls.wager, 'not json', { groupId: Bun.randomUUIDv7() });

    await capture.waitFor((line) => line.msg === 'sqs dead-letter send failed', 10000);

    const metrics = await scrapeMetrics(await app.getUrl());
    expect(sampleValue(metrics, 'sqs_consumer_messages_total', { outcome: 'dead_lettered' })).toBe(0);
    expect(capture.lines().some((line) => line.msg === 'sqs message dead-lettered')).toBe(false);
    const depth = await queueDepth(sqs, urls.wager);
    expect(depth.visible + depth.inFlight).toBe(1);
    expect(await receiveAll(sqs, urls.dlq)).toEqual([]);
  });
});
