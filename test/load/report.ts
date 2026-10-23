import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { BacklogSample, DrainResult, InvariantResult, OutboxLag, OutcomeRow, SqsLatency } from './invariants';
import type { LoadConfig } from './load-config';
import type { LatencySummary } from './stats';

export interface EnvironmentInfo {
  date: string;
  os: string;
  cpu: string;
  memory: string;
  bun: string;
  docker: string;
  postgres: string;
  /** `instance_id` de cada réplica vista atrás do nginx. */
  replicas: string[];
}

/** Profundidade da fila de transações amostrada a cada 1 s durante a carga (números aproximados do SQS). */
export interface SqsQueueInfo {
  maxVisible: number;
  maxInFlight: number;
  /** Primeira amostra em ou depois do fim da carga; `null` se nenhuma amostra válida. */
  visibleAtLoadEnd: number | null;
  inFlightAtLoadEnd: number | null;
}

export interface ThroughputInfo {
  measuredSeconds: number;
  httpRequests: number;
  httpRequestsPerSecond: number;
  rounds: number;
  roundsPerSecond: number;
  totalRounds: number;
  sqsMessagesSent: number;
  sqsReplaysSent: number;
  sqsSendErrors: number;
  sqsDrainSeconds: number | null;
  outboxDrainSeconds: number | null;
  sqsQueue: SqsQueueInfo;
}

export interface ServerProcessing {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface ErrorInfo {
  httpRequests: number;
  /** Requisições com 200/202 (decisão aceita). */
  accepted: number;
  /** 422 é desfecho de negócio, não erro. */
  businessRejections: number;
  clientErrors: number;
  serverErrors: number;
  unavailable503: number;
  networkErrors: number;
  /** (erros de cliente + 5xx + rede) / requisições. */
  errorRate: number;
  byStatus: Record<string, number>;
}

export interface ConflictRow {
  reason: string;
  outcome: string;
  total: number;
}

export interface DuplicateRow {
  channel: string;
  detectedBy: string;
  total: number;
}

export interface ConflictInfo {
  lockConflicts: ConflictRow[];
  deadlocksDelta: number;
  http503: number;
  duplicates: DuplicateRow[];
  sqsConsumerOutcomes: Record<string, number>;
  pendingReferenceReprocessed: Record<string, number>;
  /** Réplicas cujos contadores diminuíram entre as leituras (reinício). */
  counterResets: string[];
}

export interface OutboxInfo {
  lag: OutboxLag;
  maxPending: number;
  maxOldestPendingAgeSeconds: number;
  drainSeconds: number | null;
  publishRetries: number;
  publishedPerReplica: Record<string, number>;
}

export interface DecisionInfo {
  total: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
}

export interface ReplicaRow {
  instanceId: string;
  decisions: number;
  duplicates: number;
  published: number;
  conflictsRetried: number;
  conflictsExhausted: number;
}

export interface LoadReport {
  runId: string;
  generatedAt: string;
  environment: EnvironmentInfo;
  config: LoadConfig;
  methodology: string[];
  throughput: ThroughputInfo;
  httpLatency: {
    byKind: Record<string, LatencySummary>;
    byTemperature: Record<string, LatencySummary>;
    overall: LatencySummary;
  };
  sqsLatency: SqsLatency;
  serverProcessing: Record<'http' | 'sqs', ServerProcessing>;
  outcomes: OutcomeRow[];
  errors: ErrorInfo;
  conflicts: ConflictInfo;
  outbox: OutboxInfo;
  decisions: DecisionInfo;
  replicas: ReplicaRow[];
  drain: DrainResult & { ok: boolean };
  invariants: InvariantResult[];
  backlogTimeline: BacklogSample[];
}

/** Texto fixo da metodologia, montado a partir da configuração da execução. */
export function buildMethodology(config: LoadConfig): string[] {
  return [
    `Laço fechado: ${config.concurrency} usuários virtuais, sem tempo de espera entre rodadas; cada rodada é uma BET e, na maioria, um desfecho (WIN, LOSS, REFUND ou ROLLBACK) que referencia a BET.`,
    `Mix sorteado com semente fixa (${config.seed}, uma por usuário virtual): ${Math.round(config.sqsRatio * 100)}% das rodadas por SQS e o resto por HTTP, ${Math.round(config.replayRatio * 100)}% com reenvio idempotente da BET (HTTP: mesma key e mesmo corpo; SQS: mesmo messageId com novo id de deduplicação).`,
    `${config.hotWallets} wallets quentes (saldo inicial baixo, ${Math.round(config.hotTrafficRatio * 100)}% do tráfego) e ${config.coldWallets} frias; as wallets são abertas pelo nginx no início e o banco não é zerado.`,
    `Janela: ${config.warmupSeconds} s de aquecimento (fora de throughput e latência, mas dentro das invariantes) e ${config.durationSeconds} s medidos; a rodada em andamento no fim da janela termina e conta.`,
    'Latência HTTP medida no cliente, incluindo o nginx e a espera pelo lock da wallet; erros de rede (sem resposta) ficam fora da latência e entram na taxa de erro. Latência SQS ponta a ponta = `processed_at` (ou `created_at`) da transação no banco menos o instante do envio no cliente; relógios do host e das réplicas.',
    'Latência de processamento no servidor estimada pelos buckets do histograma `wager_transaction_processing_seconds` (interpolação linear: a resolução é a dos buckets). Lag da outbox calculado exato no banco (`published_at` menos `occurred_at`).',
    'A profundidade da fila de transações (mensagens visíveis e em voo) é amostrada a cada 1 s com `GetQueueAttributes`; os números do SQS são aproximados.',
    'Contadores Prometheus são deltas entre duas leituras de `/metrics` de cada réplica (uma antes da carga, outra depois da drenagem). As métricas são globais por réplica: qualquer outro tráfego na janela entra nos números.',
    'Depois da carga o script espera a drenagem (toda mensagem SQS virou transação, nenhuma PENDING_REFERENCE sobra, a outbox do experimento foi publicada) e verifica as invariantes no banco; só elas e a drenagem decidem o código de saída, nunca latência ou taxa de erro.',
  ];
}

function fmt(value: number | null, digits = 1): string {
  return value === null ? '-' : value.toFixed(digits);
}

function table(headers: string[], body: (string | number)[][]): string {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.map((cell) => String(cell).replaceAll('|', '\\|')).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function latencyRow(label: string, summary: LatencySummary): (string | number)[] {
  return [label, summary.count, fmt(summary.p50), fmt(summary.p95), fmt(summary.p99), fmt(summary.max), fmt(summary.mean)];
}

const LATENCY_HEADERS = ['', 'Amostras', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'max (ms)', 'média (ms)'];

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function listOf(values: Record<string, number>): string {
  const entries = Object.entries(values);
  return entries.length === 0 ? '-' : entries.map(([key, total]) => `${key}=${total}`).join(', ');
}

function sumOf(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

export function renderMarkdown(report: LoadReport): string {
  const { environment, config, throughput, httpLatency, errors, conflicts, outbox, drain } = report;
  const passed = report.invariants.filter((invariant) => invariant.ok).length;
  const sections: string[] = [];

  sections.push(`# Relatório de carga ${report.runId}\n\nGerado em ${report.generatedAt}.`);

  sections.push(
    [
      '## Ambiente',
      bullets([
        `Data: ${environment.date}`,
        `Sistema: ${environment.os}`,
        `CPU: ${environment.cpu}`,
        `Memória: ${environment.memory}`,
        `Bun (gerador de carga): ${environment.bun}`,
        `Docker (servidor): ${environment.docker}`,
        `PostgreSQL: ${environment.postgres}`,
        `Réplicas atrás do nginx (${environment.replicas.length}): ${environment.replicas.join(', ')}`,
      ]),
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Configuração',
      table(
        ['Parâmetro', 'Valor'],
        [
          ['LOAD_BASE_URL', config.baseUrl],
          ['LOAD_DURATION_SECONDS', config.durationSeconds],
          ['LOAD_WARMUP_SECONDS', config.warmupSeconds],
          ['LOAD_CONCURRENCY', config.concurrency],
          ['LOAD_HOT_WALLETS', config.hotWallets],
          ['LOAD_HOT_TRAFFIC_RATIO', config.hotTrafficRatio],
          ['LOAD_HOT_INITIAL_BALANCE', config.hotInitialBalance],
          ['LOAD_COLD_WALLETS', config.coldWallets],
          ['LOAD_COLD_INITIAL_BALANCE', config.coldInitialBalance],
          ['LOAD_SQS_RATIO', config.sqsRatio],
          ['LOAD_REPLAY_RATIO', config.replayRatio],
          ['LOAD_SEED', config.seed],
          ['LOAD_EXPECTED_REPLICAS', config.expectedReplicas],
          ['LOAD_SKIP_COMPOSE', String(config.skipCompose)],
          ['LOAD_KEEP_APP', String(config.keepApp)],
          ['LOAD_DRAIN_TIMEOUT_SECONDS', config.drainTimeoutSeconds],
          ['LOAD_REPORT_DIR', config.reportDir],
        ],
      ),
    ].join('\n\n'),
  );

  sections.push(['## Metodologia', bullets(report.methodology)].join('\n\n'));

  sections.push(
    [
      '## Throughput',
      table(
        ['Métrica', 'Valor'],
        [
          ['Janela medida (s)', fmt(throughput.measuredSeconds, 1)],
          ['Requisições HTTP na janela', throughput.httpRequests],
          ['Requisições HTTP por segundo', fmt(throughput.httpRequestsPerSecond, 1)],
          ['Rodadas na janela', throughput.rounds],
          ['Rodadas por segundo', fmt(throughput.roundsPerSecond, 1)],
          ['Rodadas totais (com aquecimento)', throughput.totalRounds],
          ['Mensagens SQS enviadas', throughput.sqsMessagesSent],
          ['Reenvios SQS (replay)', throughput.sqsReplaysSent],
          ['Falhas de envio ao SQS', throughput.sqsSendErrors],
          ['Drenagem das mensagens SQS depois da carga (s)', fmt(throughput.sqsDrainSeconds, 1)],
          ['Drenagem da outbox depois da carga (s)', fmt(throughput.outboxDrainSeconds, 1)],
          ['Fila SQS: maior profundidade visível amostrada', throughput.sqsQueue.maxVisible],
          ['Fila SQS: maior profundidade em voo amostrada', throughput.sqsQueue.maxInFlight],
          [
            'Fila SQS: visível / em voo ao fim da carga',
            throughput.sqsQueue.visibleAtLoadEnd === null || throughput.sqsQueue.inFlightAtLoadEnd === null
              ? '-'
              : `${throughput.sqsQueue.visibleAtLoadEnd} / ${throughput.sqsQueue.inFlightAtLoadEnd}`,
          ],
        ],
      ),
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Latência HTTP (cliente)',
      table(LATENCY_HEADERS, [
        latencyRow('Geral', httpLatency.overall),
        ...Object.entries(httpLatency.byKind).map(([kind, summary]) => latencyRow(kind, summary)),
        ...Object.entries(httpLatency.byTemperature).map(([temperature, summary]) =>
          latencyRow(`wallet ${temperature}`, summary),
        ),
      ]),
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Latência SQS ponta a ponta',
      table(LATENCY_HEADERS, [
        latencyRow('SQS (envio até a decisão)', report.sqsLatency.overall),
        latencyRow('wallet hot', report.sqsLatency.byTemperature.hot),
        latencyRow('wallet cold', report.sqsLatency.byTemperature.cold),
      ]),
      'Por janela de envio (10 s, contados do início da carga, aquecimento incluído):',
      table(
        ['Janela de envio', 'Amostras', 'p50 (ms)', 'p95 (ms)', 'max (ms)'],
        report.sqsLatency.bySendWindow.map((window) => [
          `${window.fromSecond}-${window.toSecond} s`,
          window.summary.count,
          fmt(window.summary.p50),
          fmt(window.summary.p95),
          fmt(window.summary.max),
        ]),
      ),
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Latência de processamento no servidor',
      table(
        ['Canal', 'Submissões', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)'],
        (['http', 'sqs'] as const).map((channel) => {
          const processing = report.serverProcessing[channel];
          return [channel, processing.count, fmt(processing.p50), fmt(processing.p95), fmt(processing.p99)];
        }),
      ),
      'Estimativa por buckets de histograma, com todos os desfechos juntos (replays incluídos).',
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Desfechos',
      table(
        ['Tipo', 'Status', 'failureCode', 'Transações'],
        report.outcomes.map((row) => [row.kind, row.status, row.failureCode ?? '-', row.count]),
      ),
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Taxa de erro',
      table(
        ['Classe', 'Requisições'],
        [
          ['Aceitas (200/202)', errors.accepted],
          ['422 (desfecho de negócio, não é erro)', errors.businessRejections],
          ['4xx exceto 422', errors.clientErrors],
          ['5xx', errors.serverErrors],
          ['  dos quais 503', errors.unavailable503],
          ['Erro de rede (sem resposta)', errors.networkErrors],
          ['Total', errors.httpRequests],
        ],
      ),
      `Taxa de erro: ${percent(errors.errorRate)} (4xx exceto 422, 5xx e erros de rede, sobre o total de requisições da janela medida).`,
      `Por status HTTP: ${listOf(errors.byStatus)}.`,
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Conflitos de concorrência',
      table(
        ['Motivo', 'Desfecho', 'Ocorrências'],
        conflicts.lockConflicts.map((row) => [row.reason, row.outcome, row.total]),
      ),
      bullets([
        `Deadlocks do Postgres na execução (\`pg_stat_database.deadlocks\`, delta): ${conflicts.deadlocksDelta}`,
        `Respostas 503 ao cliente: ${conflicts.http503}`,
        `Duplicatas detectadas: ${
          conflicts.duplicates.length === 0
            ? '0'
            : conflicts.duplicates.map((row) => `${row.channel}/${row.detectedBy}=${row.total}`).join(', ')
        }`,
        `Desfechos do consumer SQS: ${listOf(conflicts.sqsConsumerOutcomes)}`,
        `Reavaliações de PENDING_REFERENCE: ${listOf(conflicts.pendingReferenceReprocessed)}`,
        `Contadores zerados por reinício de réplica: ${conflicts.counterResets.length === 0 ? 'nenhum' : conflicts.counterResets.join(', ')}`,
      ]),
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Outbox',
      table(
        ['Métrica', 'Valor'],
        [
          ['Eventos publicados do experimento', outbox.lag.count],
          ['Lag p50 (s)', fmt(outbox.lag.p50, 3)],
          ['Lag p95 (s)', fmt(outbox.lag.p95, 3)],
          ['Lag p99 (s)', fmt(outbox.lag.p99, 3)],
          ['Lag máximo (s)', fmt(outbox.lag.max, 3)],
          ['Maior fila pendente amostrada (eventos)', outbox.maxPending],
          ['Maior idade do evento pendente mais antigo (s)', fmt(outbox.maxOldestPendingAgeSeconds, 1)],
          ['Drenagem depois da carga (s)', fmt(outbox.drainSeconds, 1)],
          ['Retries de publicação', outbox.publishRetries],
          ['Eventos publicados na janela (soma das réplicas)', sumOf(outbox.publishedPerReplica)],
        ],
      ),
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Distribuição por réplica',
      table(
        ['Réplica', 'Decisões', 'Duplicatas', 'Eventos publicados', 'Conflitos retried', 'Conflitos exhausted'],
        report.replicas.map((row) => [
          row.instanceId,
          row.decisions,
          row.duplicates,
          row.published,
          row.conflictsRetried,
          row.conflictsExhausted,
        ]),
      ),
      bullets([
        `Decisões novas na janela (\`wager_transactions_total\`): ${report.decisions.total}`,
        `Por status: ${listOf(report.decisions.byStatus)}`,
        `Por origem: ${listOf(report.decisions.bySource)}`,
      ]),
    ].join('\n\n'),
  );

  sections.push(
    [
      '## Invariantes',
      `Drenagem: ${drain.ok ? 'concluída' : 'NÃO concluída no prazo'} (mensagens SQS sem transação: ${drain.missingSqsTransactions}, PENDING_REFERENCE restantes: ${drain.pendingReferenceLeft}, outbox pendente: ${drain.unpublishedOutbox}, fila SQS visível/em voo: ${drain.queueDepthLeft.visible}/${drain.queueDepthLeft.inFlight}).`,
      `${passed}/${report.invariants.length} PASS.`,
      table(
        ['Invariante', 'Resultado', 'Detalhe'],
        report.invariants.map((invariant) => [invariant.name, invariant.ok ? 'PASS' : 'FAIL', invariant.detail]),
      ),
    ].join('\n\n'),
  );

  return `${sections.join('\n\n')}\n`;
}

/** Grava `load-<runId>.md` e `load-<runId>.json` (JSON com 2 espaços) em `dir`, que é criado se não existir. */
export async function writeReport(
  dir: string,
  report: LoadReport,
): Promise<{ markdownPath: string; jsonPath: string }> {
  await mkdir(dir, { recursive: true });
  const markdownPath = join(dir, `load-${report.runId}.md`);
  const jsonPath = join(dir, `load-${report.runId}.json`);
  await Bun.write(markdownPath, renderMarkdown(report));
  await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  return { markdownPath, jsonPath };
}
