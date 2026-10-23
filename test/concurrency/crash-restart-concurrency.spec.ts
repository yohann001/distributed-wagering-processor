import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { WAGER_TRANSACTIONS_CONSUMER } from '../../src/modules/messaging/infrastructure/sqs/sqs-consumer-options';
import { defaultIdempotencyKey } from '../../src/modules/wagering/application/payload-hash';
import { PendingReferenceOutcome } from '../../src/modules/wagering/application/reprocess-pending-references';
import { SubmitWagerTransaction } from '../../src/modules/wagering/application/submit-wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/modules/wagering/domain/wager-transaction';
import type { SubmitResponse } from '../../src/modules/wagering/presentation/wager-transaction-http.schemas';
import type { ReconciliationResponse } from '../../src/modules/wallet/presentation/wallet-http.schemas';
import { FailureCode } from '../../src/shared/domain/failure-code';
import { Money } from '../../src/shared/domain/money';
import { startAppProcess, type AppProcess } from '../support/app-process';
import { createTestApp } from '../support/create-test-app';
import { resetDatabase } from '../support/database';
import { newProviderId, openWalletWithBalance } from '../support/fixtures';
import { expectMoney, postJson, type HttpResult } from '../support/http';
import type { LogLine } from '../support/log-capture';
import { present } from '../support/orm-context';
import {
  buildEnvelope,
  createTemporaryQueues,
  createTestSqsClient,
  queueDepth,
  receiveAll,
  sendEnvelope,
  waitFor,
  type TemporaryQueues,
} from '../support/sqs';
import { startSqsProxy, type SqsCall, type SqsProxy } from '../support/sqs-proxy';
import { assertWalletConsistent } from '../support/wallet-consistency';

interface Scenario {
  walletId: string;
  playerId: string;
  providerId: string;
}

interface TransactionRow {
  id: string;
  status: string;
  failure_code: string | null;
}

/** Uma mensagem SQS de um cenário: o `messageId` é a chave da inbox, o mesmo em toda reentrega. */
interface QueuedMessage {
  scenario: Scenario;
  messageId: string;
  payload: Record<string, unknown>;
}

/** Uma submissão HTTP guardada para o provider reenviá-la (mesmo payload, mesma key) depois do restart. */
interface HttpSubmission {
  payload: Record<string, unknown>;
  key: string;
}

interface EventQueues {
  wager: TemporaryQueues;
  events: TemporaryQueues;
}

type Submitted = HttpResult<SubmitResponse>;

type ReversalKind = 'REFUND' | 'ROLLBACK';

const INSTANCE_COUNT = 3;
const POOL_MAX = 10;
const LONG_POLL_SECONDS = 1;
const TEST_TIMEOUT_MS = 90000;
const HOOK_TIMEOUT_MS = 60000;
const DRAIN_TIMEOUT_MS = 20000;
const PROCESSED_LINE_TIMEOUT_MS = 15000;
const SURVIVOR_SEND_DELAY_MS = 30;

// `DB_POOL_ACQUIRE_TIMEOUT_MS` fica acima de lock timeout × tentativas + backoff (regra de dimensionamento em
// `src/config/env.ts`). Consumer, publisher e worker nascem desligados: cada teste liga só o que o cenário pede,
// porque os três agiriam também sobre linhas e mensagens que não são do cenário.
const BASE_CHILD_ENV: Record<string, string> = {
  DATABASE_POOL_MAX: String(POOL_MAX),
  DB_LOCK_TIMEOUT_MS: '10000',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '35000',
  SQS_CONSUMER_WAIT_TIME_SECONDS: String(LONG_POLL_SECONDS),
  SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: '5000',
  SQS_CONSUMER_ENABLED: 'false',
  OUTBOX_PUBLISHER_ENABLED: 'false',
  PENDING_REFERENCE_WORKER_ENABLED: 'false',
  LOG_LEVEL: 'info',
};

const CONSUMER_ON: Record<string, string> = { SQS_CONSUMER_ENABLED: 'true' };

const PUBLISHER_ON: Record<string, string> = {
  OUTBOX_PUBLISHER_ENABLED: 'true',
  OUTBOX_PUBLISHER_POLL_INTERVAL_MS: '100',
};

/** Worker de PENDING_REFERENCE rápido: a janela total é a soma do backoff, de `maxAttempts` reavaliações. */
function workerOn(maxAttempts: number, maxDelayMs: number): Record<string, string> {
  return {
    PENDING_REFERENCE_WORKER_ENABLED: 'true',
    PENDING_REFERENCE_WORKER_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_RETRY_BASE_DELAY_MS: '100',
    PENDING_REFERENCE_RETRY_MAX_DELAY_MS: String(maxDelayMs),
    PENDING_REFERENCE_MAX_ATTEMPTS: String(maxAttempts),
  };
}

function range(total: number): number[] {
  return Array.from({ length: total }, (_, index) => index);
}

function betPayload(scenario: Scenario, externalTransactionId: string, amount = '25.00') {
  return {
    providerId: scenario.providerId,
    externalTransactionId,
    playerId: scenario.playerId,
    walletId: scenario.walletId,
    roundId: `round-${externalTransactionId}`,
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

/** Estorno de uma BET: mesma rodada, jogo e valor da referência (§7). */
function reversalPayload(
  scenario: Scenario,
  externalTransactionId: string,
  kind: ReversalKind,
  referenceExternalTransactionId: string,
  amount = '30.00',
) {
  return {
    ...betPayload(scenario, externalTransactionId, amount),
    roundId: `round-${referenceExternalTransactionId}`,
    kind,
    referenceExternalTransactionId,
  };
}

/** A key padrão do consumer SQS: HTTP e SQS compartilham a mesma key para a mesma transação. */
function keyOf(scenario: Scenario, externalTransactionId: string): string {
  return defaultIdempotencyKey(scenario.providerId, externalTransactionId);
}

function queuedMessage(scenario: Scenario, payload: Record<string, unknown>): QueuedMessage {
  return { scenario, messageId: Bun.randomUUIDv7(), payload };
}

/** A confirmação (`DeleteMessage`) vem depois do commit, então o esvaziamento da fila é esperado, não instantâneo. */
async function waitForEmptyQueue(client: SQSClient, queueUrl: string, timeoutMs = 10000): Promise<void> {
  await waitFor(async () => {
    const depth = await queueDepth(client, queueUrl);
    return depth.visible === 0 && depth.inFlight === 0 ? true : null;
  }, timeoutMs);
}

function processedLinesOf(instances: AppProcess[], messageId: string): LogLine[] {
  return instances
    .flatMap((instance) => instance.lines())
    .filter((line) => line.msg === 'sqs message processed' && line.messageId === messageId);
}

/** O log de `sqs message processed` sai depois do ack, então as linhas são esperadas, não lidas de imediato. */
function waitForProcessedLines(
  instances: AppProcess[],
  messageId: string,
  expected: number,
  timeoutMs = PROCESSED_LINE_TIMEOUT_MS,
): Promise<LogLine[]> {
  return waitFor(async () => {
    const found = processedLinesOf(instances, messageId);
    return found.length >= expected ? found : null;
  }, timeoutMs);
}

/** `MessageDeduplicationId` de cada entrada de uma chamada `SendMessageBatch` registrada pelo proxy. */
function dedupIdsOf(call: SqsCall): string[] {
  const entries = call.body['Entries'];
  if (!Array.isArray(entries)) {
    throw new Error('SendMessageBatch call without Entries');
  }
  return entries.map((entry: { MessageDeduplicationId?: string }) =>
    present(entry.MessageDeduplicationId, 'MessageDeduplicationId'),
  );
}

function sentIdsOf(proxy: SqsProxy): string[] {
  return proxy.calls('SendMessageBatch').flatMap(dedupIdsOf);
}

interface EventBody {
  eventId: string;
  eventType: string;
  data: { transactionId?: string; failureCode?: string };
}

function eventBodyOf(message: Message): EventBody {
  return JSON.parse(present(message.Body, 'message body')) as EventBody;
}

function dedupIdOf(message: Message): string {
  return present(message.Attributes?.['MessageDeduplicationId'], 'MessageDeduplicationId');
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

describe('crash and restart across real processes (Postgres + LocalStack reais)', () => {
  const sqs = createTestSqsClient();
  let control: INestApplication;
  let orm: MikroORM;
  const children: AppProcess[] = [];
  const proxies: SqsProxy[] = [];
  const queueSets: TemporaryQueues[] = [];

  beforeAll(async () => {
    // App de controle no processo do teste, sem workers e sem tráfego: só cria fixtures e sonda o banco.
    control = await createTestApp();
    orm = control.get(MikroORM);
  }, HOOK_TIMEOUT_MS);

  // Publisher e worker dos filhos agem sobre qualquer linha pendente (como no restart-recovery da T28): cada teste
  // começa com o banco vazio, sem sobras de outro teste ou de outra suíte.
  beforeEach(async () => {
    await resetDatabase(orm);
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await Promise.all(children.splice(0).map((child) => child.stop('SIGKILL')));
    await Promise.all(proxies.splice(0).map((proxy) => proxy.stop()));
    // O servidor segue com o `ReceiveMessage` abortado até `WaitTimeSeconds` e entrega a próxima mensagem a essa
    // conexão morta: sem a espera, o long poll morto ainda estaria vivo ao apagar a fila.
    await Bun.sleep(LONG_POLL_SECONDS * 1000 + 200);
    for (const queues of queueSets.splice(0)) {
      await queues.remove();
    }
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await resetDatabase(orm);
    await control.close();
    sqs.destroy();
  }, HOOK_TIMEOUT_MS);

  async function spawn(instanceId: string, env: Record<string, string>): Promise<AppProcess> {
    const child = await startAppProcess({ instanceId, env });
    children.push(child);
    return child;
  }

  function spawnMany(prefix: string, total: number, env: Record<string, string>): Promise<AppProcess[]> {
    return Promise.all(range(total).map((index) => spawn(`${prefix}-${index + 1}`, env)));
  }

  function startProxy(): SqsProxy {
    const proxy = startSqsProxy();
    proxies.push(proxy);
    return proxy;
  }

  async function newQueues(wagerVisibilitySeconds: number): Promise<EventQueues> {
    const wager = await createTemporaryQueues(sqs, { visibilityTimeoutSeconds: wagerVisibilitySeconds });
    queueSets.push(wager);
    const events = await createTemporaryQueues(sqs, { visibilityTimeoutSeconds: 30 });
    queueSets.push(events);
    return { wager, events };
  }

  /** Ambiente do filho com as três filas do teste; com `via`, as chamadas ao SQS passam pelo proxy. */
  function childEnv(queues: EventQueues, overrides: Record<string, string> = {}, via?: SqsProxy): Record<string, string> {
    const route = (url: string) => (via === undefined ? url : via.queueUrl(url));
    return {
      ...BASE_CHILD_ENV,
      SQS_WAGER_QUEUE_URL: route(queues.wager.queueUrl),
      SQS_WAGER_DLQ_URL: route(queues.wager.deadLetterQueueUrl),
      SQS_EVENTS_QUEUE_URL: route(queues.events.queueUrl),
      ...(via !== undefined && { AWS_ENDPOINT_URL: via.endpoint }),
      ...overrides,
    };
  }

  async function newScenario(balance = '100.00'): Promise<Scenario> {
    const { wallet } = await openWalletWithBalance(control, { amount: balance });
    return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
  }

  function openScenarios(total: number): Promise<Scenario[]> {
    return Promise.all(range(total).map(() => newScenario()));
  }

  function pick(instances: AppProcess[], index: number): AppProcess {
    return present(instances[index % instances.length], `instance ${index}`);
  }

  function submit(instance: AppProcess, payload: Record<string, unknown>, key: string): Promise<Submitted> {
    return postJson<SubmitResponse>(instance.baseUrl, '/wagering/transactions', payload, { 'Idempotency-Key': key });
  }

  function send(queues: EventQueues, message: QueuedMessage): Promise<void> {
    return sendEnvelope(sqs, queues.wager.queueUrl, buildEnvelope({ messageId: message.messageId, data: message.payload }), {
      groupId: message.scenario.walletId,
    });
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const rows = await orm.em.fork().execute<{ total: number }[]>(`select count(*)::int as total ${sql}`, params);
    return rows[0]?.total ?? 0;
  }

  const debitCount = (walletId: string) =>
    count("from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]);

  const creditCount = (walletId: string) =>
    count("from wallet_ledger_entries where wallet_id = ? and direction = 'CREDIT'", [walletId]);

  const transactionCount = (providerId: string) => count('from wager_transactions where provider_id = ?', [providerId]);

  const inboxCount = (messageId: string) =>
    count('from inbox_messages where consumer_name = ? and message_id = ?', [WAGER_TRANSACTIONS_CONSUMER, messageId]);

  const pendingOutboxCount = () => count('from outbox_messages where published_at is null', []);

  const pendingReferenceCount = () => count("from wager_transactions where status = 'PENDING_REFERENCE'", []);

  async function pendingOutboxIds(): Promise<string[]> {
    const rows = await orm.em
      .fork()
      .execute<{ id: string }[]>('select id from outbox_messages where published_at is null order by id');
    return rows.map((row) => row.id);
  }

  async function outboxIds(): Promise<string[]> {
    const rows = await orm.em.fork().execute<{ id: string }[]>('select id from outbox_messages order by id');
    return rows.map((row) => row.id);
  }

  async function balanceOf(walletId: string): Promise<string> {
    const rows = await orm.em
      .fork()
      .execute<{ balance: string }[]>('select balance::text as balance from wallets where id = ?', [walletId]);
    return present(rows[0], 'wallet row').balance;
  }

  async function findTransaction(providerId: string, externalTransactionId: string): Promise<TransactionRow | undefined> {
    const rows = await orm.em
      .fork()
      .execute<TransactionRow[]>(
        'select id, status, failure_code from wager_transactions where provider_id = ? and external_transaction_id = ?',
        [providerId, externalTransactionId],
      );
    return rows[0];
  }

  async function transactionRow(providerId: string, externalTransactionId: string): Promise<TransactionRow> {
    return present(await findTransaction(providerId, externalTransactionId), 'wager transaction row');
  }

  function waitForStatus(scenario: Scenario, externalTransactionId: string, status: WagerTransactionStatus): Promise<true> {
    return waitFor(async () => {
      const row = await findTransaction(scenario.providerId, externalTransactionId);
      return row?.status === status ? true : null;
    }, DRAIN_TIMEOUT_MS);
  }

  /** O que sobrou na fila de eventos: lê até o primeiro receive vazio, duplicatas inclusive. */
  function receiveEvents(queues: EventQueues): Promise<Message[]> {
    return receiveAll(sqs, queues.events.queueUrl, { timeoutMs: DRAIN_TIMEOUT_MS });
  }

  /** Sem perda: o conjunto de `MessageDeduplicationId` recebido é o conjunto de ids da outbox; e id da fila == `eventId`. */
  async function expectEveryOutboxEventReceived(received: Message[]): Promise<void> {
    expect(sortedUnique(received.map(dedupIdOf))).toEqual(await outboxIds());
    for (const message of received) {
      expect(eventBodyOf(message).eventId).toBe(dedupIdOf(message));
    }
  }

  it('does not apply twice a message whose worker was SIGKILLed after the commit and before the ack (§13 c5)', async () => {
    // Visibilidade curta: a reentrega por expiração cabe no teste.
    const queues = await newQueues(3);
    const scenarios = await openScenarios(3);
    const messages = scenarios.map((scenario) => queuedMessage(scenario, betPayload(scenario, 'bet-1')));
    // As mensagens entram antes da vítima subir: um único receive de lote 10 leva as três (grupos diferentes).
    for (const message of messages) {
      await send(queues, message);
    }

    // O ack nunca chega ao SQS: o commit já aconteceu, o `DeleteMessage` fica pendurado e o processo morre ali.
    const proxy = startProxy();
    proxy.holdRequests('DeleteMessage');
    const victim = await spawn('victim', childEnv(queues, { ...CONSUMER_ON, SQS_CONSUMER_BATCH_SIZE: '10' }, proxy));
    await waitFor(async () => (proxy.held('DeleteMessage') === messages.length ? true : null), DRAIN_TIMEOUT_MS);

    for (const { scenario, messageId } of messages) {
      expect(await inboxCount(messageId)).toBe(1);
      expect(await debitCount(scenario.walletId)).toBe(1);
      expect(await balanceOf(scenario.walletId)).toBe('75.00');
    }

    // As mensagens estão em voo (visibilidade de 3 s): os sobreviventes sobem agora e só as recebem na reentrega.
    const survivors = await spawnMany('survivor', 2, childEnv(queues, CONSUMER_ON));
    expect(await victim.stop('SIGKILL')).toBeNull();
    for (const { messageId } of messages) {
      expect(processedLinesOf([victim], messageId)).toHaveLength(0);
    }

    for (const { messageId } of messages) {
      await waitForProcessedLines(survivors, messageId, 1);
    }
    await waitForEmptyQueue(sqs, queues.wager.queueUrl);

    const survivorIds = survivors.map((survivor) => survivor.instanceId);
    for (const { scenario, messageId } of messages) {
      const lines = processedLinesOf(survivors, messageId);
      expect(lines).toHaveLength(1);
      for (const line of lines) {
        expect(line.idempotentReplay).toBe(true);
        expect(line.status).toBe(WagerTransactionStatus.Processed);
        expect(Number(line.receiveCount)).toBeGreaterThanOrEqual(2);
        expect(survivorIds).toContain(String(line.instanceId));
      }
      expect(await inboxCount(messageId)).toBe(1);
      expect(await transactionCount(scenario.providerId)).toBe(1);
      expect(await debitCount(scenario.walletId)).toBe(1);
      expect(await balanceOf(scenario.walletId)).toBe('75.00');
      await assertWalletConsistent(orm, scenario.walletId);
    }
  }, TEST_TIMEOUT_MS);

  it('publishes every event after a publisher is SIGKILLed mid-send while two others drain the same outbox (§13 c6, §11)', async () => {
    const queues = await newQueues(30);
    const scenarios = await openScenarios(6);
    const submitUseCase = control.get(SubmitWagerTransaction);
    // As BETs entram pelo caso de uso do app de controle (sem publisher): cada uma deixa eventos pendentes na outbox.
    await Promise.all(
      scenarios.map(async (scenario) => {
        for (const index of range(5)) {
          const externalTransactionId = `bet-${index}`;
          await submitUseCase.execute({
            idempotencyKey: keyOf(scenario, externalTransactionId),
            providerId: scenario.providerId,
            externalTransactionId,
            walletId: scenario.walletId,
            playerId: scenario.playerId,
            roundId: `round-${externalTransactionId}`,
            gameId: 'game-1',
            kind: WagerTransactionKind.Bet,
            money: Money.from({ amount: '10.00', currency: 'BRL' }),
            correlationId: Bun.randomUUIDv7(),
          });
        }
      }),
    );
    const total = (await outboxIds()).length;
    expect(total).toBeGreaterThanOrEqual(40);
    expect(await pendingOutboxCount()).toBe(total);

    // O `SendMessageBatch` chega ao SQS e a resposta fica pendurada: os eventos estão na fila, o commit da outbox não
    // aconteceu. `OUTBOX_PUBLISH_TIMEOUT_MS` alto impede o abort do SDK de agir antes da morte do processo.
    const victimProxy = startProxy();
    victimProxy.holdResponses('SendMessageBatch');
    const victim = await spawn(
      'victim',
      childEnv(
        queues,
        {
          ...PUBLISHER_ON,
          OUTBOX_PUBLISHER_BATCH_SIZE: '10',
          OUTBOX_PUBLISH_TIMEOUT_MS: '60000',
        },
        victimProxy,
      ),
    );
    await waitFor(async () => (victimProxy.held('SendMessageBatch') === 1 ? true : null), DRAIN_TIMEOUT_MS);
    const killedIds = dedupIdsOf(present(victimProxy.calls('SendMessageBatch')[0], 'victim batch'));
    expect(killedIds).toHaveLength(10);
    const pendingBeforeKill = await pendingOutboxIds();
    for (const id of killedIds) {
      expect(pendingBeforeKill).toContain(id);
    }

    // Postgres desfaz a transação do backend morto e solta as linhas do `FOR UPDATE SKIP LOCKED`.
    expect(await victim.stop('SIGKILL')).toBeNull();
    expect(await pendingOutboxCount()).toBe(total);

    const survivorProxies = [startProxy(), startProxy()];
    const liveEnv = { ...PUBLISHER_ON, OUTBOX_PUBLISHER_BATCH_SIZE: '5' };
    // Atraso no envio: alonga o tempo em que cada publisher segura as linhas do claim, e os dois disputam a outbox.
    for (const proxy of survivorProxies) {
      proxy.delay('SendMessageBatch', SURVIVOR_SEND_DELAY_MS);
    }
    await Promise.all(
      survivorProxies.map((proxy, index) => spawn(`survivor-${index + 1}`, childEnv(queues, liveEnv, proxy))),
    );
    await waitFor(async () => ((await pendingOutboxCount()) === 0 ? true : null), DRAIN_TIMEOUT_MS);

    const [firstSent = [], secondSent = []] = survivorProxies.map(sentIdsOf);
    expect(firstSent.length).toBeGreaterThan(0);
    expect(secondSent.length).toBeGreaterThan(0);
    // Nenhum evento foi enviado ao mesmo tempo pelos dois: o claim com SKIP LOCKED os separa.
    expect(firstSent.filter((id) => secondSent.includes(id))).toEqual([]);
    expect(new Set(firstSent).size).toBe(firstSent.length);
    expect(new Set(secondSent).size).toBe(secondSent.length);
    expect(sortedUnique([...firstSent, ...secondSent])).toEqual(await outboxIds());
    // A duplicata aconteceu: o lote da vítima já estava no SQS e um publisher vivo o enviou de novo, com o mesmo id.
    for (const id of killedIds) {
      expect([...firstSent, ...secondSent]).toContain(id);
    }

    const received = await receiveEvents(queues);
    expect(received.length).toBeGreaterThanOrEqual(total);
    await expectEveryOutboxEventReceived(received);
    for (const scenario of scenarios) {
      expect(await balanceOf(scenario.walletId)).toBe('50.00');
      await assertWalletConsistent(orm, scenario.walletId);
    }
  }, TEST_TIMEOUT_MS);

  it('resolves REFUND/ROLLBACK delivered before their BET once through the PENDING_REFERENCE workers of 3 instances (§13 c7)', async () => {
    const queues = await newQueues(30);
    // Janela do worker: 15 reavaliações com backoff de 100 a 500 ms, ~6 a 8 s. As BETs chegam em ~1 s; a órfã
    // vence a janela dentro do teste.
    const instances = await spawnMany(
      'instance',
      INSTANCE_COUNT,
      childEnv(queues, { ...CONSUMER_ON, ...PUBLISHER_ON, ...workerOn(15, 500) }),
    );
    const scenarios = await openScenarios(6);
    const orphan = await newScenario();

    const refunds = scenarios.map((scenario) =>
      queuedMessage(scenario, reversalPayload(scenario, 'refund-r', 'REFUND', 'bet-r')),
    );
    // Os estornos chegam antes das BETs: o REFUND por SQS e o ROLLBACK por HTTP ficam PENDING_REFERENCE.
    await Promise.all(
      scenarios.map(async (scenario, index) => {
        await send(queues, present(refunds[index], 'refund message'));
        const rollback = await submit(
          pick(instances, index),
          reversalPayload(scenario, 'rollback-k', 'ROLLBACK', 'bet-k'),
          keyOf(scenario, 'rollback-k'),
        );
        expect(rollback.status).toBe(202);
        expect(rollback.body.status).toBe(WagerTransactionStatus.PendingReference);
      }),
    );
    const orphanResponse = await submit(
      pick(instances, 0),
      reversalPayload(orphan, 'rollback-never', 'ROLLBACK', 'bet-never'),
      keyOf(orphan, 'rollback-never'),
    );
    expect(orphanResponse.status).toBe(202);
    for (const scenario of scenarios) {
      await waitForStatus(scenario, 'refund-r', WagerTransactionStatus.PendingReference);
      await waitForStatus(scenario, 'rollback-k', WagerTransactionStatus.PendingReference);
    }

    // As BETs referenciadas chegam por HTTP em instâncias diferentes das que receberam os estornos.
    await Promise.all(
      scenarios.map(async (scenario, index) => {
        for (const externalTransactionId of ['bet-r', 'bet-k']) {
          const bet = await submit(
            pick(instances, index + 1),
            betPayload(scenario, externalTransactionId, '30.00'),
            keyOf(scenario, externalTransactionId),
          );
          expect(bet.status).toBe(200);
          expect(bet.body.status).toBe(WagerTransactionStatus.Processed);
        }
      }),
    );

    // Inclui a órfã: a pendente sem referência sai de PENDING_REFERENCE ao esgotar a janela.
    await waitFor(async () => ((await pendingReferenceCount()) === 0 ? true : null), DRAIN_TIMEOUT_MS);
    await waitForEmptyQueue(sqs, queues.wager.queueUrl);
    await waitFor(async () => ((await pendingOutboxCount()) === 0 ? true : null), DRAIN_TIMEOUT_MS);

    // O log do worker sai depois do commit do lote, então a linha é esperada.
    const reprocessedLines = (transactionId: string, outcome: PendingReferenceOutcome) =>
      instances
        .flatMap((instance) => instance.lines())
        .filter(
          (line) =>
            line.msg === 'pending reference reprocessed' &&
            line.transactionId === transactionId &&
            line.outcome === outcome,
        );
    for (const scenario of scenarios) {
      for (const externalTransactionId of ['refund-r', 'rollback-k']) {
        const reversal = await transactionRow(scenario.providerId, externalTransactionId);
        expect(reversal.status).toBe(WagerTransactionStatus.Processed);
        await waitFor(async () => {
          const found = reprocessedLines(reversal.id, PendingReferenceOutcome.Processed);
          return found.length > 0 ? found : null;
        }, PROCESSED_LINE_TIMEOUT_MS);
        expect(reprocessedLines(reversal.id, PendingReferenceOutcome.Processed)).toHaveLength(1);
      }
      expect(await debitCount(scenario.walletId)).toBe(2);
      // Abertura e um crédito por estorno, exatamente um por estorno.
      expect(await creditCount(scenario.walletId)).toBe(3);
      expect(await balanceOf(scenario.walletId)).toBe('100.00');
      await assertWalletConsistent(orm, scenario.walletId);
    }
    for (const { messageId } of refunds) {
      expect(await inboxCount(messageId)).toBe(1);
    }

    const orphanRow = await transactionRow(orphan.providerId, 'rollback-never');
    expect(orphanRow.status).toBe(WagerTransactionStatus.Rejected);
    expect(orphanRow.failure_code).toBe(FailureCode.ReferenceNotFound);
    await waitFor(async () => {
      const found = reprocessedLines(orphanRow.id, PendingReferenceOutcome.Expired);
      return found.length > 0 ? found : null;
    }, PROCESSED_LINE_TIMEOUT_MS);
    expect(await debitCount(orphan.walletId)).toBe(0);
    // Só o crédito de abertura: a rejeição não gera lançamento.
    expect(await creditCount(orphan.walletId)).toBe(1);
    expect(await balanceOf(orphan.walletId)).toBe('100.00');
    await assertWalletConsistent(orm, orphan.walletId);

    const received = await receiveEvents(queues);
    await expectEveryOutboxEventReceived(received);
    const rejections = received
      .map(eventBodyOf)
      .filter((event) => event.eventType === 'WagerTransactionRejected' && event.data.transactionId === orphanRow.id);
    expect(rejections.map((event) => event.data.failureCode)).toEqual([FailureCode.ReferenceNotFound]);
  }, TEST_TIMEOUT_MS);

  it('ends consistent after 3 instances are stopped mid-traffic (SIGKILL and SIGTERM) and 3 fresh ones take over (§13 c8)', async () => {
    const queues = await newQueues(3);
    // Janela do worker de ~25 s: cobre a queda, a subida das instâncias novas e o reenvio HTTP do provider.
    const fullEnv = childEnv(queues, {
      ...CONSUMER_ON,
      ...PUBLISHER_ON,
      ...workerOn(30, 1000),
      SQS_CONSUMER_BATCH_SIZE: '2',
    });
    const first = await spawnMany('instance', INSTANCE_COUNT, fullEnv);
    const scenarios = await openScenarios(8);

    const sqsMessages = new Map<Scenario, { refund: QueuedMessage; bets: QueuedMessage[] }>(
      scenarios.map((scenario) => [
        scenario,
        {
          refund: queuedMessage(scenario, reversalPayload(scenario, 'refund-h0', 'REFUND', 'h-0', '20.00')),
          bets: ['s-0', 's-1'].map((id) => queuedMessage(scenario, betPayload(scenario, id, '20.00'))),
        },
      ]),
    );
    const submissions: HttpSubmission[] = [];
    const inFlight: Promise<Submitted | null>[] = [];

    // Por wallet: o REFUND de h-0 vem primeiro (pode ficar pendente), depois as BETs h-0 e h-1 por HTTP e s-0 e s-1 por SQS.
    // Cabe tudo: 100.00 - 4 × 20.00 + 20.00 = 40.00 em qualquer ordem.
    await Promise.all(
      scenarios.map(async (scenario, index) => {
        const { refund, bets } = present(sqsMessages.get(scenario), 'scenario messages');
        await send(queues, refund);
        for (const [offset, id] of ['h-0', 'h-1'].entries()) {
          const submission = { payload: betPayload(scenario, id, '20.00'), key: keyOf(scenario, id) };
          submissions.push(submission);
          // Uma requisição ao processo que morrer falha no socket: o provider a reenviará depois.
          inFlight.push(submit(pick(first, index + offset), submission.payload, submission.key).catch(() => null));
        }
        for (const bet of bets) {
          await send(queues, bet);
        }
      }),
    );

    await waitFor(async () => {
      const processed = first.flatMap((instance) => instance.lines()).filter((line) => line.msg === 'sqs message processed');
      return processed.length > 0 ? true : null;
    }, PROCESSED_LINE_TIMEOUT_MS);
    const [killedInstance, ...drainedInstances] = first;
    const [killedExit] = await Promise.all([
      present(killedInstance, 'killed instance').stop('SIGKILL'),
      ...drainedInstances.map((instance) => instance.stop('SIGTERM')),
    ]);
    expect(killedExit).toBeNull();
    await Promise.all(inFlight);

    // Com tudo parado: o provider reentrega s-0 e s-1 (mesmo `messageId`, id de deduplicação novo, que o FIFO não
    // colapsa). A conta de 40.00 não muda, porque a inbox as trata como replay.
    for (const { bets } of sqsMessages.values()) {
      for (const bet of bets) {
        await send(queues, bet);
      }
    }
    const depth = await queueDepth(sqs, queues.wager.queueUrl);
    const pendingWork =
      depth.visible + depth.inFlight + (await pendingOutboxCount()) + (await pendingReferenceCount());
    expect(pendingWork).toBeGreaterThan(0);

    // Os long polls abortados ainda estão vivos no servidor até `WaitTimeSeconds`.
    await Bun.sleep(LONG_POLL_SECONDS * 1000 + 200);
    const second = await spawnMany('restarted', INSTANCE_COUNT, fullEnv);
    await waitForEmptyQueue(sqs, queues.wager.queueUrl, DRAIN_TIMEOUT_MS);

    // Retry do provider para o que morreu com o processo: mesma key, o resultado é o original.
    const retries = await Promise.all(
      submissions.map((submission, index) => submit(pick(second, index), submission.payload, submission.key)),
    );
    for (const retry of retries) {
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe(WagerTransactionStatus.Processed);
      expect(typeof present(retry.body.balance, 'replayed balance').amount).toBe('string');
    }

    await waitFor(async () => ((await pendingReferenceCount()) === 0 ? true : null), DRAIN_TIMEOUT_MS);
    await waitFor(async () => ((await pendingOutboxCount()) === 0 ? true : null), DRAIN_TIMEOUT_MS);

    for (const scenario of scenarios) {
      const { refund, bets } = present(sqsMessages.get(scenario), 'scenario messages');
      expect(await debitCount(scenario.walletId)).toBe(4);
      // Abertura e o estorno.
      expect(await creditCount(scenario.walletId)).toBe(2);
      expect(await balanceOf(scenario.walletId)).toBe('40.00');
      expect(await transactionCount(scenario.providerId)).toBe(5);
      for (const { messageId } of [refund, ...bets]) {
        expect(await inboxCount(messageId)).toBe(1);
      }
      expect((await transactionRow(scenario.providerId, 'refund-h0')).status).toBe(WagerTransactionStatus.Processed);
    }

    // Toda wallet do banco (o arquivo o esvaziou antes do teste): a reconciliação pelas instâncias novas fecha em zero.
    const wallets = await orm.em.fork().execute<{ id: string }[]>('select id from wallets order by id');
    expect(wallets.length).toBeGreaterThanOrEqual(scenarios.length);
    await Promise.all(
      wallets.map(async ({ id }, index) => {
        const reconciliation = await postJson<ReconciliationResponse>(
          pick(second, index).baseUrl,
          `/wallets/${id}/reconciliation`,
          {},
        );
        expect(reconciliation.status).toBe(200);
        expect(reconciliation.body.consistent).toBe(true);
        expectMoney(reconciliation.body.difference, '0.00');
        await assertWalletConsistent(orm, id);
      }),
    );

    await expectEveryOutboxEventReceived(await receiveEvents(queues));
  }, TEST_TIMEOUT_MS);
});
