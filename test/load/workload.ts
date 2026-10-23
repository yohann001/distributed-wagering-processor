import type { SQSClient } from '@aws-sdk/client-sqs';

import type { SubmitResponse } from '../../src/modules/wagering/presentation/wager-transaction-http.schemas';
import { buildEnvelope, sendEnvelope } from '../support/sqs';
import { LOAD_CURRENCY, type LoadConfig } from './load-config';

/**
 * PRNG mulberry32: pequeno e determinístico, para o mix de operações ser reproduzível com a mesma semente.
 * Não é criptográfico e não serve para nada além de sortear a carga.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) {
    throw new Error('pick from an empty list');
  }
  return item;
}

export function chance(rng: () => number, ratio: number): boolean {
  return rng() < ratio;
}

/** Valores em texto decimal, nunca `number`: o teste não faz conta de dinheiro (CLAUDE.md, "Dinheiro"). */
const BET_AMOUNTS = ['1.00', '2.50', '5.00', '7.25', '10.00', '12.34', '20.00', '25.00'] as const;
const WIN_AMOUNTS = ['2.00', '5.00', '12.50', '30.00', '50.00'] as const;

type FollowUpKind = 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

const FOLLOW_UP_WEIGHTS: ReadonlyArray<readonly [FollowUpKind | null, number]> = [
  ['WIN', 0.35],
  ['LOSS', 0.35],
  ['REFUND', 0.15],
  ['ROLLBACK', 0.1],
  [null, 0.05],
];

const OPEN_WALLETS_IN_FLIGHT = 16;
const GAME_ID = 'game-load';

function pickFollowUp(rng: () => number): FollowUpKind | null {
  let draw = rng();
  for (const [kind, weight] of FOLLOW_UP_WEIGHTS) {
    if (draw < weight) {
      return kind;
    }
    draw -= weight;
  }
  return null;
}

export type Temperature = 'hot' | 'cold';

export interface LoadWallet {
  id: string;
  playerId: string;
  temperature: Temperature;
}

export type SampleKind = 'BET' | FollowUpKind | 'BET_REPLAY';

export interface HttpSample {
  kind: SampleKind;
  temperature: Temperature;
  /** 0 = erro de rede (sem resposta). */
  httpStatus: number;
  status: string | null;
  failureCode: string | null;
  latencyMs: number;
  /** Relógio de parede (ms desde a época). */
  startedAt: number;
  phase: 'warmup' | 'measure';
}

/** Uma por transação distinta (replays ficam de fora): base das invariantes (c) e da latência SQS ponta a ponta. */
export interface SubmissionRecord {
  providerId: string;
  externalTransactionId: string;
  channel: 'http' | 'sqs';
  temperature: Temperature;
  httpStatus: number | null;
  /** Relógio de parede (ms desde a época), comparado depois com os timestamps do banco. */
  sentAt: number;
}

export interface WorkloadResult {
  httpSamples: HttpSample[];
  submissions: SubmissionRecord[];
  /** `externalTransactionId` e o motivo de cada replay HTTP que não devolveu a decisão original. */
  replayMismatches: string[];
  sqsMessagesSent: number;
  sqsReplaysSent: number;
  sqsSendErrors: number;
  rounds: number;
  startedAt: number;
  measureStartedAt: number;
  endedAt: number;
}

export function providersOf(runId: string): string[] {
  return [`load-${runId}-p1`, `load-${runId}-p2`, `load-${runId}-p3`];
}

/** Executa `fn` sobre os itens com no máximo `limit` chamadas em voo, preservando a ordem do resultado. */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Abre as wallets do experimento pelo nginx: as quentes primeiro (poucas, saldo baixo), depois as frias. */
export async function openWallets(config: LoadConfig, runId: string): Promise<LoadWallet[]> {
  const plan = [
    ...Array.from({ length: config.hotWallets }, () => ({
      temperature: 'hot' as const,
      amount: config.hotInitialBalance,
    })),
    ...Array.from({ length: config.coldWallets }, () => ({
      temperature: 'cold' as const,
      amount: config.coldInitialBalance,
    })),
  ];
  return mapWithLimit(plan, OPEN_WALLETS_IN_FLIGHT, async ({ temperature, amount }, index) => {
    const playerId = `load-${runId}-player-${index}`;
    const response = await fetch(`${config.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount, currency: LOAD_CURRENCY } }),
    });
    if (response.status !== 201) {
      throw new Error(`opening wallet ${index} failed with HTTP ${response.status}`);
    }
    const { id } = (await response.json()) as { id: string };
    return { id, playerId, temperature };
  });
}

interface HttpAnswer {
  httpStatus: number;
  transactionId: string | null;
  status: string | null;
  failureCode: string | null;
  idempotentReplay: boolean | null;
  latencyMs: number;
}

function readAnswer(httpStatus: number, body: unknown, latencyMs: number): HttpAnswer {
  const parsed = typeof body === 'object' && body !== null ? (body as Partial<SubmitResponse>) : {};
  return {
    httpStatus,
    transactionId: typeof parsed.transactionId === 'string' ? parsed.transactionId : null,
    status: typeof parsed.status === 'string' ? parsed.status : null,
    failureCode: typeof parsed.failureCode === 'string' ? parsed.failureCode : null,
    idempotentReplay: typeof parsed.idempotentReplay === 'boolean' ? parsed.idempotentReplay : null,
    latencyMs,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Falha de rede vira `httpStatus: 0` (sem resposta); corpo que não é JSON vira corpo ausente. */
async function postTransaction(
  baseUrl: string,
  body: Record<string, unknown>,
  externalTransactionId: string,
  correlationId: string,
): Promise<HttpAnswer> {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `key-${externalTransactionId}`,
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return readAnswer(response.status, parseJson(text), performance.now() - started);
  } catch {
    return readAnswer(0, null, performance.now() - started);
  }
}

export interface WorkloadContext {
  runId: string;
  wallets: LoadWallet[];
  sqs: SQSClient;
  queueUrl: string;
}

interface RoundPlan {
  wallet: LoadWallet;
  providerId: string;
  roundSeq: number;
  channel: 'http' | 'sqs';
  betAmount: string;
  followUp: FollowUpKind | null;
  followAmount: string;
  replay: boolean;
  correlationId: string;
}

/**
 * Laço fechado: `concurrency` usuários virtuais, cada um com a própria semente, repetem rodadas (BET e, em geral,
 * um desfecho) sem tempo de espera até o fim da janela. A rodada em andamento no fim da janela termina.
 */
export async function runWorkload(config: LoadConfig, ctx: WorkloadContext): Promise<WorkloadResult> {
  const hot = ctx.wallets.filter((wallet) => wallet.temperature === 'hot');
  const cold = ctx.wallets.filter((wallet) => wallet.temperature === 'cold');
  const providers = providersOf(ctx.runId);
  const startedAt = Date.now();
  const measureStartedAt = startedAt + config.warmupSeconds * 1000;
  const deadline = measureStartedAt + config.durationSeconds * 1000;

  const result: WorkloadResult = {
    httpSamples: [],
    submissions: [],
    replayMismatches: [],
    sqsMessagesSent: 0,
    sqsReplaysSent: 0,
    sqsSendErrors: 0,
    rounds: 0,
    startedAt,
    measureStartedAt,
    endedAt: startedAt,
  };
  let roundCounter = 0;

  function planRound(rng: () => number): RoundPlan {
    roundCounter += 1;
    const roundSeq = roundCounter;
    const useHot = chance(rng, config.hotTrafficRatio);
    return {
      wallet: pick(rng, useHot ? hot : cold),
      providerId: pick(rng, providers),
      roundSeq,
      channel: chance(rng, config.sqsRatio) ? 'sqs' : 'http',
      betAmount: pick(rng, BET_AMOUNTS),
      followUp: pickFollowUp(rng),
      followAmount: pick(rng, WIN_AMOUNTS),
      replay: chance(rng, config.replayRatio),
      correlationId: `load-${ctx.runId}-${roundSeq}`,
    };
  }

  function externalIdOf(plan: RoundPlan, kind: 'BET' | FollowUpKind): string {
    return `load-${ctx.runId}-${plan.roundSeq}-${kind.toLowerCase()}`;
  }

  function bodyOf(plan: RoundPlan, kind: 'BET' | FollowUpKind): Record<string, unknown> {
    // LOSS, REFUND e ROLLBACK carregam o valor da aposta (REFUND e ROLLBACK exigem valor igual ao da referência).
    const amount = kind === 'WIN' ? plan.followAmount : plan.betAmount;
    return {
      providerId: plan.providerId,
      externalTransactionId: externalIdOf(plan, kind),
      playerId: plan.wallet.playerId,
      walletId: plan.wallet.id,
      roundId: `round-${plan.roundSeq}`,
      gameId: GAME_ID,
      kind,
      money: { amount, currency: LOAD_CURRENCY },
      ...(kind !== 'BET' && { referenceExternalTransactionId: externalIdOf(plan, 'BET') }),
    };
  }

  function record(plan: RoundPlan, kind: SampleKind, answer: HttpAnswer, sentAt: number): void {
    result.httpSamples.push({
      kind,
      temperature: plan.wallet.temperature,
      httpStatus: answer.httpStatus,
      status: answer.status,
      failureCode: answer.failureCode,
      latencyMs: answer.latencyMs,
      startedAt: sentAt,
      phase: sentAt >= measureStartedAt ? 'measure' : 'warmup',
    });
  }

  async function submitHttp(plan: RoundPlan, kind: 'BET' | FollowUpKind): Promise<HttpAnswer> {
    const sentAt = Date.now();
    const answer = await postTransaction(
      config.baseUrl,
      bodyOf(plan, kind),
      externalIdOf(plan, kind),
      plan.correlationId,
    );
    record(plan, kind, answer, sentAt);
    result.submissions.push({
      providerId: plan.providerId,
      externalTransactionId: externalIdOf(plan, kind),
      channel: 'http',
      temperature: plan.wallet.temperature,
      httpStatus: answer.httpStatus,
      sentAt,
    });
    return answer;
  }

  async function replayHttpBet(plan: RoundPlan, original: HttpAnswer): Promise<void> {
    const sentAt = Date.now();
    const replay = await postTransaction(
      config.baseUrl,
      bodyOf(plan, 'BET'),
      externalIdOf(plan, 'BET'),
      plan.correlationId,
    );
    record(plan, 'BET_REPLAY', replay, sentAt);
    if (![200, 202, 422].includes(original.httpStatus)) {
      return;
    }
    const externalId = externalIdOf(plan, 'BET');
    if (replay.httpStatus !== original.httpStatus) {
      result.replayMismatches.push(`${externalId}: HTTP ${replay.httpStatus} instead of ${original.httpStatus}`);
    } else if (replay.transactionId !== original.transactionId) {
      result.replayMismatches.push(`${externalId}: different transactionId`);
    } else if (replay.idempotentReplay !== true) {
      result.replayMismatches.push(`${externalId}: idempotentReplay is not true`);
    }
  }

  async function sendSqs(plan: RoundPlan, envelope: Record<string, unknown>): Promise<boolean> {
    try {
      await sendEnvelope(ctx.sqs, ctx.queueUrl, envelope, {
        groupId: plan.wallet.id,
        correlationId: plan.correlationId,
      });
      return true;
    } catch {
      result.sqsSendErrors += 1;
      return false;
    }
  }

  async function submitSqs(plan: RoundPlan, kind: 'BET' | FollowUpKind): Promise<Record<string, unknown> | null> {
    const envelope = buildEnvelope({ data: bodyOf(plan, kind) });
    const sentAt = Date.now();
    if (!(await sendSqs(plan, envelope))) {
      return null;
    }
    result.sqsMessagesSent += 1;
    result.submissions.push({
      providerId: plan.providerId,
      externalTransactionId: externalIdOf(plan, kind),
      channel: 'sqs',
      temperature: plan.wallet.temperature,
      httpStatus: null,
      sentAt,
    });
    return envelope;
  }

  async function runHttpRound(plan: RoundPlan): Promise<void> {
    const bet = await submitHttp(plan, 'BET');
    if (plan.replay) {
      await replayHttpBet(plan, bet);
    }
    if (plan.followUp !== null && bet.status === 'PROCESSED') {
      await submitHttp(plan, plan.followUp);
    }
  }

  async function runSqsRound(plan: RoundPlan): Promise<void> {
    const betEnvelope = await submitSqs(plan, 'BET');
    if (betEnvelope === null) {
      // Sem a aposta na fila, um desfecho ficaria esperando uma referência que nunca chega.
      return;
    }
    if (plan.replay && (await sendSqs(plan, betEnvelope))) {
      result.sqsReplaysSent += 1;
    }
    if (plan.followUp !== null) {
      await submitSqs(plan, plan.followUp);
    }
  }

  async function virtualUser(index: number): Promise<void> {
    const rng = createRng(config.seed + index);
    while (Date.now() < deadline) {
      const plan = planRound(rng);
      if (plan.channel === 'http') {
        await runHttpRound(plan);
      } else {
        await runSqsRound(plan);
      }
      result.rounds += 1;
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, (_, index) => virtualUser(index)));
  result.endedAt = Date.now();
  return result;
}
