import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { loadEnv } from '../../src/config/env';
import { WAGER_TRANSACTIONS_CONSUMER } from '../../src/modules/messaging/infrastructure/sqs/sqs-consumer-options';
import { defaultIdempotencyKey } from '../../src/modules/wagering/application/payload-hash';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import type { SubmitResponse } from '../../src/modules/wagering/presentation/wager-transaction-http.schemas';
import { FailureCode } from '../../src/shared/domain/failure-code';
import { createTestApp } from '../support/create-test-app';
import { newProviderId, openWalletWithBalance } from '../support/fixtures';
import { expectMoney, postJson, type HttpResult } from '../support/http';
import { createLogCapture, type LogCapture, type LogLine } from '../support/log-capture';
import { present } from '../support/orm-context';
import {
  buildEnvelope,
  createTemporaryQueues,
  createTestSqsClient,
  queueDepth,
  sendEnvelope,
  waitFor,
  type TemporaryQueues,
} from '../support/sqs';
import { assertWalletConsistent } from '../support/wallet-consistency';
import { holdWalletLocks, walletLockWaiters } from '../support/wallet-lock';

interface Scenario {
  walletId: string;
  playerId: string;
  providerId: string;
}

interface TransactionRow {
  status: string;
  failure_code: string | null;
}

type Submitted = HttpResult<SubmitResponse>;

const LONG_POLL_SECONDS = 1;
// Longa de propósito: as mensagens ficam presas no lock e não podem ser reentregues por expiração no meio do teste,
// o que mudaria a contagem de linhas `sqs message processed`.
const VISIBILITY_TIMEOUT_SECONDS = 30;
const POOL_MAX = loadEnv().DATABASE_POOL_MAX;
const BARRIER_TIMEOUT_MS = 10000;

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

/** A key padrão do consumer SQS: HTTP e SQS compartilham a mesma key para a mesma aposta. */
function keyOf(scenario: Scenario, externalTransactionId: string): string {
  return defaultIdempotencyKey(scenario.providerId, externalTransactionId);
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

/**
 * Fecha os apps e espera o fim do long poll que o `stop` abortou. O servidor segue com o `ReceiveMessage` até
 * `WaitTimeSeconds` e entrega a próxima mensagem a essa conexão morta: ela fica em voo até a visibilidade
 * expirar. Sem a espera, esse long poll roubaria a primeira mensagem do app seguinte.
 */
async function closeAndWaitForAbortedLongPoll(apps: INestApplication[]): Promise<void> {
  await Promise.all(apps.map((app) => app.close()));
  await Bun.sleep(LONG_POLL_SECONDS * 1000 + 200);
}

describe('wagering concurrency (app real, Postgres + LocalStack reais)', () => {
  const capture = createLogCapture();
  const sqs = createTestSqsClient();
  let queues: TemporaryQueues;
  let app: INestApplication;
  let lockApp: INestApplication;
  let orm: MikroORM;
  let lockOrm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    queues = await createTemporaryQueues(sqs, { visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS });
    // `batchSize: 5`: com a wallet travada o consumer segura no máximo 5 das `POOL_MAX` conexões do app,
    // então as requisições HTTP ainda chegam ao lock.
    app = await createTestApp({
      logDestination: capture.stream,
      sqsConsumer: {
        queueUrl: queues.queueUrl,
        deadLetterQueueUrl: queues.deadLetterQueueUrl,
        waitTimeSeconds: LONG_POLL_SECONDS,
        batchSize: 5,
      },
    });
    // Pool próprio, só para segurar locks e sondar `pg_stat_activity`: a sonda roda mesmo com o pool do app esgotado.
    lockApp = await createTestApp();
    orm = app.get(MikroORM);
    lockOrm = lockApp.get(MikroORM);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await closeAndWaitForAbortedLongPoll([app, lockApp]);
    await queues.remove();
    sqs.destroy();
  });

  async function newScenario(balance = '100.00'): Promise<Scenario> {
    const { wallet } = await openWalletWithBalance(app, { amount: balance });
    return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
  }

  function openScenarios(total: number): Promise<Scenario[]> {
    return Promise.all(Array.from({ length: total }, () => newScenario()));
  }

  function submit(payload: Record<string, unknown>, key: string): Promise<Submitted> {
    return postJson<SubmitResponse>(baseUrl, '/wagering/transactions', payload, { 'Idempotency-Key': key });
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const rows = await orm.em.fork().execute<{ total: number }[]>(`select count(*)::int as total ${sql}`, params);
    return rows[0]?.total ?? 0;
  }

  const debitCount = (walletId: string) =>
    count("from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]);

  const transactionCount = (providerId: string) => count('from wager_transactions where provider_id = ?', [providerId]);

  const outboxCount = (walletId: string) =>
    count("from outbox_messages where payload->'data'->>'walletId' = ?", [walletId]);

  const inboxCount = (messageId: string) =>
    count('from inbox_messages where consumer_name = ? and message_id = ?', [WAGER_TRANSACTIONS_CONSUMER, messageId]);

  async function balanceOf(walletId: string): Promise<string> {
    const rows = await orm.em
      .fork()
      .execute<{ balance: string }[]>('select balance::text as balance from wallets where id = ?', [walletId]);
    return present(rows[0], 'wallet row').balance;
  }

  async function transactionRow(providerId: string, externalTransactionId: string): Promise<TransactionRow> {
    const rows = await orm.em
      .fork()
      .execute<TransactionRow[]>(
        'select status, failure_code from wager_transactions where provider_id = ? and external_transaction_id = ?',
        [providerId, externalTransactionId],
      );
    return present(rows[0], 'wager transaction row');
  }

  /** O log de `sqs message processed` sai depois do ack, então as linhas são esperadas, não lidas de imediato. */
  function waitForProcessedLines(messageId: string, expected: number): Promise<LogLine[]> {
    return waitFor(async () => {
      const found = processedLines(capture, (line) => line.messageId === messageId);
      return found.length >= expected ? found : null;
    }, 10000);
  }

  function waitForLockWaiters(waiters: number): Promise<true> {
    return waitFor(async () => ((await walletLockWaiters(lockOrm)) >= waiters ? true : null), BARRIER_TIMEOUT_MS, 20);
  }

  /**
   * Segura o lock das wallets, dispara as submissões (`fire` devolve as promessas sem esperá-las) e só solta quando
   * `waiters` backends do app estão presos nele. É a barreira que prova que as requisições estavam em voo ao mesmo
   * tempo, em vez de torcer para o `Promise.all` sobrepô-las. O `finally` solta o lock mesmo se a espera falhar.
   */
  async function submitWhileLocked<T>(walletIds: string[], waiters: number, fire: () => Promise<T>): Promise<T> {
    const holder = await holdWalletLocks(lockOrm, walletIds);
    try {
      const fired = await fire();
      await waitForLockWaiters(waiters);
      return fired;
    } finally {
      await holder.release();
    }
  }

  it('applies the same bet once out of 50 parallel HTTP submissions (§13 c1)', async () => {
    const scenario = await newScenario();
    const payload = betPayload(scenario, 'bet-1');
    const key = keyOf(scenario, 'bet-1');

    // Toda conexão do app fica presa no lock da wallet pelo caminho lento: nenhuma enxerga uma vencedora commitada.
    const pending = await submitWhileLocked([scenario.walletId], POOL_MAX, async () =>
      Array.from({ length: 50 }, () => submit(payload, key)),
    );
    const responses = await Promise.all(pending);

    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200]));
    expect(new Set(responses.map((response) => response.body.status))).toEqual(
      new Set([WagerTransactionStatus.Processed]),
    );
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    for (const response of responses) {
      expectMoney(response.body.balance, '75.00');
    }
    expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);

    expect(await transactionCount(scenario.providerId)).toBe(1);
    expect(await debitCount(scenario.walletId)).toBe(1);
    expect(await balanceOf(scenario.walletId)).toBe('75.00');
    expect(await outboxCount(scenario.walletId)).toBe(2);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('applies the same bet once out of 25 HTTP submissions racing 25 SQS deliveries of the same message (§13 c1)', async () => {
    const scenario = await newScenario();
    const payload = betPayload(scenario, 'bet-1');
    const key = keyOf(scenario, 'bet-1');
    const messageId = Bun.randomUUIDv7();
    const envelope = buildEnvelope({ messageId, data: payload });

    const pending = await submitWhileLocked([scenario.walletId], POOL_MAX, async () => {
      // Um `MessageGroupId` por cópia e um id de deduplicação novo por envio: nem a ordem nem o dedup do FIFO
      // colapsam as 25 entregas. De propósito: o banco é a garantia (§8), o broker é só otimização.
      await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          sendEnvelope(sqs, queues.queueUrl, envelope, { groupId: `${scenario.walletId}-${index}` }),
        ),
      );
      // O consumer chegou ao lock antes do HTTP: os dois canais estão na fila do mesmo lock.
      await waitForLockWaiters(1);
      return Array.from({ length: 25 }, () => submit(payload, key));
    });
    const responses = await Promise.all(pending);
    const lines = await waitForProcessedLines(messageId, 25);
    await waitForEmptyQueue(sqs, queues.queueUrl);

    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200]));
    expect(new Set(responses.map((response) => response.body.status))).toEqual(
      new Set([WagerTransactionStatus.Processed]),
    );
    for (const response of responses) {
      expectMoney(response.body.balance, '75.00');
    }
    expect(lines).toHaveLength(25);
    expect(new Set(lines.map((line) => line.status))).toEqual(new Set([WagerTransactionStatus.Processed]));
    const httpFirst = responses.filter((response) => !response.body.idempotentReplay).length;
    const sqsFirst = lines.filter((line) => line.idempotentReplay === false).length;
    expect(httpFirst + sqsFirst).toBe(1);
    const transactionIds = [
      ...responses.map((response) => response.body.transactionId),
      ...lines.map((line) => line.transactionId),
    ];
    expect(new Set(transactionIds).size).toBe(1);

    expect(await transactionCount(scenario.providerId)).toBe(1);
    expect(await debitCount(scenario.walletId)).toBe(1);
    expect(await inboxCount(messageId)).toBe(1);
    expect(await outboxCount(scenario.walletId)).toBe(2);
    expect(await balanceOf(scenario.walletId)).toBe('75.00');
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('accepts one of two simultaneous 80.00 HTTP bets on a 100.00 wallet and retries never debit again (§8)', async () => {
    const scenario = await newScenario();
    const a = { payload: betPayload(scenario, 'bet-a', '80.00'), key: keyOf(scenario, 'bet-a') };
    const b = { payload: betPayload(scenario, 'bet-b', '80.00'), key: keyOf(scenario, 'bet-b') };

    const pending = await submitWhileLocked(
      [scenario.walletId],
      2,
      async () => [submit(a.payload, a.key), submit(b.payload, b.key)] as const,
    );
    const [responseA, responseB] = await Promise.all(pending);

    const responses = [responseA, responseB];
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    const accepted = present(responses.find((response) => response.status === 200), 'accepted response');
    const rejected = present(responses.find((response) => response.status === 422), 'rejected response');
    expect(accepted.body.status).toBe(WagerTransactionStatus.Processed);
    expect(accepted.body.failureCode).toBeNull();
    expectMoney(accepted.body.balance, '20.00');
    expect(rejected.body.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected.body.failureCode).toBe(FailureCode.InsufficientFunds);
    expectMoney(rejected.body.balance, '20.00');

    expect(await debitCount(scenario.walletId)).toBe(1);
    expect(await transactionCount(scenario.providerId)).toBe(2);
    expect(await balanceOf(scenario.walletId)).toBe('20.00');
    expect(await outboxCount(scenario.walletId)).toBe(3);

    // Reenviar as duas apostas, várias vezes e ao mesmo tempo, devolve as respostas originais sem novo débito.
    const originals = new Map([
      [a.key, responseA],
      [b.key, responseB],
    ]);
    const retries = await Promise.all(
      [a, b].flatMap((bet) =>
        Array.from({ length: 5 }, async () => ({ bet, response: await submit(bet.payload, bet.key) })),
      ),
    );
    expect(retries).toHaveLength(10);
    for (const { bet, response } of retries) {
      const original = present(originals.get(bet.key), 'original response');
      expect(response.status).toBe(original.status);
      expect(response.body).toEqual({ ...original.body, idempotentReplay: true });
    }

    expect(await debitCount(scenario.walletId)).toBe(1);
    expect(await balanceOf(scenario.walletId)).toBe('20.00');
    expect(await transactionCount(scenario.providerId)).toBe(2);
    expect(await outboxCount(scenario.walletId)).toBe(3);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('accepts one of two simultaneous 80.00 bets when one arrives by HTTP and the other by SQS, and redelivery never debits again (§8)', async () => {
    const scenario = await newScenario();
    const httpPayload = betPayload(scenario, 'http-bet', '80.00');
    const httpKey = keyOf(scenario, 'http-bet');
    const sqsMessageId = Bun.randomUUIDv7();
    const envelope = buildEnvelope({ messageId: sqsMessageId, data: betPayload(scenario, 'sqs-bet', '80.00') });

    const pending = await submitWhileLocked([scenario.walletId], 2, async () => {
      await sendEnvelope(sqs, queues.queueUrl, envelope, { groupId: scenario.walletId });
      await waitForLockWaiters(1);
      return [submit(httpPayload, httpKey)] as const;
    });
    const [httpResponse] = await Promise.all(pending);
    await waitForProcessedLines(sqsMessageId, 1);

    const sqsRow = await transactionRow(scenario.providerId, 'sqs-bet');
    const outcomes = [httpResponse.body.status, sqsRow.status].sort();
    expect(outcomes).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected].sort());
    const rejectedCode =
      httpResponse.body.status === WagerTransactionStatus.Rejected ? httpResponse.body.failureCode : sqsRow.failure_code;
    expect(rejectedCode).toBe(FailureCode.InsufficientFunds);
    expect(httpResponse.status).toBe(httpResponse.body.status === WagerTransactionStatus.Processed ? 200 : 422);

    expect(await debitCount(scenario.walletId)).toBe(1);
    expect(await balanceOf(scenario.walletId)).toBe('20.00');
    expect(await outboxCount(scenario.walletId)).toBe(3);

    // A mesma mensagem reentregue (id de deduplicação novo) e o HTTP reenviado em paralelo: só replays.
    await sendEnvelope(sqs, queues.queueUrl, envelope, { groupId: scenario.walletId });
    const retries = await Promise.all(Array.from({ length: 3 }, () => submit(httpPayload, httpKey)));
    const lines = await waitForProcessedLines(sqsMessageId, 2);

    expect(lines.map((line) => line.idempotentReplay)).toEqual([false, true]);
    for (const retry of retries) {
      expect(retry.status).toBe(httpResponse.status);
      expect(retry.body).toEqual({ ...httpResponse.body, idempotentReplay: true });
    }
    expect(await inboxCount(sqsMessageId)).toBe(1);
    expect(await debitCount(scenario.walletId)).toBe(1);
    expect(await balanceOf(scenario.walletId)).toBe('20.00');
    expect(await transactionCount(scenario.providerId)).toBe(2);
    await waitForEmptyQueue(sqs, queues.queueUrl);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('keeps POOL_MAX submissions on distinct wallets blocked inside their transactions at the same time (no global lock, §13 c3)', async () => {
    const scenarios = await openScenarios(POOL_MAX);

    // `POOL_MAX` backends presos em `POOL_MAX` linhas diferentes no mesmo instante: com um lock global (no processo
    // ou no banco) só um passaria dele, e a barreira nunca chegaria a `POOL_MAX`.
    const pending = await submitWhileLocked(
      scenarios.map((scenario) => scenario.walletId),
      POOL_MAX,
      async () => scenarios.map((scenario) => submit(betPayload(scenario, 'bet-1'), keyOf(scenario, 'bet-1'))),
    );
    const responses = await Promise.all(pending);

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(WagerTransactionStatus.Processed);
      expectMoney(response.body.balance, '75.00');
    }
    for (const scenario of scenarios) {
      expect(await debitCount(scenario.walletId)).toBe(1);
      expect(await balanceOf(scenario.walletId)).toBe('75.00');
      await assertWalletConsistent(orm, scenario.walletId);
    }
  });

  it('processes 20 wallets × 6 parallel bets with exact per-wallet results (§13 c3)', async () => {
    const scenarios = await openScenarios(20);

    const results = await Promise.all(
      scenarios.flatMap((scenario) =>
        Array.from({ length: 6 }, async (_, index) => ({
          scenario,
          response: await submit(betPayload(scenario, `bet-${index}`, '20.00'), keyOf(scenario, `bet-${index}`)),
        })),
      ),
    );

    expect(results).toHaveLength(120);
    for (const scenario of scenarios) {
      const responses = results.filter((result) => result.scenario === scenario).map((result) => result.response);
      // Mesmo valor em todas as apostas: 5 cabem em 100.00 e a sexta sempre sobra, qualquer que seja a ordem.
      expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 200, 422]);
      for (const response of responses) {
        if (response.status === 200) {
          expect(response.body.status).toBe(WagerTransactionStatus.Processed);
        } else {
          expect(response.body.status).toBe(WagerTransactionStatus.Rejected);
          expect(response.body.failureCode).toBe(FailureCode.InsufficientFunds);
        }
      }
      expect(await balanceOf(scenario.walletId)).toBe('0.00');
      expect(await debitCount(scenario.walletId)).toBe(5);
      expect(await outboxCount(scenario.walletId)).toBe(11);
      await assertWalletConsistent(orm, scenario.walletId);
    }
  });

  it('runs 20 independent wallets faster in parallel than one after another (§13 c3)', async () => {
    const total = 20;
    // Aquecimento: conexões e caminhos de código já quentes não inflam a perna sequencial, medida primeiro.
    const warmUp = await newScenario();
    for (const externalTransactionId of ['warm-1', 'warm-2']) {
      await submit(betPayload(warmUp, externalTransactionId), keyOf(warmUp, externalTransactionId));
    }
    const sequentialScenarios = await openScenarios(total);
    const parallelScenarios = await openScenarios(total);
    const bet = (scenario: Scenario) => submit(betPayload(scenario, 'bet-1'), keyOf(scenario, 'bet-1'));

    const sequentialStart = performance.now();
    const sequential: Submitted[] = [];
    for (const scenario of sequentialScenarios) {
      sequential.push(await bet(scenario));
    }
    const sequentialMs = performance.now() - sequentialStart;

    const parallelStart = performance.now();
    const parallel = await Promise.all(parallelScenarios.map(bet));
    const parallelMs = performance.now() - parallelStart;

    for (const response of [...sequential, ...parallel]) {
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(WagerTransactionStatus.Processed);
    }
    // Sanidade de relógio numa máquina só; a prova determinística de que não há lock global é o teste da barreira.
    expect(parallelMs).toBeLessThan(sequentialMs);
    for (const scenario of [warmUp, ...sequentialScenarios, ...parallelScenarios]) {
      await assertWalletConsistent(orm, scenario.walletId);
    }
  });
});
