import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';

/** Erro de programação: opções, tentativa ou fonte de aleatoriedade incoerentes. */
export class InvalidBackoffError extends DomainError {
  readonly code = FailureCode.InvariantViolation;

  constructor(reason: string) {
    super(`Invalid backoff: ${reason}`);
  }
}

export interface ExponentialBackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fração do atraso removível pelo jitter, em [0, 1]. */
  jitterRatio: number;
}

/** Fonte de aleatoriedade em [0, 1), injetada para testes determinísticos (em produção, Math.random). */
export type RandomSource = () => number;

export class ExponentialBackoff {
  readonly options: Readonly<ExponentialBackoffOptions>;

  constructor(
    options: ExponentialBackoffOptions,
    private readonly random: RandomSource,
  ) {
    const { baseDelayMs, maxDelayMs, jitterRatio } = options;
    if (!Number.isInteger(baseDelayMs) || baseDelayMs <= 0) {
      throw new InvalidBackoffError('baseDelayMs must be a positive integer');
    }
    if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
      throw new InvalidBackoffError('maxDelayMs must be an integer not lower than baseDelayMs');
    }
    if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
      throw new InvalidBackoffError('jitterRatio must be a number between 0 and 1');
    }
    this.options = Object.freeze({ baseDelayMs, maxDelayMs, jitterRatio });
  }

  /**
   * Atraso em ms antes da tentativa seguinte, com `attempt` começando em 1: `base · 2^(attempt-1)`
   * limitado a `maxDelayMs`. O jitter é subtrativo: o atraso fica em [capped·(1−jitterRatio), capped],
   * então nunca passa do teto e o piso também cresce.
   */
  delayMs(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new InvalidBackoffError('attempt must be an integer greater than or equal to 1');
    }
    const { baseDelayMs, maxDelayMs, jitterRatio } = this.options;
    const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const r = this.random();
    if (!(r >= 0 && r < 1)) {
      throw new InvalidBackoffError('random source must return a number in [0, 1)');
    }
    // ceil e não round: capped é inteiro, então o resultado nunca cai abaixo do piso nem passa do teto.
    return Math.ceil(capped * (1 - jitterRatio * r));
  }
}
