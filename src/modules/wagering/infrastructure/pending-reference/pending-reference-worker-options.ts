import type { Env } from '../../../../config/env';

export interface PendingReferenceWorkerOptions {
  enabled: boolean;
  /** Transações reavaliadas por ciclo, cada uma na própria transação SQL. */
  batchSize: number;
  /** Pausa entre ciclos quando o lote veio incompleto, isto é, não há backlog vencido para drenar. */
  pollIntervalMs: number;
  /** Reavaliações que perdem a referência antes de a transação virar `REJECTED`. */
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export const PENDING_REFERENCE_WORKER_OPTIONS = Symbol('PENDING_REFERENCE_WORKER_OPTIONS');

export type PendingReferenceWorkerEnv = Pick<
  Env,
  | 'PENDING_REFERENCE_WORKER_ENABLED'
  | 'PENDING_REFERENCE_WORKER_BATCH_SIZE'
  | 'PENDING_REFERENCE_WORKER_POLL_INTERVAL_MS'
  | 'PENDING_REFERENCE_MAX_ATTEMPTS'
  | 'PENDING_REFERENCE_RETRY_BASE_DELAY_MS'
  | 'PENDING_REFERENCE_RETRY_MAX_DELAY_MS'
>;

export function pendingReferenceWorkerOptionsFromEnv(env: PendingReferenceWorkerEnv): PendingReferenceWorkerOptions {
  return {
    enabled: env.PENDING_REFERENCE_WORKER_ENABLED,
    batchSize: env.PENDING_REFERENCE_WORKER_BATCH_SIZE,
    pollIntervalMs: env.PENDING_REFERENCE_WORKER_POLL_INTERVAL_MS,
    maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
    retryBaseDelayMs: env.PENDING_REFERENCE_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: env.PENDING_REFERENCE_RETRY_MAX_DELAY_MS,
  };
}
