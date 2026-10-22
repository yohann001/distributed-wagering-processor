import type { Env } from '../../../../config/env';

export interface OutboxPublisherOptions {
  enabled: boolean;
  queueUrl: string;
  /** Eventos reivindicados por ciclo (até 10, o limite do `SendMessageBatch`). */
  batchSize: number;
  /** Pausa entre ciclos quando o lote veio incompleto, isto é, não há backlog para drenar. */
  pollIntervalMs: number;
  /** Teto do envio ao SQS, durante o qual a transação do claim segura uma conexão e os locks das linhas. */
  publishTimeoutMs: number;
}

export const OUTBOX_PUBLISHER_OPTIONS = Symbol('OUTBOX_PUBLISHER_OPTIONS');

export type OutboxPublisherEnv = Pick<
  Env,
  | 'SQS_EVENTS_QUEUE_URL'
  | 'OUTBOX_PUBLISHER_ENABLED'
  | 'OUTBOX_PUBLISHER_BATCH_SIZE'
  | 'OUTBOX_PUBLISHER_POLL_INTERVAL_MS'
  | 'OUTBOX_PUBLISH_TIMEOUT_MS'
>;

export function outboxPublisherOptionsFromEnv(env: OutboxPublisherEnv): OutboxPublisherOptions {
  return {
    enabled: env.OUTBOX_PUBLISHER_ENABLED,
    queueUrl: env.SQS_EVENTS_QUEUE_URL,
    batchSize: env.OUTBOX_PUBLISHER_BATCH_SIZE,
    pollIntervalMs: env.OUTBOX_PUBLISHER_POLL_INTERVAL_MS,
    publishTimeoutMs: env.OUTBOX_PUBLISH_TIMEOUT_MS,
  };
}
