import os from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import { loadEnv } from '../../src/config/env';
import { buildMikroOrmConfig } from '../../src/infrastructure/database/mikro-orm.config';
import { createTestSqsClient, testQueueUrls, waitFor } from '../support/sqs';
import {
  outboxLag,
  outcomeBreakdown,
  postgresVersion,
  readDeadlocks,
  sqsEndToEndLatency,
  startBacklogSampler,
  verifyInvariants,
  waitForDrain,
  type BacklogSample,
} from './invariants';
import { loadLoadConfig, type LoadConfig } from './load-config';
import { histogramDelta, scrapeReplicas, sumDelta, type ReplicaSnapshot } from './replica-metrics';
import {
  buildMethodology,
  writeReport,
  type ConflictRow,
  type DuplicateRow,
  type EnvironmentInfo,
  type ErrorInfo,
  type LoadReport,
  type ReplicaRow,
  type ServerProcessing,
  type SqsQueueInfo,
} from './report';
import { histogramPercentile, summarize } from './stats';
import { openWallets, providersOf, runWorkload, type HttpSample, type WorkloadResult } from './workload';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const READY_TIMEOUT_MS = 60000;
// O LocalStack mantém vivo o long poll das réplicas paradas (até 20 s, o teto do SQS) e entrega a próxima mensagem da
// fila compartilhada a essa conexão morta. Sem esperar, o primeiro teste que usa a fila logo depois perde a mensagem.
const SQS_MAX_LONG_POLL_MS = 20000;
const SQS_LONG_POLL_MARGIN_MS = 1000;
const LOCK_CONFLICT_REASONS = ['deadlock', 'serialization_failure', 'lock_timeout', 'version_conflict'];
const LOCK_CONFLICT_OUTCOMES = ['retried', 'exhausted'];
const STATUSES = ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE'];
const SOURCES = ['http', 'sqs', 'pending_reference_worker'];
const SQS_OUTCOMES = ['processed', 'replayed', 'retried', 'dead_lettered', 'released'];
const PENDING_REFERENCE_OUTCOMES = ['processed', 'rejected', 'retried', 'expired'];
const SAMPLE_KINDS = ['BET', 'BET_REPLAY', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];

async function run(cmd: string[], label: string): Promise<void> {
  const child = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit', cwd: REPO_ROOT });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${label} failed (exit ${code})`);
  }
}

/** Versão do servidor Docker; `unknown` quando o docker não está disponível (por exemplo com `LOAD_SKIP_COMPOSE`). */
async function dockerServerVersion(): Promise<string> {
  try {
    const child = Bun.spawn(['docker', 'version', '--format', '{{.Server.Version}}'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 && output.trim() !== '' ? output.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `${stamp}-${Bun.randomUUIDv7().slice(-6)}`;
}

async function describeEnvironment(
  orm: MikroORM,
  replicas: string[],
): Promise<EnvironmentInfo> {
  const cpus = os.cpus();
  return {
    date: new Date().toISOString(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: `${cpus[0]?.model ?? 'unknown'} x ${cpus.length}`,
    memory: `${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`,
    bun: Bun.version,
    docker: await dockerServerVersion(),
    postgres: await postgresVersion(orm),
    replicas,
  };
}

function classifyErrors(samples: HttpSample[]): ErrorInfo {
  const errors: ErrorInfo = {
    httpRequests: samples.length,
    accepted: 0,
    businessRejections: 0,
    clientErrors: 0,
    serverErrors: 0,
    unavailable503: 0,
    networkErrors: 0,
    errorRate: 0,
    byStatus: {},
  };
  for (const { httpStatus } of samples) {
    const key = httpStatus === 0 ? 'network' : String(httpStatus);
    errors.byStatus[key] = (errors.byStatus[key] ?? 0) + 1;
    if (httpStatus === 0) {
      errors.networkErrors += 1;
    } else if (httpStatus === 200 || httpStatus === 202) {
      errors.accepted += 1;
    } else if (httpStatus === 422) {
      errors.businessRejections += 1;
    } else if (httpStatus >= 500) {
      errors.serverErrors += 1;
      if (httpStatus === 503) {
        errors.unavailable503 += 1;
      }
    } else {
      errors.clientErrors += 1;
    }
  }
  errors.errorRate =
    samples.length === 0 ? 0 : (errors.clientErrors + errors.serverErrors + errors.networkErrors) / samples.length;
  return errors;
}

function latencyBy(samples: HttpSample[], key: (sample: HttpSample) => string, keys: string[]) {
  return Object.fromEntries(
    keys.map((name) => [
      name,
      summarize(samples.filter((sample) => key(sample) === name).map((sample) => sample.latencyMs)),
    ]),
  );
}

/** Por label: o delta somado das réplicas, só dos valores com ocorrência. */
function totalsByLabel(
  before: ReplicaSnapshot,
  after: ReplicaSnapshot,
  name: string,
  label: string,
  values: string[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const value of values) {
    const { total } = sumDelta(before, after, name, { [label]: value });
    if (total > 0) {
      totals[value] = total;
    }
  }
  return totals;
}

function serverProcessing(before: ReplicaSnapshot, after: ReplicaSnapshot, channel: 'http' | 'sqs'): ServerProcessing {
  const buckets = histogramDelta(before, after, 'wager_transaction_processing_seconds', { channel });
  const toMs = (seconds: number | null): number | null => (seconds === null ? null : seconds * 1000);
  return {
    count: buckets.at(-1)?.count ?? 0,
    p50: toMs(histogramPercentile(buckets, 50)),
    p95: toMs(histogramPercentile(buckets, 95)),
    p99: toMs(histogramPercentile(buckets, 99)),
  };
}

function lockConflictRows(before: ReplicaSnapshot, after: ReplicaSnapshot): ConflictRow[] {
  return LOCK_CONFLICT_REASONS.flatMap((reason) =>
    LOCK_CONFLICT_OUTCOMES.map((outcome) => ({
      reason,
      outcome,
      total: sumDelta(before, after, 'lock_conflicts_total', { reason, outcome }).total,
    })),
  );
}

function duplicateRows(before: ReplicaSnapshot, after: ReplicaSnapshot): DuplicateRow[] {
  return ['http', 'sqs'].flatMap((channel) =>
    ['idempotency_key', 'inbox'].map((detectedBy) => ({
      channel,
      detectedBy,
      total: sumDelta(before, after, 'wager_transaction_duplicates_total', { channel, detected_by: detectedBy }).total,
    })),
  ).filter((row) => row.total > 0);
}

function replicaRows(before: ReplicaSnapshot, after: ReplicaSnapshot): ReplicaRow[] {
  const decisions = sumDelta(before, after, 'wager_transactions_total').perInstance;
  const duplicates = sumDelta(before, after, 'wager_transaction_duplicates_total').perInstance;
  const published = sumDelta(before, after, 'outbox_messages_published_total').perInstance;
  const retried = sumDelta(before, after, 'lock_conflicts_total', { outcome: 'retried' }).perInstance;
  const exhausted = sumDelta(before, after, 'lock_conflicts_total', { outcome: 'exhausted' }).perInstance;
  return [...after.keys()].sort().map((instanceId) => ({
    instanceId,
    decisions: decisions[instanceId] ?? 0,
    duplicates: duplicates[instanceId] ?? 0,
    published: published[instanceId] ?? 0,
    conflictsRetried: retried[instanceId] ?? 0,
    conflictsExhausted: exhausted[instanceId] ?? 0,
  }));
}

function resetsOf(before: ReplicaSnapshot, after: ReplicaSnapshot): string[] {
  const names = [
    'wager_transactions_total',
    'wager_transaction_duplicates_total',
    'lock_conflicts_total',
    'outbox_messages_published_total',
    'sqs_consumer_messages_total',
  ];
  return [...new Set(names.flatMap((name) => sumDelta(before, after, name).resets))];
}

function sqsBetSentInWindow(workload: WorkloadResult): number {
  return workload.submissions.filter(
    (submission) =>
      submission.channel === 'sqs' &&
      submission.externalTransactionId.endsWith('-bet') &&
      submission.sentAt >= workload.measureStartedAt,
  ).length;
}

function sqsQueueInfo(timeline: BacklogSample[], loadEndedAt: number): SqsQueueInfo {
  const valid = timeline.filter((sample) => sample.sqsVisible >= 0 && sample.sqsInFlight >= 0);
  const atEnd = valid.find((sample) => sample.at >= loadEndedAt);
  return {
    maxVisible: Math.max(0, ...valid.map((sample) => sample.sqsVisible)),
    maxInFlight: Math.max(0, ...valid.map((sample) => sample.sqsInFlight)),
    visibleAtLoadEnd: atEnd?.sqsVisible ?? null,
    inFlightAtLoadEnd: atEnd?.sqsInFlight ?? null,
  };
}

function printSummary(report: LoadReport, paths: { markdownPath: string; jsonPath: string }): void {
  const { throughput, httpLatency, errors, conflicts, outbox, sqsLatency } = report;
  const conflictsByOutcome = (outcome: string): number =>
    conflicts.lockConflicts.filter((row) => row.outcome === outcome).reduce((total, row) => total + row.total, 0);
  const passed = report.invariants.filter((invariant) => invariant.ok).length;
  const ms = (value: number | null): string => (value === null ? '-' : value.toFixed(1));
  console.log(`report: ${paths.markdownPath}`);
  console.log(`report (json): ${paths.jsonPath}`);
  console.log(
    `http: ${throughput.httpRequestsPerSecond.toFixed(1)} req/s, p50/p95/p99 ${ms(httpLatency.overall.p50)}/${ms(httpLatency.overall.p95)}/${ms(httpLatency.overall.p99)} ms, error rate ${(errors.errorRate * 100).toFixed(2)}%`,
  );
  const sqsSummary = (summary: { p50: number | null; p95: number | null }): string =>
    `${ms(summary.p50)}/${ms(summary.p95)}`;
  console.log(
    `sqs end-to-end p50/p95: ${sqsSummary(sqsLatency.overall)} ms (hot ${sqsSummary(sqsLatency.byTemperature.hot)}, cold ${sqsSummary(sqsLatency.byTemperature.cold)})`,
  );
  console.log(
    `lock conflicts: ${conflictsByOutcome('retried')} retried, ${conflictsByOutcome('exhausted')} exhausted; outbox lag p95 ${outbox.lag.p95 === null ? '-' : outbox.lag.p95.toFixed(3)} s`,
  );
  console.log(`drain: ${report.drain.ok ? 'ok' : 'NOT COMPLETED'}; invariants: ${passed}/${report.invariants.length} PASS`);
}

async function execute(config: LoadConfig, handles: { orm?: MikroORM; sqs?: SQSClient }): Promise<boolean> {
  const runId = newRunId();
  if (!config.skipCompose) {
    await run(['docker', 'compose', 'up', '-d', '--wait', 'postgres', 'localstack'], 'infra up');
  }
  await run(['bun', 'run', 'migration:up'], 'migration:up');
  if (!config.skipCompose) {
    await run(['docker', 'compose', '--profile', 'app', 'up', '-d', '--build', '--wait'], 'app up');
  }
  await waitFor(
    async () => ((await fetch(`${config.baseUrl}/health/ready`).catch(() => null))?.status === 200 ? true : null),
    READY_TIMEOUT_MS,
    500,
  );

  const orm = await MikroORM.init(buildMikroOrmConfig({ ...loadEnv(), DATABASE_POOL_MAX: 4 }));
  handles.orm = orm;
  const sqs = createTestSqsClient();
  handles.sqs = sqs;
  const queueUrl = testQueueUrls().wager;

  const wallets = await openWallets(config, runId);
  const walletIds = wallets.map((wallet) => wallet.id);
  const providers = providersOf(runId);
  const before = await scrapeReplicas(config.baseUrl, config.expectedReplicas);
  const environment = await describeEnvironment(orm, [...before.keys()].sort());
  const deadlocksBefore = await readDeadlocks(orm);
  const sampler = startBacklogSampler(orm, walletIds, sqs, queueUrl);

  console.log(`run ${runId}: ${config.durationSeconds}s measured (+${config.warmupSeconds}s warm-up), ${config.concurrency} virtual users`);
  const workload = await runWorkload(config, { runId, wallets, sqs, queueUrl });
  const drain = await waitForDrain(orm, config, { walletIds, submissions: workload.submissions, sqs, queueUrl });
  const timeline = await sampler.stop();

  const after = await scrapeReplicas(config.baseUrl, config.expectedReplicas);
  const deadlocksAfter = await readDeadlocks(orm);

  const measured = workload.httpSamples.filter((sample) => sample.phase === 'measure');
  const answered = measured.filter((sample) => sample.httpStatus > 0);
  const measuredSeconds = (workload.endedAt - workload.measureStartedAt) / 1000;
  const httpBets = measured.filter((sample) => sample.kind === 'BET').length;
  const windowRounds = httpBets + sqsBetSentInWindow(workload);
  const errors = classifyErrors(measured);
  const secondsSinceLoad = (instant: number | null): number | null =>
    instant === null ? null : Math.max(0, (instant - workload.endedAt) / 1000);

  const invariants = await verifyInvariants(orm, config, {
    walletIds,
    providers,
    submissions: workload.submissions,
    replayMismatches: workload.replayMismatches,
    httpReplays: workload.httpSamples.filter((sample) => sample.kind === 'BET_REPLAY').length,
  });
  const drainOk = drain.sqsDrainedAt !== null && drain.outboxDrainedAt !== null;

  const report: LoadReport = {
    runId,
    generatedAt: new Date().toISOString(),
    environment,
    config,
    methodology: buildMethodology(config),
    throughput: {
      measuredSeconds,
      httpRequests: measured.length,
      httpRequestsPerSecond: measured.length / measuredSeconds,
      rounds: windowRounds,
      roundsPerSecond: windowRounds / measuredSeconds,
      totalRounds: workload.rounds,
      sqsMessagesSent: workload.sqsMessagesSent,
      sqsReplaysSent: workload.sqsReplaysSent,
      sqsSendErrors: workload.sqsSendErrors,
      sqsDrainSeconds: secondsSinceLoad(drain.sqsDrainedAt),
      outboxDrainSeconds: secondsSinceLoad(drain.outboxDrainedAt),
      sqsQueue: sqsQueueInfo(timeline, workload.endedAt),
    },
    httpLatency: {
      byKind: latencyBy(answered, (sample) => sample.kind, SAMPLE_KINDS),
      byTemperature: latencyBy(answered, (sample) => sample.temperature, ['hot', 'cold']),
      overall: summarize(answered.map((sample) => sample.latencyMs)),
    },
    sqsLatency: await sqsEndToEndLatency(orm, workload.submissions, workload.startedAt),
    serverProcessing: {
      http: serverProcessing(before, after, 'http'),
      sqs: serverProcessing(before, after, 'sqs'),
    },
    outcomes: await outcomeBreakdown(orm, providers),
    errors,
    conflicts: {
      lockConflicts: lockConflictRows(before, after),
      deadlocksDelta: deadlocksAfter - deadlocksBefore,
      http503: errors.unavailable503,
      duplicates: duplicateRows(before, after),
      sqsConsumerOutcomes: totalsByLabel(before, after, 'sqs_consumer_messages_total', 'outcome', SQS_OUTCOMES),
      pendingReferenceReprocessed: totalsByLabel(
        before,
        after,
        'pending_reference_reprocessed_total',
        'outcome',
        PENDING_REFERENCE_OUTCOMES,
      ),
      counterResets: resetsOf(before, after),
    },
    outbox: {
      lag: await outboxLag(orm, walletIds),
      maxPending: Math.max(0, ...timeline.map((sample) => sample.pending)),
      maxOldestPendingAgeSeconds: Math.max(0, ...timeline.map((sample) => sample.oldestAgeSeconds)),
      drainSeconds: secondsSinceLoad(drain.outboxDrainedAt),
      publishRetries: sumDelta(before, after, 'outbox_publish_retries_total').total,
      publishedPerReplica: sumDelta(before, after, 'outbox_messages_published_total').perInstance,
    },
    decisions: {
      total: sumDelta(before, after, 'wager_transactions_total').total,
      byStatus: totalsByLabel(before, after, 'wager_transactions_total', 'status', STATUSES),
      bySource: totalsByLabel(before, after, 'wager_transactions_total', 'source', SOURCES),
    },
    replicas: replicaRows(before, after),
    drain: { ...drain, ok: drainOk },
    invariants,
    backlogTimeline: timeline,
  };

  const paths = await writeReport(isAbsolute(config.reportDir) ? config.reportDir : resolve(REPO_ROOT, config.reportDir), report);
  printSummary(report, paths);
  return drainOk && invariants.every((invariant) => invariant.ok);
}

const handles: { orm?: MikroORM; sqs?: SQSClient } = {};
let config: LoadConfig | undefined;
let success = false;
try {
  config = loadLoadConfig();
  success = await execute(config, handles);
} catch (error) {
  console.error(`load test failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await handles.orm?.close(true);
  handles.sqs?.destroy();
  if (config !== undefined && !config.skipCompose && !config.keepApp) {
    try {
      await run(['docker', 'compose', '--profile', 'app', 'stop', 'app', 'nginx'], 'app stop');
      await Bun.sleep(SQS_MAX_LONG_POLL_MS + SQS_LONG_POLL_MARGIN_MS);
      console.log('app and nginx stopped (Postgres and LocalStack stay up); set LOAD_KEEP_APP=true to keep the app running after the run');
    } catch (error) {
      console.error(`teardown failed: ${error instanceof Error ? error.message : String(error)}`);
      success = false;
    }
  }
}
process.exit(success ? 0 : 1);
