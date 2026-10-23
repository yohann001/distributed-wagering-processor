import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { WAGER_TRANSACTIONS_CONSUMER } from '../../src/modules/messaging/infrastructure/sqs/sqs-consumer-options';
import { defaultIdempotencyKey } from '../../src/modules/wagering/application/payload-hash';
import { SubmitWagerTransaction } from '../../src/modules/wagering/application/submit-wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/wager-transaction';
import { ReconcileWallet } from '../../src/modules/wallet/application/reconcile-wallet';
import { Money } from '../../src/shared/domain/money';
import { createTestApp } from '../support/create-test-app';
import { resetDatabase } from '../support/database';
import { newProviderId, openWalletWithBalance } from '../support/fixtures';
import { createLogCapture, type LogCapture, type LogLine } from '../support/log-capture';
import {
  buildEnvelope,
  createTemporaryQueues,
  createTestSqsClient,
  faultySqsClient,
  purgeQueue,
  queueDepth,
  receiveAll,
  sendEnvelope,
  testQueueUrls,
  waitFor,
  type TemporaryQueues,
} from '../support/sqs';
import { assertWalletConsistent } from '../support/wallet-consistency';

interface Scenario {
  walletId: string;
  playerId: string;
  providerId: string;
}

const VISIBILITY_TIMEOUT_SECONDS = 2;
const LONG_POLL_SECONDS = 1;

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

async function statusOf(
  orm: MikroORM,
  providerId: string,
  externalTransactionId: string,
): Promise<string | undefined> {
  const rows = await orm.em
    .fork()
    .execute<{ status: string }[]>(
      'select status from wager_transactions where provider_id = ? and external_transaction_id = ?',
      [providerId, externalTransactionId],
    );
  return rows[0]?.status;
}

async function waitForStatus(
  orm: MikroORM,
  providerId: string,
  externalTransactionId: string,
  status: WagerTransactionStatus,
): Promise<void> {
  await waitFor(async () => ((await statusOf(orm, providerId, externalTransactionId)) === status ? true : null));
}

async function count(orm: MikroORM, sql: string, params: unknown[]): Promise<number> {
  const rows = await orm.em.fork().execute<{ total: number }[]>(`select count(*)::int as total ${sql}`, params);
  return rows[0]?.total ?? 0;
}

const debitCount = (orm: MikroORM, walletId: string) =>
  count(orm, "from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]);

const refundCreditCount = (orm: MikroORM, walletId: string) =>
  count(
    orm,
    `from wallet_ledger_entries e join wager_transactions t on t.id = e.transaction_id
      where e.wallet_id = ? and e.direction = 'CREDIT' and t.kind = 'REFUND'`,
    [walletId],
  );

const inboxCount = (orm: MikroORM, messageId: string) =>
  count(orm, 'from inbox_messages where consumer_name = ? and message_id = ?', [
    WAGER_TRANSACTIONS_CONSUMER,
    messageId,
  ]);

const transactionCount = (orm: MikroORM, providerId: string) =>
  count(orm, 'from wager_transactions where provider_id = ?', [providerId]);

const pendingOutboxCount = (orm: MikroORM) => count(orm, 'from outbox_messages where published_at is null', []);

const pendingReferenceCount = (orm: MikroORM) =>
  count(orm, "from wager_transactions where status = 'PENDING_REFERENCE'", []);

async function balanceOf(orm: MikroORM, walletId: string): Promise<string | undefined> {
  const rows = await orm.em
    .fork()
    .execute<{ balance: string }[]>('select balance::text as balance from wallets where id = ?', [walletId]);
  return rows[0]?.balance;
}

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

/** O log de `sqs message processed` sai depois do ack, então a linha é esperada, não lida de imediato. */
function waitForProcessedLines(capture: LogCapture, messageId: string): Promise<LogLine[]> {
  return waitFor(async () => {
    const found = processedLines(capture, (line) => line.messageId === messageId);
    return found.length > 0 ? found : null;
  }, 10000);
}

/**
 * Fecha os apps e espera o fim do long poll que o `stop` abortou. O servidor segue com o `ReceiveMessage` até
 * `WaitTimeSeconds` e entrega a próxima mensagem a essa conexão morta: ela fica em voo até a visibilidade
 * expirar. Sem a espera, esse long poll roubaria a primeira mensagem do app seguinte.
 */
async function closeAndWaitForAbortedLongPoll(apps: INestApplication[]): Promise<void> {
  await Promise.all(apps.map((app) => app.close()));
  await Bun.sleep(LONG_POLL_SECONDS * 1000 + 200);
}

function consumerOptions(queues: TemporaryQueues) {
  return {
    queueUrl: queues.queueUrl,
    deadLetterQueueUrl: queues.deadLetterQueueUrl,
    waitTimeSeconds: LONG_POLL_SECONDS,
    maxReceives: 5,
    shutdownTimeoutMs: 10000,
  };
}

describe('Restart recovery: pending outbox, unacked SQS messages and PENDING_REFERENCE (Postgres e LocalStack reais)', () => {
  const sqs = createTestSqsClient();
  const faulty = faultySqsClient();
  const urls = testQueueUrls();
  let queues: TemporaryQueues;
  let appA: INestApplication | undefined;
  let appB: INestApplication | undefined;

  beforeAll(async () => {
    // O app B liga publisher e worker, que tratariam linhas pendentes de outras suítes: o banco é limpo antes dele.
    const cleaner = await createTestApp();
    await resetDatabase(cleaner.get(MikroORM));
    await cleaner.close();
    await purgeQueue(sqs, urls.events);
    queues = await createTemporaryQueues(sqs, { visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS });
  });

  afterAll(async () => {
    const live = appB ?? appA;
    const resetter = live ?? (await createTestApp());
    await resetDatabase(resetter.get(MikroORM));
    if (live === undefined) {
      await resetter.close();
    }
    const open = [appA, appB].filter((app): app is INestApplication => app !== undefined);
    await closeAndWaitForAbortedLongPoll(open);
    await queues.remove();
    faulty.client.destroy();
    sqs.destroy();
  });

  it('resumes unacked messages, queued messages, a pending reference and the unpublished outbox after a restart', async () => {
    // Antes do restart: o ack que sempre falha simula o crash entre o commit e o ack, e publisher e worker de
    // PENDING_REFERENCE desligados simulam a instância que morreu antes de publicar e de resolver a pendente.
    faulty.failAlways('DeleteMessageCommand');
    const captureA = createLogCapture();
    const first = await createTestApp({
      logDestination: captureA.stream,
      sqsClient: faulty.client,
      sqsConsumer: consumerOptions(queues),
    });
    appA = first;
    const ormA: MikroORM = first.get(MikroORM);

    const newScenarioWithMessage = async () => ({ scenario: await newScenario(first), messageId: Bun.randomUUIDv7() });
    const unacked = await Promise.all(Array.from({ length: 3 }, newScenarioWithMessage));
    const refundScenario = await newScenario(first);
    const queued = await Promise.all(Array.from({ length: 2 }, newScenarioWithMessage));
    const refundMessageId = Bun.randomUUIDv7();
    const roundId = 'round-ref';
    const thirty = { amount: '30.00', currency: 'BRL' };

    for (const { scenario, messageId } of unacked) {
      await sendEnvelope(sqs, queues.queueUrl, buildEnvelope({ messageId, data: betData(scenario, 'bet-1') }), {
        groupId: scenario.walletId,
      });
    }
    // O REFUND chega antes da BET que ele referencia: fica PENDING_REFERENCE.
    await sendEnvelope(
      sqs,
      queues.queueUrl,
      buildEnvelope({
        messageId: refundMessageId,
        data: betData(refundScenario, 'refund-1', {
          kind: 'REFUND',
          roundId,
          money: thirty,
          referenceExternalTransactionId: 'bet-ref',
        }),
      }),
      { groupId: refundScenario.walletId },
    );

    for (const { scenario } of unacked) {
      await waitForStatus(ormA, scenario.providerId, 'bet-1', WagerTransactionStatus.Processed);
    }
    await waitForStatus(ormA, refundScenario.providerId, 'refund-1', WagerTransactionStatus.PendingReference);

    // A BET referenciada chega pelo canal HTTP (sem inbox) e deixa o REFUND resolvível, mas ninguém o resolve.
    const betRef = await first.get(SubmitWagerTransaction).execute({
      idempotencyKey: defaultIdempotencyKey(refundScenario.providerId, 'bet-ref'),
      providerId: refundScenario.providerId,
      externalTransactionId: 'bet-ref',
      walletId: refundScenario.walletId,
      playerId: refundScenario.playerId,
      roundId,
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from(thirty),
      correlationId: Bun.randomUUIDv7(),
    });
    expect(betRef.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(ormA, refundScenario.walletId)).toBe('70.00');

    // Prova pelo log, não por `queueDepth` (aproximado): as quatro mensagens foram commitadas e o ack de cada uma falhou.
    expect(await pendingOutboxCount(ormA)).toBeGreaterThan(0);
    for (const messageId of [...unacked.map((entry) => entry.messageId), refundMessageId]) {
      await waitForProcessedLines(captureA, messageId);
      const failedAcks = captureA
        .lines()
        .filter((line) => line.msg === 'sqs ack failed' && line.messageId === messageId);
      expect(failedAcks.length).toBeGreaterThanOrEqual(1);
    }
    await closeAndWaitForAbortedLongPoll([first]);
    appA = undefined;

    // Com o app fora: mensagens que só existem na fila.
    for (const { scenario, messageId } of queued) {
      await sendEnvelope(sqs, queues.queueUrl, buildEnvelope({ messageId, data: betData(scenario, 'bet-1') }), {
        groupId: scenario.walletId,
      });
    }

    // Depois do restart: um app novo, com consumer, publisher e worker de PENDING_REFERENCE, sem nenhuma intervenção.
    const captureB = createLogCapture();
    const second = await createTestApp({
      logDestination: captureB.stream,
      sqsConsumer: consumerOptions(queues),
      outboxPublisher: { pollIntervalMs: 100 },
      pendingReferenceWorker: { pollIntervalMs: 100, retryBaseDelayMs: 50, retryMaxDelayMs: 100 },
    });
    appB = second;
    const orm: MikroORM = second.get(MikroORM);

    // A pendente gera eventos novos ao ser resolvida, então a outbox é a última a esvaziar.
    await waitForEmptyQueue(sqs, queues.queueUrl, 20000);
    await waitFor(async () => ((await pendingReferenceCount(orm)) === 0 ? true : null), 20000);
    await waitFor(async () => ((await pendingOutboxCount(orm)) === 0 ? true : null), 20000);

    const betScenarios = [...unacked, ...queued].map((entry) => entry.scenario);
    const wallets = [...betScenarios, refundScenario];
    for (const { scenario, messageId } of unacked) {
      const lines = await waitForProcessedLines(captureB, messageId);
      expect(lines.filter((line) => line.idempotentReplay === false)).toHaveLength(0);
      expect(lines.some((line) => line.idempotentReplay === true)).toBe(true);
      expect(await inboxCount(orm, messageId)).toBe(1);
      expect(await transactionCount(orm, scenario.providerId)).toBe(1);
    }
    const refundLines = await waitForProcessedLines(captureB, refundMessageId);
    expect(refundLines.filter((line) => line.idempotentReplay === false)).toHaveLength(0);
    expect(refundLines.some((line) => line.idempotentReplay === true)).toBe(true);
    expect(await inboxCount(orm, refundMessageId)).toBe(1);
    expect(await transactionCount(orm, refundScenario.providerId)).toBe(2);
    for (const { scenario, messageId } of queued) {
      const lines = await waitForProcessedLines(captureB, messageId);
      expect(lines.map((line) => line.idempotentReplay)).toEqual([false]);
      expect(await inboxCount(orm, messageId)).toBe(1);
      expect(await transactionCount(orm, scenario.providerId)).toBe(1);
    }
    for (const scenario of wallets) {
      expect(await debitCount(orm, scenario.walletId)).toBe(1);
    }

    expect(await statusOf(orm, refundScenario.providerId, 'refund-1')).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(orm, refundScenario.walletId)).toBe('100.00');
    expect(await refundCreditCount(orm, refundScenario.walletId)).toBe(1);

    const outboxRows = await orm.em.fork().execute<{ id: string }[]>('select id from outbox_messages order by id');
    const outboxIds = outboxRows.map((row) => row.id);
    const received = await receiveAll(sqs, urls.events, { expected: outboxIds.length, timeoutMs: 20000 });
    const receivedIds = new Set(received.map((message) => message.Attributes?.['MessageDeduplicationId']));
    expect([...receivedIds].sort()).toEqual([...outboxIds].sort());

    const reconcile = second.get(ReconcileWallet);
    for (const scenario of wallets) {
      await assertWalletConsistent(orm, scenario.walletId);
      expect((await reconcile.execute(scenario.walletId))?.consistent).toBe(true);
    }
    for (const scenario of betScenarios) {
      expect(await balanceOf(orm, scenario.walletId)).toBe('75.00');
    }
  }, 60_000);
});
