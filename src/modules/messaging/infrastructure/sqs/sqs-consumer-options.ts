import type { Env } from '../../../../config/env';
import { ExponentialBackoff } from '../../../../shared/domain/exponential-backoff';

export interface SqsConsumerOptions {
  enabled: boolean;
  queueUrl: string;
  deadLetterQueueUrl: string;
  waitTimeSeconds: number;
  batchSize: number;
  /** Recebimentos (`ApproximateReceiveCount`) a partir dos quais uma falha transitória vai para a DLQ. */
  maxReceives: number;
  /** Atraso de reentrega após falha transitória, aplicado por `ChangeMessageVisibility`. */
  retryBackoff: ExponentialBackoff;
  shutdownTimeoutMs: number;
}

export const SQS_CONSUMER_OPTIONS = Symbol('SQS_CONSUMER_OPTIONS');

/** Valor persistido em `inbox_messages.consumer_name`: nunca renomear. */
export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions-consumer';

export type SqsConsumerEnv = Pick<
  Env,
  | 'SQS_WAGER_QUEUE_URL'
  | 'SQS_WAGER_DLQ_URL'
  | 'SQS_CONSUMER_ENABLED'
  | 'SQS_CONSUMER_WAIT_TIME_SECONDS'
  | 'SQS_CONSUMER_BATCH_SIZE'
  | 'SQS_CONSUMER_MAX_RECEIVES'
  | 'SQS_CONSUMER_RETRY_BASE_DELAY_MS'
  | 'SQS_CONSUMER_RETRY_MAX_DELAY_MS'
  | 'SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS'
>;

export function sqsConsumerOptionsFromEnv(env: SqsConsumerEnv): SqsConsumerOptions {
  return {
    enabled: env.SQS_CONSUMER_ENABLED,
    queueUrl: env.SQS_WAGER_QUEUE_URL,
    deadLetterQueueUrl: env.SQS_WAGER_DLQ_URL,
    waitTimeSeconds: env.SQS_CONSUMER_WAIT_TIME_SECONDS,
    batchSize: env.SQS_CONSUMER_BATCH_SIZE,
    maxReceives: env.SQS_CONSUMER_MAX_RECEIVES,
    // Jitter subtrativo: o atraso nunca passa do teto e as réplicas não reentregam todas no mesmo instante.
    retryBackoff: new ExponentialBackoff(
      {
        baseDelayMs: env.SQS_CONSUMER_RETRY_BASE_DELAY_MS,
        maxDelayMs: env.SQS_CONSUMER_RETRY_MAX_DELAY_MS,
        jitterRatio: 0.5,
      },
      Math.random,
    ),
    shutdownTimeoutMs: env.SQS_CONSUMER_SHUTDOWN_TIMEOUT_MS,
  };
}
