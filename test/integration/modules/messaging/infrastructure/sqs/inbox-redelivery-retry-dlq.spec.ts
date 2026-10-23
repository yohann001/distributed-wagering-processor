import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { GetQueueAttributesCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { loadEnv } from '../../../../../../src/config/env';
import {
  sqsConsumerOptionsFromEnv,
  WAGER_TRANSACTIONS_CONSUMER,
} from '../../../../../../src/modules/messaging/infrastructure/sqs/sqs-consumer-options';
import { WagerTransactionStatus } from '../../../../../../src/modules/wagering/domain/wager-transaction';
import { ExponentialBackoff } from '../../../../../../src/shared/domain/exponential-backoff';
import { FailureCode } from '../../../../../../src/shared/domain/failure-code';
import { createTestApp } from '../../../../../support/create-test-app';
import { newProviderId, openWalletWithBalance } from '../../../../../support/fixtures';
import { createLogCapture, type LogCapture, type LogLine } from '../../../../../support/log-capture';
import { sampleValue, scrapeMetrics } from '../../../../../support/metrics';
import {
  buildEnvelope,
  createTemporaryQueues,
  createTestSqsClient,
  faultySqsClient,
  queueDepth,
  receiveAll,
  sendEnvelope,
  testQueueUrls,
  waitFor,
  type TemporaryQueues,
} from '../../../../../support/sqs';
import { holdWalletLock, walletLockWaiters } from '../../../../../support/wallet-lock';
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

interface MetricRef {
  name: string;
  labels: Record<string, string>;
}

type MetricReader = (name: string, labels?: Record<string, string>) => Promise<number>;

const VISIBILITY_TIMEOUT_SECONDS = 2;
const LONG_POLL_SECONDS = 1;

const sqsOutcome = (outcome: string): MetricRef => ({ name: 'sqs_consumer_messages_total', labels: { outcome } });

/** As séries que cada cenário compara antes e depois: o teste olha a diferença, não o valor absoluto. */
const WATCHED = {
  processed: sqsOutcome('processed'),
  replayed: sqsOutcome('replayed'),
  retried: sqsOutcome('retried'),
  deadLettered: sqsOutcome('dead_lettered'),
  inboxDuplicates: {
    name: 'wager_transaction_duplicates_total',
    labels: { channel: 'sqs', detected_by: 'inbox' },
  },
  sqsDuplicates: { name: 'wager_transaction_duplicates_total', labels: { channel: 'sqs' } },
  lockTimeouts: { name: 'lock_conflicts_total', labels: { reason: 'lock_timeout' } },
} satisfies Record<string, MetricRef>;

type WatchedKey = keyof typeof WATCHED;

/** Soma a série de todos os apps: com duas instâncias, qualquer uma pode ter processado a mensagem. */
function metricsOf(apps: INestApplication[]): MetricReader {
  return async (name, labels = {}) => {
    let total = 0;
    for (const app of apps) {
      total += sampleValue(await scrapeMetrics(await app.getUrl()), name, labels);
    }
    return total;
  };
}

async function readWatched(read: MetricReader): Promise<Record<WatchedKey, number>> {
  const keys = Object.keys(WATCHED) as WatchedKey[];
  const entries = await Promise.all(keys.map(async (key) => [key, await read(WATCHED[key].name, WATCHED[key].labels)] as const));
  return Object.fromEntries(entries) as Record<WatchedKey, number>;
}

/** Fotografa as séries agora; a função devolvida dá a diferença até o momento em que for chamada. */
async function watchMetrics(read: MetricReader): Promise<() => Promise<Record<WatchedKey, number>>> {
  const before = await readWatched(read);
  return async () => {
    const after = await readWatched(read);
    const keys = Object.keys(WATCHED) as WatchedKey[];
    return Object.fromEntries(keys.map((key) => [key, after[key] - before[key]])) as Record<WatchedKey, number>;
  };
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

async function newScenario(app: INestApplication, balance = '100.00'): Promise<Scenario> {
  const { wallet } = await openWalletWithBalance(app, { amount: balance });
  return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
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
async function waitForEmptyQueue(client: SQSClient, queueUrl: string, timeoutMs = 10000): Promise<void> {
  await waitFor(async () => {
    const depth = await queueDepth(client, queueUrl);
    return depth.visible === 0 && depth.inFlight === 0 ? true : null;
  }, timeoutMs);
}

function processedLines(capture: LogCapture, predicate: (line: LogLine) => boolean): LogLine[] {
  return capture.lines().filter((line) => line.msg === 'sqs message processed' && predicate(line));
}

function linesOf(capture: LogCapture, msg: string, predicate: (line: LogLine) => boolean): LogLine[] {
  return capture.lines().filter((line) => line.msg === msg && predicate(line));
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

/**
 * Fecha os apps e espera o fim do long poll que o `stop` abortou. O servidor segue com o `ReceiveMessage` até
 * `WaitTimeSeconds` e entrega a próxima mensagem a essa conexão morta: ela fica em voo até a visibilidade
 * expirar. Sem a espera, esse long poll roubaria a primeira mensagem do teste seguinte.
 */
async function closeAndWaitForAbortedLongPoll(apps: INestApplication[]): Promise<void> {
  await Promise.all(apps.map((app) => app.close()));
  await Bun.sleep(LONG_POLL_SECONDS * 1000 + 200);
}

describe('SQS consumer: redelivery, retry and DLQ (single instance, temporary queues)', () => {
  const capture = createLogCapture();
  const sqs = createTestSqsClient();
  const faulty = faultySqsClient();
  let queues: TemporaryQueues;
  let app: INestApplication;
  let orm: MikroORM;
  let read: MetricReader;

  beforeAll(async () => {
    queues = await createTemporaryQueues(sqs, { visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS });
    app = await createTestApp({
      logDestination: capture.stream,
      sqsClient: faulty.client,
      sqsConsumer: {
        queueUrl: queues.queueUrl,
        deadLetterQueueUrl: queues.deadLetterQueueUrl,
        waitTimeSeconds: LONG_POLL_SECONDS,
        maxReceives: 3,
        // Jitter 0: a visibilidade do retry é previsível (1 s no primeiro, 2 s no segundo).
        retryBackoff: new ExponentialBackoff({ baseDelayMs: 1000, maxDelayMs: 2000, jitterRatio: 0 }, Math.random),
        shutdownTimeoutMs: 10000,
      },
      unitOfWork: { lockTimeoutMs: 200, maxAttempts: 1 },
    });
    orm = app.get(MikroORM);
    read = metricsOf([app]);
  });

  afterAll(async () => {
    await closeAndWaitForAbortedLongPoll([app]);
    await queues.remove();
    faulty.client.destroy();
    sqs.destroy();
  });

  it('redelivers the message after the visibility timeout when the ack is lost, and applies it once', async () => {
    const scenario = await newScenario(app);
    const messageId = Bun.randomUUIDv7();
    const deltas = await watchMetrics(read);
    faulty.failNext('DeleteMessageCommand');

    await sendEnvelope(sqs, queues.queueUrl, buildEnvelope({ messageId, data: betData(scenario, 'bet-1') }), {
      groupId: scenario.walletId,
    });

    const lines = await waitFor(async () => {
      const found = processedLines(capture, (line) => line.messageId === messageId);
      return found.length >= 2 ? found : null;
    }, 20000);
    const [first, second] = lines;
    expect(lines.map((line) => line.idempotentReplay)).toEqual([false, true]);
    expect(Number(first?.receiveCount)).toBe(1);
    expect(Number(second?.receiveCount)).toBe(2);
    // A segunda entrega só existe depois que a visibilidade (2 s) expira; a folga cobre o intervalo entre o receive e o log.
    expect(timeOf(second ?? {}) - timeOf(first ?? {})).toBeGreaterThanOrEqual(1500);
    expect(linesOf(capture, 'sqs ack failed', (line) => line.messageId === messageId)).toHaveLength(1);

    expect(await transactionCount(orm, scenario.providerId)).toBe(1);
    expect(await debitCount(orm, scenario.walletId)).toBe(1);
    expect(await inboxCount(orm, messageId)).toBe(1);
    await waitForEmptyQueue(sqs, queues.queueUrl);
    expect(await deltas()).toMatchObject({ processed: 1, replayed: 1, inboxDuplicates: 1, retried: 0, deadLettered: 0 });
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('retries a transient failure with backoff and processes it exactly once', async () => {
    const scenario = await newScenario(app);
    const messageId = Bun.randomUUIDv7();
    const deltas = await watchMetrics(read);
    const lock = await holdWalletLock(orm, scenario.walletId);
    let retryLine: LogLine;

    try {
      await sendEnvelope(sqs, queues.queueUrl, buildEnvelope({ messageId, data: betData(scenario, 'bet-1') }), {
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
    const processed = await waitFor(async () => {
      const found = processedLines(capture, (line) => line.messageId === messageId);
      return found.length > 0 ? found : null;
    });
    expect(processed).toHaveLength(1);
    expect(Number(processed[0]?.receiveCount)).toBe(2);
    expect(processed[0]?.idempotentReplay).toBe(false);

    expect(await debitCount(orm, scenario.walletId)).toBe(1);
    expect(await inboxCount(orm, messageId)).toBe(1);
    await waitForEmptyQueue(sqs, queues.queueUrl);
    expect(await receiveAll(sqs, queues.deadLetterQueueUrl)).toEqual([]);
    const delta = await deltas();
    expect(delta).toMatchObject({ retried: 1, processed: 1, deadLettered: 0 });
    expect(delta.lockTimeouts).toBeGreaterThan(0);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('dead-letters a message that keeps failing transiently exactly at the configured receive limit', async () => {
    const scenario = await newScenario(app);
    const envelope = buildEnvelope({ data: betData(scenario, 'bet-poison') });
    const deltas = await watchMetrics(read);
    const lock = await holdWalletLock(orm, scenario.walletId);
    let dead: Message[];

    try {
      await sendEnvelope(sqs, queues.queueUrl, envelope, { groupId: scenario.walletId });
      dead = await receiveAll(sqs, queues.deadLetterQueueUrl, { expected: 1, timeoutMs: 20000 });
    } finally {
      await lock.release();
    }
    await capture.waitFor(
      (line) => line.msg === 'sqs message dead-lettered' && line.walletId === scenario.walletId,
      10000,
    );

    expect(dead).toHaveLength(1);
    expect(failureCodeOf(dead[0])).toBe(FailureCode.TransientFailure);
    expect(receiveCountOf(dead[0])).toBe('3');
    expect(dead[0]?.Body).toBe(JSON.stringify(envelope));
    // O atraso dobra a cada recebimento até o teto: 1 s depois do primeiro, 2 s depois do segundo.
    const retries = linesOf(capture, 'sqs message retry', (line) => line.walletId === scenario.walletId);
    expect(retries.map((line) => line.visibilityTimeoutSeconds)).toEqual([1, 2]);
    expect(retries.map((line) => line.receiveCount)).toEqual([1, 2]);
    expect(await transactionRow(orm, scenario.providerId, 'bet-poison')).toBeNull();
    expect(await debitCount(orm, scenario.walletId)).toBe(0);
    await waitForEmptyQueue(sqs, queues.queueUrl);
    expect(await deltas()).toMatchObject({ retried: 2, deadLettered: 1, processed: 0 });
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('dead-letters a permanent use-case failure on the first receive', async () => {
    const scenario = await newScenario(app);
    await sendEnvelope(sqs, queues.queueUrl, buildEnvelope({ data: betData(scenario, 'bet-1') }), {
      groupId: scenario.walletId,
    });
    await waitForStatus(orm, scenario.providerId, 'bet-1', WagerTransactionStatus.Processed);
    await waitForEmptyQueue(sqs, queues.queueUrl);
    const deltas = await watchMetrics(read);

    // Mesma key padrão (`providerId:externalTransactionId`), outro valor e outro messageId: a inbox não reconhece, a key sim.
    const conflicting = buildEnvelope({
      data: betData(scenario, 'bet-1', { money: { amount: '30.00', currency: 'BRL' } }),
    });
    await sendEnvelope(sqs, queues.queueUrl, conflicting, { groupId: scenario.walletId });

    const [dead, ...others] = await receiveAll(sqs, queues.deadLetterQueueUrl, { expected: 1, timeoutMs: 10000 });
    await capture.waitFor(
      (line) => line.msg === 'sqs message dead-lettered' && line.walletId === scenario.walletId,
      10000,
    );
    expect(others).toHaveLength(0);
    expect(failureCodeOf(dead)).toBe(FailureCode.IdempotencyConflict);
    expect(receiveCountOf(dead)).toBe('1');
    expect(dead?.Body).toBe(JSON.stringify(conflicting));
    expect(await transactionCount(orm, scenario.providerId)).toBe(1);
    expect((await transactionRow(orm, scenario.providerId, 'bet-1'))?.balance_after).toBe('75.00');
    expect(await debitCount(orm, scenario.walletId)).toBe(1);
    await waitForEmptyQueue(sqs, queues.queueUrl);
    expect(await deltas()).toMatchObject({ deadLettered: 1, retried: 0, processed: 0 });
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('keeps the consumer limit at or below the native redrive of the real queue', async () => {
    const urls = testQueueUrls();
    const { Attributes: queueAttributes = {} } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: urls.wager, AttributeNames: ['RedrivePolicy'] }),
    );
    const { Attributes: dlqAttributes = {} } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: urls.dlq, AttributeNames: ['QueueArn'] }),
    );

    const redrive = JSON.parse(queueAttributes.RedrivePolicy ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: number | string;
    };
    expect(redrive.deadLetterTargetArn).toBe(dlqAttributes.QueueArn);
    // A DLQ explícita do consumer (com `failureCode`) age antes do redrive nativo, que fica como rede de segurança.
    expect(Number(redrive.maxReceiveCount)).toBeGreaterThanOrEqual(sqsConsumerOptionsFromEnv(loadEnv()).maxReceives);
  });
});

describe('SQS consumer: redelivery and duplicates across two instances (temporary queues)', () => {
  const capture = createLogCapture();
  const sqs = createTestSqsClient();
  let queues: TemporaryQueues;
  let appA: INestApplication;
  let appB: INestApplication;
  let orm: MikroORM;
  let read: MetricReader;

  function createConsumerApp(): Promise<INestApplication> {
    return createTestApp({
      logDestination: capture.stream,
      sqsConsumer: {
        queueUrl: queues.queueUrl,
        deadLetterQueueUrl: queues.deadLetterQueueUrl,
        waitTimeSeconds: LONG_POLL_SECONDS,
        maxReceives: 5,
        shutdownTimeoutMs: 15000,
      },
      // Espera longa pelo lock: as duas instâncias ficam presas até o teste soltar, sem virar retry transitório.
      unitOfWork: { lockTimeoutMs: 15000, maxAttempts: 1 },
    });
  }

  beforeAll(async () => {
    queues = await createTemporaryQueues(sqs, { visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS });
    appA = await createConsumerApp();
    appB = await createConsumerApp();
    orm = appA.get(MikroORM);
    read = metricsOf([appA, appB]);
  });

  afterAll(async () => {
    await closeAndWaitForAbortedLongPoll([appA, appB]);
    await queues.remove();
    sqs.destroy();
  });

  /** Há duas queries esperando o lock de linha em `wallets`: as duas entregas estão presas na transação. */
  const bothDeliveriesBlocked = async (): Promise<true | null> =>
    (await walletLockWaiters(orm)) >= 2 ? true : null;

  async function expectAppliedOnce(scenario: Scenario, messageId: string): Promise<void> {
    const lines = await waitFor(async () => {
      const found = processedLines(capture, (line) => line.messageId === messageId);
      return found.length >= 2 ? found : null;
    }, 20000);
    const replays = lines.map((line) => line.idempotentReplay);
    expect(replays.filter((replay) => replay === false)).toHaveLength(1);
    expect(replays.some((replay) => replay === true)).toBe(true);

    expect(await transactionCount(orm, scenario.providerId)).toBe(1);
    expect(await debitCount(orm, scenario.walletId)).toBe(1);
    expect(await inboxCount(orm, messageId)).toBe(1);
    // Um ack com receipt handle antigo pode não apagar a mensagem: ela volta uma vez mais após a visibilidade.
    await waitForEmptyQueue(sqs, queues.queueUrl, 15000);
  }

  it('hands a message still in flight to another instance after the visibility timeout and applies it once', async () => {
    const scenario = await newScenario(appA);
    const messageId = Bun.randomUUIDv7();
    const deltas = await watchMetrics(read);
    const lock = await holdWalletLock(orm, scenario.walletId);

    try {
      await sendEnvelope(sqs, queues.queueUrl, buildEnvelope({ messageId, data: betData(scenario, 'bet-1') }), {
        groupId: scenario.walletId,
      });
      // A primeira instância segue presa no lock; passada a visibilidade, a outra recebe a mesma mensagem e também prende.
      await waitFor(bothDeliveriesBlocked, 15000);
      expect(processedLines(capture, (line) => line.messageId === messageId)).toHaveLength(0);
    } finally {
      await lock.release();
    }

    await expectAppliedOnce(scenario, messageId);
    const lines = processedLines(capture, (line) => line.messageId === messageId);
    expect(lines.some((line) => Number(line.receiveCount) >= 2)).toBe(true);
    expect(await deltas()).toMatchObject({ processed: 1, replayed: 1, sqsDuplicates: 1, deadLettered: 0 });
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('applies the same messageId once when two deliveries are processed at the same time', async () => {
    const scenario = await newScenario(appA);
    const messageId = Bun.randomUUIDv7();
    const envelope = buildEnvelope({ messageId, data: betData(scenario, 'bet-1') });
    const deltas = await watchMetrics(read);
    const lock = await holdWalletLock(orm, scenario.walletId);

    try {
      // Grupos diferentes: o FIFO entrega as duas ao mesmo tempo, e só a inbox e a idempotency key as unificam.
      await sendEnvelope(sqs, queues.queueUrl, envelope, { groupId: `${scenario.walletId}-a` });
      await sendEnvelope(sqs, queues.queueUrl, envelope, { groupId: `${scenario.walletId}-b` });
      await waitFor(bothDeliveriesBlocked, 15000);
      expect(processedLines(capture, (line) => line.messageId === messageId)).toHaveLength(0);
    } finally {
      await lock.release();
    }

    await expectAppliedOnce(scenario, messageId);
    expect(await deltas()).toMatchObject({ processed: 1, replayed: 1, sqsDuplicates: 1, deadLettered: 0 });
    await assertWalletConsistent(orm, scenario.walletId);
  });
});
