import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { WAGER_TRANSACTIONS_CONSUMER } from '../../src/modules/messaging/infrastructure/sqs/sqs-consumer-options';
import { defaultIdempotencyKey } from '../../src/modules/wagering/application/payload-hash';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import type { SubmitResponse } from '../../src/modules/wagering/presentation/wager-transaction-http.schemas';
import { FailureCode } from '../../src/shared/domain/failure-code';
import { startAppProcess, type AppProcess } from '../support/app-process';
import { createTestApp } from '../support/create-test-app';
import { newProviderId, openWalletWithBalance } from '../support/fixtures';
import { expectMoney, postJson, type HttpResult } from '../support/http';
import type { LogLine } from '../support/log-capture';
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
import { holdWalletLocks, walletLockWaitersByApplication } from '../support/wallet-lock';

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

type ReversalKind = 'REFUND' | 'ROLLBACK';

const INSTANCE_COUNT = 3;
// O padrão do `.env`, fixado aqui: o pool inteiro de uma instância tem que caber no lock para a barreira contá-lo.
const POOL_MAX = 10;
// Com lote 2, "toda instância tem ao menos 1 backend no lock, só com tráfego SQS" prova que os 3 consumers estão
// dentro da transação: nenhum consumer sozinho pega todas as mensagens enviadas.
const SQS_BATCH_SIZE = 2;
const LONG_POLL_SECONDS = 1;
// Longa de propósito: as mensagens ficam presas no lock e não podem ser reentregues por expiração no meio do teste,
// o que mudaria a contagem de linhas `sqs message processed`.
const VISIBILITY_TIMEOUT_SECONDS = 30;
const CHILD_LOCK_TIMEOUT_MS = 10000;
// Abaixo do lock timeout dos filhos: esperar a barreira nunca corre contra um `lock_timeout` com retry.
const BARRIER_TIMEOUT_MS = 8000;

// `DB_POOL_ACQUIRE_TIMEOUT_MS` fica acima de lock timeout × tentativas + backoff (regra de dimensionamento em
// `src/config/env.ts`): a espera pelo lock de uma wallet não esgota a espera por conexão das outras.
const CHILD_ENV: Record<string, string> = {
  DATABASE_POOL_MAX: String(POOL_MAX),
  DB_LOCK_TIMEOUT_MS: String(CHILD_LOCK_TIMEOUT_MS),
  DB_POOL_ACQUIRE_TIMEOUT_MS: '35000',
  SQS_CONSUMER_WAIT_TIME_SECONDS: String(LONG_POLL_SECONDS),
  SQS_CONSUMER_BATCH_SIZE: String(SQS_BATCH_SIZE),
  SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS: '5000',
  // Publisher e worker de PENDING_REFERENCE agiriam também sobre linhas deixadas por outras suítes; T31 os cobre.
  OUTBOX_PUBLISHER_ENABLED: 'false',
  PENDING_REFERENCE_WORKER_ENABLED: 'false',
  LOG_LEVEL: 'info',
};

function range(total: number): number[] {
  return Array.from({ length: total }, (_, index) => index);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
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

/** A confirmação (`DeleteMessage`) vem depois do commit, então o esvaziamento da fila é esperado, não instantâneo. */
async function waitForEmptyQueue(client: SQSClient, queueUrl: string, timeoutMs = 10000): Promise<void> {
  await waitFor(async () => {
    const depth = await queueDepth(client, queueUrl);
    return depth.visible === 0 && depth.inFlight === 0 ? true : null;
  }, timeoutMs);
}

describe('multi-instance concurrency (3 processos reais, Postgres + LocalStack reais)', () => {
  const sqs = createTestSqsClient();
  let queues: TemporaryQueues;
  let control: INestApplication;
  let orm: MikroORM;
  let instances: AppProcess[] = [];

  beforeAll(async () => {
    queues = await createTemporaryQueues(sqs, { visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS });
    // App de controle no processo do teste, sem workers e sem tráfego: só cria fixtures, segura locks e sonda
    // `pg_stat_activity`, com pool próprio que funciona mesmo com o pool dos 3 filhos esgotado.
    control = await createTestApp();
    orm = control.get(MikroORM);
    const childEnv = {
      ...CHILD_ENV,
      SQS_WAGER_QUEUE_URL: queues.queueUrl,
      SQS_WAGER_DLQ_URL: queues.deadLetterQueueUrl,
    };
    instances = await Promise.all(
      range(INSTANCE_COUNT).map((index) => startAppProcess({ instanceId: `instance-${index + 1}`, env: childEnv })),
    );
  }, 60000);

  afterAll(async () => {
    await Promise.all(instances.map((instance) => instance.stop()));
    // O servidor segue com o `ReceiveMessage` abortado até `WaitTimeSeconds` e entrega a próxima mensagem a essa
    // conexão morta: sem a espera, o long poll morto ainda estaria vivo ao apagar a fila.
    await Bun.sleep(LONG_POLL_SECONDS * 1000 + 200);
    await queues.remove();
    await control.close();
    sqs.destroy();
  });

  async function newScenario(balance = '100.00'): Promise<Scenario> {
    const { wallet } = await openWalletWithBalance(control, { amount: balance });
    return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
  }

  function openScenarios(total: number): Promise<Scenario[]> {
    return Promise.all(range(total).map(() => newScenario()));
  }

  function instanceAt(index: number): AppProcess {
    return present(instances[index], `instance ${index}`);
  }

  function submit(instance: AppProcess, payload: Record<string, unknown>, key: string): Promise<Submitted> {
    return postJson<SubmitResponse>(instance.baseUrl, '/wagering/transactions', payload, { 'Idempotency-Key': key });
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

  /** Resultado por `status:failure_code` das transações do provider, sem a de abertura (outro provider). */
  async function outcomesOf(providerId: string): Promise<Record<string, number>> {
    const rows = await orm.em
      .fork()
      .execute<{ status: string; failure_code: string | null; total: number }[]>(
        `select status, failure_code, count(*)::int as total from wager_transactions
          where provider_id = ? group by status, failure_code`,
        [providerId],
      );
    return Object.fromEntries(rows.map((row) => [`${row.status}:${row.failure_code ?? 'none'}`, row.total]));
  }

  /** O log de `sqs message processed` sai depois do ack, então as linhas são esperadas, não lidas de imediato. */
  function waitForProcessedLines(messageId: string, expected: number): Promise<LogLine[]> {
    return waitFor(async () => {
      const found = instances
        .flatMap((instance) => instance.lines())
        .filter((line) => line.msg === 'sqs message processed' && line.messageId === messageId);
      return found.length >= expected ? found : null;
    }, 10000);
  }

  /** Backends presos no lock da wallet por instância, na ordem de `instances`. */
  async function waitersByInstance(): Promise<number[]> {
    const byApplication = await walletLockWaitersByApplication(orm);
    return instances.map((instance) => byApplication.get(instance.applicationName) ?? 0);
  }

  function waitForWaiters(ready: (perInstance: number[]) => boolean): Promise<number[]> {
    return waitFor(
      async () => {
        const waiters = await waitersByInstance();
        return ready(waiters) ? waiters : null;
      },
      BARRIER_TIMEOUT_MS,
      20,
    );
  }

  /**
   * Segura o lock das wallets, dispara as submissões (`fire` devolve as promessas sem esperá-las) e só solta quando
   * `ready` aceita a contagem de backends presos no lock em CADA instância. É a barreira que prova que as instâncias
   * estavam em voo ao mesmo tempo sobre a mesma linha, em vez de torcer para o `Promise.all` sobrepô-las.
   * O `finally` solta o lock mesmo se a espera falhar.
   */
  async function submitWhileLocked<T>(
    walletIds: string[],
    ready: (perInstance: number[]) => boolean,
    fire: () => Promise<T>,
  ): Promise<T> {
    const holder = await holdWalletLocks(orm, walletIds);
    try {
      const fired = await fire();
      await waitForWaiters(ready);
      return fired;
    } finally {
      await holder.release();
    }
  }

  /**
   * Quatro transações distintas na mesma wallet, todas presas no lock ao mesmo tempo: uma mensagem SQS e uma submissão
   * HTTP por instância. A barreira só solta com as quatro dentro da transação e ao menos uma em cada instância.
   */
  function submitFourWhileLocked(
    scenario: Scenario,
    http: { externalTransactionId: string; payload: Record<string, unknown> }[],
    sqsMessage: { messageId: string; payload: Record<string, unknown> },
  ): Promise<Promise<Submitted>[]> {
    return submitWhileLocked(
      [scenario.walletId],
      (waiters) => waiters.every((total) => total >= 1) && sum(waiters) >= http.length + 1,
      async () => {
        await sendEnvelope(
          sqs,
          queues.queueUrl,
          buildEnvelope({ messageId: sqsMessage.messageId, data: sqsMessage.payload }),
          { groupId: scenario.walletId },
        );
        // O consumer chegou ao lock antes do HTTP: os dois canais estão na fila do mesmo lock.
        await waitForWaiters((waiters) => sum(waiters) >= 1);
        return http.map(({ externalTransactionId, payload }, index) =>
          submit(instanceAt(index), payload, keyOf(scenario, externalTransactionId)),
        );
      },
    );
  }

  it('applies the same bet once when 3 instances race it over HTTP and SQS (§13 c4, §5.8)', async () => {
    const scenario = await newScenario();
    const payload = betPayload(scenario, 'bet-1');
    const key = keyOf(scenario, 'bet-1');
    const messageId = Bun.randomUUIDv7();
    const envelope = buildEnvelope({ messageId, data: payload });
    const sqsCopies = 9;

    const pending = await submitWhileLocked(
      [scenario.walletId],
      // Cada instância com o pool inteiro preso na linha: consumers e requisições HTTP juntos somam `POOL_MAX`.
      (waiters) => waiters.every((total) => total >= POOL_MAX),
      async () => {
        // Um `MessageGroupId` por cópia e um id de deduplicação novo por envio: nem a ordem nem o dedup do FIFO
        // colapsam as entregas. De propósito: o banco é a garantia (§8), o broker é só otimização.
        await Promise.all(
          range(sqsCopies).map((index) =>
            sendEnvelope(sqs, queues.queueUrl, envelope, { groupId: `${scenario.walletId}-${index}` }),
          ),
        );
        // Só há tráfego SQS até aqui: toda instância com backend no lock é um consumer dentro da transação.
        await waitForWaiters((waiters) => waiters.every((total) => total >= 1));
        return instances.flatMap((instance) => range(POOL_MAX).map(() => submit(instance, payload, key)));
      },
    );
    const responses = await Promise.all(pending);
    const lines = await waitForProcessedLines(messageId, sqsCopies);
    await waitForEmptyQueue(sqs, queues.queueUrl);

    expect(responses).toHaveLength(INSTANCE_COUNT * POOL_MAX);
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200]));
    expect(new Set(responses.map((response) => response.body.status))).toEqual(
      new Set([WagerTransactionStatus.Processed]),
    );
    for (const response of responses) {
      expectMoney(response.body.balance, '75.00');
    }
    expect(lines).toHaveLength(sqsCopies);
    expect(new Set(lines.map((line) => line.status))).toEqual(new Set([WagerTransactionStatus.Processed]));
    expect(new Set(lines.map((line) => line.instanceId)).size).toBe(INSTANCE_COUNT);
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

  it('accepts one of four simultaneous 80.00 bets spread over 3 instances and SQS, and cross-instance retries never debit again (§8)', async () => {
    const scenario = await newScenario();
    const bets = range(INSTANCE_COUNT).map((index) => {
      const externalTransactionId = `http-${index + 1}`;
      return { externalTransactionId, payload: betPayload(scenario, externalTransactionId, '80.00') };
    });
    const sqsMessageId = Bun.randomUUIDv7();
    const sqsPayload = betPayload(scenario, 'sqs-bet', '80.00');

    const pending = await submitFourWhileLocked(scenario, bets, { messageId: sqsMessageId, payload: sqsPayload });
    const responses = await Promise.all(pending);
    await waitForProcessedLines(sqsMessageId, 1);

    const sqsRow = await transactionRow(scenario.providerId, 'sqs-bet');
    const outcomes = [...responses.map((response) => response.body.status), sqsRow.status];
    expect(outcomes.filter((status) => status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(outcomes.filter((status) => status === WagerTransactionStatus.Rejected)).toHaveLength(3);
    for (const response of responses) {
      expect(response.status).toBe(response.body.status === WagerTransactionStatus.Processed ? 200 : 422);
      if (response.body.status === WagerTransactionStatus.Rejected) {
        expect(response.body.failureCode).toBe(FailureCode.InsufficientFunds);
        expectMoney(response.body.balance, '20.00');
      }
    }
    if (sqsRow.status === WagerTransactionStatus.Rejected) {
      expect(sqsRow.failure_code).toBe(FailureCode.InsufficientFunds);
    }

    expect(await debitCount(scenario.walletId)).toBe(1);
    expect(await transactionCount(scenario.providerId)).toBe(4);
    expect(await balanceOf(scenario.walletId)).toBe('20.00');
    expect(await outboxCount(scenario.walletId)).toBe(5);

    // Cada aposta HTTP reenviada às duas OUTRAS instâncias, e a mensagem SQS reentregue (id de deduplicação novo):
    // só replays, nenhuma instância reaplica o que outra decidiu.
    const retries = await Promise.all(
      bets.flatMap(({ externalTransactionId, payload }, index) =>
        range(INSTANCE_COUNT)
          .filter((target) => target !== index)
          .map(async (target) => ({
            original: present(responses[index], 'original response'),
            retry: await submit(instanceAt(target), payload, keyOf(scenario, externalTransactionId)),
          })),
      ),
    );
    await sendEnvelope(sqs, queues.queueUrl, buildEnvelope({ messageId: sqsMessageId, data: sqsPayload }), {
      groupId: scenario.walletId,
    });
    const lines = await waitForProcessedLines(sqsMessageId, 2);

    expect(retries).toHaveLength(INSTANCE_COUNT * (INSTANCE_COUNT - 1));
    for (const { original, retry } of retries) {
      expect(retry.status).toBe(original.status);
      expect(retry.body).toEqual({ ...original.body, idempotentReplay: true });
    }
    expect(lines.filter((line) => line.idempotentReplay === false)).toHaveLength(1);
    expect(lines.filter((line) => line.idempotentReplay === true)).toHaveLength(1);
    expect(await inboxCount(sqsMessageId)).toBe(1);
    expect(await debitCount(scenario.walletId)).toBe(1);
    expect(await balanceOf(scenario.walletId)).toBe('20.00');
    expect(await transactionCount(scenario.providerId)).toBe(4);
    expect(await outboxCount(scenario.walletId)).toBe(5);
    await waitForEmptyQueue(sqs, queues.queueUrl);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('reverses a bet only once when 3 instances and SQS race REFUND/ROLLBACK for it (no duplicate credit)', async () => {
    const scenario = await newScenario();
    const bet = await submit(instanceAt(0), betPayload(scenario, 'bet-1', '30.00'), keyOf(scenario, 'bet-1'));
    expect(bet.status).toBe(200);
    expect(bet.body.status).toBe(WagerTransactionStatus.Processed);
    expectMoney(bet.body.balance, '70.00');

    const reversals = [
      { externalTransactionId: 'refund-1', payload: reversalPayload(scenario, 'refund-1', 'REFUND', 'bet-1') },
      { externalTransactionId: 'refund-2', payload: reversalPayload(scenario, 'refund-2', 'REFUND', 'bet-1') },
      { externalTransactionId: 'rollback-3', payload: reversalPayload(scenario, 'rollback-3', 'ROLLBACK', 'bet-1') },
    ];
    const sqsMessageId = Bun.randomUUIDv7();
    const sqsPayload = reversalPayload(scenario, 'refund-sqs', 'REFUND', 'bet-1');

    const pending = await submitFourWhileLocked(scenario, reversals, { messageId: sqsMessageId, payload: sqsPayload });
    const responses = await Promise.all(pending);
    await waitForProcessedLines(sqsMessageId, 1);

    const sqsRow = await transactionRow(scenario.providerId, 'refund-sqs');
    const outcomes = [...responses.map((response) => response.body.status), sqsRow.status];
    expect(outcomes.filter((status) => status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(outcomes.filter((status) => status === WagerTransactionStatus.Rejected)).toHaveLength(3);
    for (const response of responses) {
      expect(response.status).toBe(response.body.status === WagerTransactionStatus.Processed ? 200 : 422);
      if (response.body.status === WagerTransactionStatus.Rejected) {
        expect(response.body.failureCode).toBe(FailureCode.AlreadyReversed);
      }
    }
    if (sqsRow.status === WagerTransactionStatus.Rejected) {
      expect(sqsRow.failure_code).toBe(FailureCode.AlreadyReversed);
    }

    expect(await balanceOf(scenario.walletId)).toBe('100.00');
    // Abertura + um único estorno; o débito é o da aposta.
    expect(await creditCount(scenario.walletId)).toBe(2);
    expect(await debitCount(scenario.walletId)).toBe(1);
    expect(await transactionCount(scenario.providerId)).toBe(5);
    await waitForEmptyQueue(sqs, queues.queueUrl);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('keeps exact per-wallet results when 12 wallets are hit by all 3 instances over HTTP and SQS at once (§13 c4)', async () => {
    const scenarios = await openScenarios(12);
    const httpBets = 4;
    const sqsBets = 3;
    const sqsDeliveries = 2;

    const messages = scenarios.flatMap((scenario) =>
      range(sqsBets).map((index) => {
        const externalTransactionId = `s-${index}`;
        return {
          scenario,
          messageId: Bun.randomUUIDv7(),
          externalTransactionId,
          payload: betPayload(scenario, externalTransactionId, '20.00'),
        };
      }),
    );
    // Cada mensagem entra duas vezes, em grupos diferentes: a reentrega que o FIFO não colapsa.
    await Promise.all(
      messages.flatMap(({ scenario, messageId, externalTransactionId, payload }) =>
        range(sqsDeliveries).map((delivery) =>
          sendEnvelope(sqs, queues.queueUrl, buildEnvelope({ messageId, data: payload }), {
            groupId: `${scenario.walletId}-${externalTransactionId}-${delivery}`,
          }),
        ),
      ),
    );

    // Cada aposta HTTP vai às 3 instâncias com a mesma key: as 3 respostas têm que ser a mesma decisão.
    const bets = scenarios.flatMap((scenario) =>
      range(httpBets).map((index) => ({
        scenario,
        key: keyOf(scenario, `h-${index}`),
        payload: betPayload(scenario, `h-${index}`, '20.00'),
      })),
    );
    const results = await Promise.all(
      bets.map(async (bet) => ({
        ...bet,
        responses: await Promise.all(instances.map((instance) => submit(instance, bet.payload, bet.key))),
      })),
    );
    const linesByMessage = new Map<string, LogLine[]>();
    for (const { messageId } of messages) {
      linesByMessage.set(messageId, await waitForProcessedLines(messageId, sqsDeliveries));
    }
    await waitForEmptyQueue(sqs, queues.queueUrl);

    expect(results).toHaveLength(scenarios.length * httpBets);
    for (const { responses } of results) {
      expect(responses).toHaveLength(INSTANCE_COUNT);
      for (const response of responses) {
        expect([200, 422]).toContain(response.status);
      }
      expect(new Set(responses.map((response) => response.status)).size).toBe(1);
      expect(new Set(responses.map((response) => response.body.status)).size).toBe(1);
      expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
      expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
    }
    for (const lines of linesByMessage.values()) {
      expect(lines).toHaveLength(sqsDeliveries);
      expect(lines.filter((line) => line.idempotentReplay === false)).toHaveLength(1);
      expect(new Set(lines.map((line) => line.transactionId)).size).toBe(1);
    }

    for (const scenario of scenarios) {
      // Mesmo valor em todas as apostas: 5 cabem em 100.00 e as 2 restantes sobram, qualquer que seja a ordem.
      expect(await outcomesOf(scenario.providerId)).toEqual({
        'PROCESSED:none': 5,
        [`REJECTED:${FailureCode.InsufficientFunds}`]: 2,
      });
      expect(await transactionCount(scenario.providerId)).toBe(httpBets + sqsBets);
      expect(await debitCount(scenario.walletId)).toBe(5);
      expect(await balanceOf(scenario.walletId)).toBe('0.00');
      expect(await outboxCount(scenario.walletId)).toBe(12);
      const inboxRows = await Promise.all(
        messages.filter((message) => message.scenario === scenario).map(({ messageId }) => inboxCount(messageId)),
      );
      expect(inboxRows).toEqual([1, 1, 1]);
      await assertWalletConsistent(orm, scenario.walletId);
    }
  });
});
