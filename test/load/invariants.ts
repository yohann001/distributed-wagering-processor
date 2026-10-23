import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

import { queueDepth } from '../support/sqs';
import { assertWalletConsistent } from '../support/wallet-consistency';
import type { LoadConfig } from './load-config';
import { summarize, type LatencySummary } from './stats';
import { mapWithLimit, type SubmissionRecord, type Temperature } from './workload';

const POLL_INTERVAL_MS = 500;
const CHUNK_SIZE = 500;
const RECONCILIATION_IN_FLIGHT = 16;
const CONSISTENCY_CHECKS_IN_FLIGHT = 4;
const MAX_FAILURES_LISTED = 5;

/** Chaves `provider:external` das transações persistidas; `\u0000` não aparece em ids (o schema de entrada o recusa). */
function keyOf(providerId: string, externalTransactionId: string): string {
  return `${providerId}\u0000${externalTransactionId}`;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Os agregados do experimento na outbox: as wallets e as transações dessas wallets (a abertura incluída). O CTE
 * recebe os ids como lista de placeholders (`?`), nunca concatenados no SQL.
 */
function runAggregates(walletIds: readonly string[]): { cte: string; params: string[] } {
  const list = placeholders(walletIds);
  return {
    cte: `with run_aggregates as (
            select id from wallets where id in (${list})
            union
            select id from wager_transactions where wallet_id in (${list})
          )`,
    params: [...walletIds, ...walletIds],
  };
}

async function rows<T>(orm: MikroORM, sql: string, params: unknown[] = []): Promise<T[]> {
  return orm.em.fork().execute<T[]>(sql, params);
}

async function scalar(orm: MikroORM, sql: string, params: unknown[] = []): Promise<number> {
  const result = await rows<{ total: number }>(orm, sql, params);
  return result[0]?.total ?? 0;
}

/** Deadlocks acumulados do banco (`pg_stat_database`), para o delta da execução. */
export function readDeadlocks(orm: MikroORM): Promise<number> {
  return scalar(orm, 'select deadlocks::int as total from pg_stat_database where datname = current_database()');
}

export async function postgresVersion(orm: MikroORM): Promise<string> {
  const result = await rows<{ version: string }>(orm, 'select version() as version');
  return result[0]?.version ?? 'unknown';
}

export interface BacklogSample {
  /** Relógio de parede (ms desde a época). */
  at: number;
  pending: number;
  oldestAgeSeconds: number;
  /** Mensagens visíveis e em voo da fila de transações (números aproximados do SQS); -1 quando a leitura falhou. */
  sqsVisible: number;
  sqsInFlight: number;
}

async function sampleBacklog(
  orm: MikroORM,
  walletIds: readonly string[],
  sqs: SQSClient,
  queueUrl: string,
): Promise<BacklogSample> {
  const { cte, params } = runAggregates(walletIds);
  const result = await rows<{ pending: number; oldest: number }>(
    orm,
    `${cte}
     select count(*)::int as pending,
            coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as oldest
       from outbox_messages
      where published_at is null and aggregate_id in (select id from run_aggregates)`,
    params,
  );
  // Uma leitura de profundidade que falha vira -1 naquele instante: a série do banco não pode se perder por isso.
  const depth = await queueDepth(sqs, queueUrl).catch(() => ({ visible: -1, inFlight: -1 }));
  return {
    at: Date.now(),
    pending: result[0]?.pending ?? 0,
    oldestAgeSeconds: result[0]?.oldest ?? 0,
    sqsVisible: depth.visible,
    sqsInFlight: depth.inFlight,
  };
}

/**
 * Amostra a cada `intervalMs`, até o `stop`, a fila pendente da outbox (só dos agregados do experimento) e a
 * profundidade da fila de transações.
 */
export function startBacklogSampler(
  orm: MikroORM,
  walletIds: readonly string[],
  sqs: SQSClient,
  queueUrl: string,
  intervalMs = 1000,
): { stop(): Promise<BacklogSample[]> } {
  const samples: BacklogSample[] = [];
  let running = true;
  let failure: unknown = null;
  const loop = (async () => {
    while (running) {
      try {
        samples.push(await sampleBacklog(orm, walletIds, sqs, queueUrl));
      } catch (error) {
        failure = error;
        return;
      }
      await Bun.sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      if (failure !== null) {
        throw failure;
      }
      return samples;
    },
  };
}

/** Quais submissões já têm linha em `wager_transactions` (consulta em lotes pelo índice único de provider + id). */
async function persistedKeys(orm: MikroORM, submissions: readonly SubmissionRecord[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunked(submissions, CHUNK_SIZE)) {
    const result = await rows<{ provider_id: string; external_transaction_id: string }>(
      orm,
      `select provider_id, external_transaction_id from wager_transactions
        where (provider_id, external_transaction_id) in (${chunk.map(() => '(?, ?)').join(', ')})`,
      chunk.flatMap((submission) => [submission.providerId, submission.externalTransactionId]),
    );
    for (const row of result) {
      found.add(keyOf(row.provider_id, row.external_transaction_id));
    }
  }
  return found;
}

const pendingReferenceCount = (orm: MikroORM, walletIds: readonly string[]): Promise<number> =>
  scalar(
    orm,
    `select count(*)::int as total from wager_transactions
      where status = 'PENDING_REFERENCE' and wallet_id in (${placeholders(walletIds)})`,
    [...walletIds],
  );

async function unpublishedOutboxCount(orm: MikroORM, walletIds: readonly string[]): Promise<number> {
  const { cte, params } = runAggregates(walletIds);
  return scalar(
    orm,
    `${cte}
     select count(*)::int as total from outbox_messages
      where published_at is null and aggregate_id in (select id from run_aggregates)`,
    params,
  );
}

export interface DrainContext {
  walletIds: readonly string[];
  submissions: readonly SubmissionRecord[];
  sqs: SQSClient;
  queueUrl: string;
}

export interface DrainResult {
  /** Instante (ms) em que toda mensagem SQS enviada já tinha transação e nenhuma `PENDING_REFERENCE` sobrava. */
  sqsDrainedAt: number | null;
  /** Instante (ms) em que, além disso, não restava evento pendente na outbox. */
  outboxDrainedAt: number | null;
  pendingReferenceLeft: number;
  missingSqsTransactions: number;
  unpublishedOutbox: number;
  queueDepthLeft: { visible: number; inFlight: number };
}

/**
 * Espera o sistema assentar depois da carga: toda mensagem SQS enviada virou transação, nenhuma `PENDING_REFERENCE`
 * sobrou e a outbox dos agregados do experimento foi publicada. Desiste em `drainTimeoutSeconds`. A profundidade da
 * fila é só informativa: os números do SQS são aproximados.
 */
export async function waitForDrain(orm: MikroORM, config: LoadConfig, ctx: DrainContext): Promise<DrainResult> {
  const deadline = Date.now() + config.drainTimeoutSeconds * 1000;
  let remaining = ctx.submissions.filter((submission) => submission.channel === 'sqs');
  let sqsDrainedAt: number | null = null;
  let outboxDrainedAt: number | null = null;
  let pendingReferenceLeft = 0;
  let unpublishedOutbox = 0;

  for (;;) {
    if (sqsDrainedAt === null) {
      const found = await persistedKeys(orm, remaining);
      remaining = remaining.filter((submission) => !found.has(keyOf(submission.providerId, submission.externalTransactionId)));
      pendingReferenceLeft = await pendingReferenceCount(orm, ctx.walletIds);
      if (remaining.length === 0 && pendingReferenceLeft === 0) {
        sqsDrainedAt = Date.now();
      }
    }
    if (sqsDrainedAt !== null) {
      unpublishedOutbox = await unpublishedOutboxCount(orm, ctx.walletIds);
      if (unpublishedOutbox === 0) {
        outboxDrainedAt = Date.now();
        break;
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  return {
    sqsDrainedAt,
    outboxDrainedAt,
    pendingReferenceLeft,
    missingSqsTransactions: remaining.length,
    unpublishedOutbox,
    queueDepthLeft: await queueDepth(ctx.sqs, ctx.queueUrl),
  };
}

export interface OutboxLag {
  /** Eventos publicados dos agregados do experimento. */
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

/** Lag exato (segundos entre `occurred_at` e `published_at`) dos eventos publicados do experimento, calculado no banco. */
export async function outboxLag(orm: MikroORM, walletIds: readonly string[]): Promise<OutboxLag> {
  const { cte, params } = runAggregates(walletIds);
  const result = await rows<{ total: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }>(
    orm,
    `${cte}
     select count(*)::int as total,
            percentile_cont(0.50) within group (order by extract(epoch from published_at - occurred_at))::float8 as p50,
            percentile_cont(0.95) within group (order by extract(epoch from published_at - occurred_at))::float8 as p95,
            percentile_cont(0.99) within group (order by extract(epoch from published_at - occurred_at))::float8 as p99,
            max(extract(epoch from published_at - occurred_at))::float8 as max
       from outbox_messages
      where published_at is not null and aggregate_id in (select id from run_aggregates)`,
    params,
  );
  const row = result[0];
  return {
    count: row?.total ?? 0,
    p50: row?.p50 ?? null,
    p95: row?.p95 ?? null,
    p99: row?.p99 ?? null,
    max: row?.max ?? null,
  };
}

export interface SendWindowLatency {
  fromSecond: number;
  toSecond: number;
  summary: LatencySummary;
}

export interface SqsLatency {
  overall: LatencySummary;
  byTemperature: Record<Temperature, LatencySummary>;
  /** Janelas de 10 s do instante de envio, contadas do início da carga (aquecimento incluído). */
  bySendWindow: SendWindowLatency[];
}

const SEND_WINDOW_SECONDS = 10;

/**
 * Latência ponta a ponta das mensagens SQS em ms: `coalesce(processed_at, created_at)` da transação menos o
 * instante do envio no cliente. Os dois relógios são o do mesmo host, mas o de `processed_at` é o da réplica.
 * Resumida no geral, por temperatura da wallet e por janela de 10 s do instante de envio (`workloadStartedAt`).
 */
export async function sqsEndToEndLatency(
  orm: MikroORM,
  submissions: readonly SubmissionRecord[],
  workloadStartedAt: number,
): Promise<SqsLatency> {
  const sentByKey = new Map(
    submissions
      .filter((submission) => submission.channel === 'sqs')
      .map((submission) => [
        keyOf(submission.providerId, submission.externalTransactionId),
        { sentAt: submission.sentAt, temperature: submission.temperature },
      ]),
  );
  const measured: { latency: number; temperature: Temperature; sentAt: number }[] = [];
  for (const chunk of chunked([...sentByKey.keys()], CHUNK_SIZE)) {
    const pairs = chunk.map((key) => key.split('\u0000') as [string, string]);
    const result = await rows<{ provider_id: string; external_transaction_id: string; done_ms: number }>(
      orm,
      `select provider_id, external_transaction_id,
              (extract(epoch from coalesce(processed_at, created_at)) * 1000)::float8 as done_ms
         from wager_transactions
        where (provider_id, external_transaction_id) in (${pairs.map(() => '(?, ?)').join(', ')})`,
      pairs.flat(),
    );
    for (const row of result) {
      const sent = sentByKey.get(keyOf(row.provider_id, row.external_transaction_id));
      if (sent !== undefined) {
        measured.push({ latency: row.done_ms - sent.sentAt, temperature: sent.temperature, sentAt: sent.sentAt });
      }
    }
  }

  const latenciesOf = (keep: (entry: (typeof measured)[number]) => boolean): number[] =>
    measured.filter(keep).map((entry) => entry.latency);
  const windowOf = (sentAt: number): number =>
    Math.max(0, Math.floor((sentAt - workloadStartedAt) / (SEND_WINDOW_SECONDS * 1000)));
  const lastSendSecond = Math.max(0, ...measured.map((entry) => (entry.sentAt - workloadStartedAt) / 1000));
  const lastWindow = Math.max(-1, ...measured.map((entry) => windowOf(entry.sentAt)));

  return {
    overall: summarize(latenciesOf(() => true)),
    byTemperature: {
      hot: summarize(latenciesOf((entry) => entry.temperature === 'hot')),
      cold: summarize(latenciesOf((entry) => entry.temperature === 'cold')),
    },
    bySendWindow: Array.from({ length: lastWindow + 1 }, (_, index) => ({
      fromSecond: index * SEND_WINDOW_SECONDS,
      // A última janela pode ser mais curta: vai até o último envio, arredondado para cima.
      toSecond: Math.min(
        (index + 1) * SEND_WINDOW_SECONDS,
        Math.max(index * SEND_WINDOW_SECONDS + 1, Math.ceil(lastSendSecond)),
      ),
      summary: summarize(latenciesOf((entry) => windowOf(entry.sentAt) === index)),
    })),
  };
}

export interface OutcomeRow {
  kind: string;
  status: string;
  failureCode: string | null;
  count: number;
}

/** Desfechos persistidos das transações do experimento (identificadas pelos providers próprios da execução). */
export async function outcomeBreakdown(orm: MikroORM, providers: readonly string[]): Promise<OutcomeRow[]> {
  const result = await rows<{ kind: string; status: string; failure_code: string | null; total: number }>(
    orm,
    `select kind, status, failure_code, count(*)::int as total
       from wager_transactions
      where provider_id in (${placeholders(providers)})
      group by kind, status, failure_code
      order by kind, status, failure_code nulls first`,
    [...providers],
  );
  return result.map((row) => ({
    kind: row.kind,
    status: row.status,
    failureCode: row.failure_code,
    count: row.total,
  }));
}

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface InvariantContext {
  walletIds: readonly string[];
  providers: readonly string[];
  submissions: readonly SubmissionRecord[];
  replayMismatches: readonly string[];
  /** Replays HTTP enviados (`BET_REPLAY`), só para o detalhe do relatório. */
  httpReplays: number;
}

type CheckOutcome = { ok: boolean; detail: string };

/** Uma checagem que falha ao executar (erro de banco, rede) conta como reprovada em vez de abortar as demais. */
async function check(name: string, run: () => Promise<CheckOutcome>): Promise<InvariantResult> {
  try {
    return { name, ...(await run()) };
  } catch (error) {
    return { name, ok: false, detail: `check could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const HTTP_DECIDED_STATUSES = [200, 202, 422];

/** As invariantes financeiras de §3, §6 e §7 lidas do banco real depois da drenagem; nunca lança por checagem reprovada. */
export async function verifyInvariants(
  orm: MikroORM,
  config: LoadConfig,
  ctx: InvariantContext,
): Promise<InvariantResult[]> {
  const wallets = placeholders(ctx.walletIds);
  const providers = placeholders(ctx.providers);
  const sqsSubmissions = ctx.submissions.filter((submission) => submission.channel === 'sqs');
  const httpSubmissions = ctx.submissions.filter((submission) => submission.channel === 'http');

  return [
    await check('(a) SQS messages became transactions, none left PENDING_REFERENCE', async () => {
      const found = await persistedKeys(orm, sqsSubmissions);
      const missing = sqsSubmissions.filter(
        (submission) => !found.has(keyOf(submission.providerId, submission.externalTransactionId)),
      ).length;
      const pending = await pendingReferenceCount(orm, ctx.walletIds);
      return {
        ok: missing === 0 && pending === 0,
        detail: `${sqsSubmissions.length} SQS transactions sent, ${missing} missing; ${pending} PENDING_REFERENCE left`,
      };
    }),

    await check('(b) every outbox event of the run was published', async () => {
      const unpublished = await unpublishedOutboxCount(orm, ctx.walletIds);
      return { ok: unpublished === 0, detail: `${unpublished} unpublished outbox rows` };
    }),

    await check('(c) no duplicate transactions; each HTTP submission persisted once', async () => {
      const duplicates = await scalar(
        orm,
        `select count(*)::int as total from (
           select 1 from wager_transactions where provider_id in (${providers})
            group by provider_id, external_transaction_id having count(*) > 1
         ) duplicated`,
        [...ctx.providers],
      );
      const found = await persistedKeys(orm, httpSubmissions);
      const isPersisted = (submission: SubmissionRecord): boolean =>
        found.has(keyOf(submission.providerId, submission.externalTransactionId));
      const isDecided = (submission: SubmissionRecord): boolean =>
        HTTP_DECIDED_STATUSES.includes(submission.httpStatus ?? -1);
      const decided = httpSubmissions.filter(isDecided);
      const undecided = httpSubmissions.filter((submission) => !isDecided(submission));
      const decidedMissing = decided.filter((submission) => !isPersisted(submission)).length;
      return {
        ok: duplicates === 0 && decidedMissing === 0,
        detail: `${duplicates} duplicated (provider, externalTransactionId) pairs; ${decided.length} HTTP submissions answered 200/202/422, ${decidedMissing} without a row; ${undecided.length} answered 5xx/network error/other, ${undecided.filter(isPersisted).length} persisted (at most one row each)`,
      };
    }),

    await check('(d) one ledger entry per PROCESSED non-LOSS transaction, none for the rest', async () => {
      const withoutEntry = await scalar(
        orm,
        `select count(*)::int as total from wager_transactions t
          where t.provider_id in (${providers}) and t.status = 'PROCESSED' and t.kind <> 'LOSS'
            and (select count(*) from wallet_ledger_entries e where e.transaction_id = t.id) <> 1`,
        [...ctx.providers],
      );
      const unexpected = await scalar(
        orm,
        `select count(*)::int as total from wallet_ledger_entries e
           join wager_transactions t on t.id = e.transaction_id
          where e.wallet_id in (${wallets}) and (t.status <> 'PROCESSED' or t.kind = 'LOSS')`,
        [...ctx.walletIds],
      );
      return {
        ok: withoutEntry === 0 && unexpected === 0,
        detail: `${withoutEntry} PROCESSED non-LOSS transactions without exactly 1 entry; ${unexpected} entries on non-PROCESSED or LOSS transactions`,
      };
    }),

    await check('(e) no negative balance', async () => {
      const negative = await scalar(
        orm,
        `select count(*)::int as total from wallets where id in (${wallets}) and balance < 0`,
        [...ctx.walletIds],
      );
      return { ok: negative === 0, detail: `${negative} wallets with negative balance among ${ctx.walletIds.length}` };
    }),

    await check('(f) at most one PROCESSED REFUND/ROLLBACK per referenced BET', async () => {
      const repeated = await scalar(
        orm,
        `select count(*)::int as total from (
           select 1 from wager_transactions
            where provider_id in (${providers}) and kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
            group by reference_transaction_id having count(*) > 1
         ) reversed`,
        [...ctx.providers],
      );
      return { ok: repeated === 0, detail: `${repeated} referenced transactions reversed more than once` };
    }),

    await check('(g) balance equals the ledger-rebuilt balance on every wallet', async () => {
      const failures: string[] = [];
      await mapWithLimit(ctx.walletIds, CONSISTENCY_CHECKS_IN_FLIGHT, async (walletId) => {
        try {
          await assertWalletConsistent(orm, walletId);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      });
      return {
        ok: failures.length === 0,
        detail:
          failures.length === 0
            ? `${ctx.walletIds.length} wallets consistent`
            : `${failures.length} inconsistent wallets; first: ${failures.slice(0, MAX_FAILURES_LISTED).join(' | ')}`,
      };
    }),

    await check('(h) POST /wallets/:id/reconciliation reports consistent on every wallet', async () => {
      const failures: string[] = [];
      await mapWithLimit(ctx.walletIds, RECONCILIATION_IN_FLIGHT, async (walletId) => {
        const response = await fetch(`${config.baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
        const body = (await response.json()) as { consistent?: boolean };
        if (response.status !== 200 || body.consistent !== true) {
          failures.push(`${walletId}: HTTP ${response.status}, consistent=${String(body.consistent)}`);
        }
      });
      return {
        ok: failures.length === 0,
        detail:
          failures.length === 0
            ? `${ctx.walletIds.length} wallets reconciled through nginx`
            : `${failures.length} wallets not reconciled; first: ${failures.slice(0, MAX_FAILURES_LISTED).join(' | ')}`,
      };
    }),

    await check('(i) every HTTP replay returned the original decision', async () => ({
      ok: ctx.replayMismatches.length === 0,
      detail: `${ctx.httpReplays} replays sent, ${ctx.replayMismatches.length} mismatches${
        ctx.replayMismatches.length === 0 ? '' : `; first: ${ctx.replayMismatches.slice(0, MAX_FAILURES_LISTED).join(' | ')}`
      }`,
    })),
  ];
}
