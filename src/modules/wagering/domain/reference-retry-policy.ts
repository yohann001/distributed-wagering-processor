import {
  InvalidBackoffError,
  type ExponentialBackoff,
  type ExponentialBackoffOptions,
} from '../../../shared/domain/exponential-backoff';

/**
 * Padrão do worker de PENDING_REFERENCE (T24): 20 reavaliações, 1 s dobrando até 60 s, com até 20% de jitter.
 * A primeira reavaliação vence na hora; a janela até a última fica entre ~11 e ~14 min (soma dos 19 atrasos:
 * 1+2+4+8+16+32 s + 13 × 60 s = 843 s, menos o jitter). Justificativa no ARCHITECTURE.md.
 */
export const DEFAULT_REFERENCE_RETRY_MAX_ATTEMPTS = 20;

export const DEFAULT_REFERENCE_RETRY_BACKOFF: Readonly<ExponentialBackoffOptions> = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
});

export type ReferenceRetryStep = { kind: 'retry'; nextAttemptAt: Date } | { kind: 'exhausted' };

/** Decide, a cada reavaliação que não achou a referência utilizável, entre reagendar com backoff e desistir. */
export class ReferenceRetryPolicy {
  constructor(
    readonly maxAttempts: number,
    private readonly backoff: ExponentialBackoff,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new InvalidBackoffError('maxAttempts must be an integer greater than or equal to 1');
    }
  }

  /** `attempt` é o número desta reavaliação, a partir de 1. Abaixo do limite agenda a próxima com backoff; no limite, esgotou. */
  afterMissedAttempt(attempt: number, now: Date): ReferenceRetryStep {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new InvalidBackoffError('attempt must be an integer greater than or equal to 1');
    }
    if (attempt >= this.maxAttempts) {
      return { kind: 'exhausted' };
    }
    return { kind: 'retry', nextAttemptAt: new Date(now.getTime() + this.backoff.delayMs(attempt)) };
  }
}
