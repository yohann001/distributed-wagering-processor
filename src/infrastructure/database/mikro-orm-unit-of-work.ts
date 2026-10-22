import type { EntityManager } from '@mikro-orm/postgresql';

import type { Env } from '../../config/env';
import {
  ConcurrencyConflictError,
  ConcurrencyConflictReason,
  UnitOfWork,
} from '../../shared/application/unit-of-work';
import { ExponentialBackoff } from '../../shared/domain/exponential-backoff';
import type { ConcurrencyMetrics } from './concurrency-metrics';

export interface UnitOfWorkOptions {
  /** Espera máxima por um lock de linha, por transação. */
  lockTimeoutMs: number;
  /** Execuções de `work` antes de desistir (a primeira conta). */
  maxAttempts: number;
  backoff: ExponentialBackoff;
}

// Atraso curto: o conflito costuma se resolver em milissegundos; o jitter descasa as vítimas de um mesmo deadlock.
export const DEFAULT_RETRY_BACKOFF_OPTIONS = { baseDelayMs: 10, maxDelayMs: 200, jitterRatio: 0.5 };

export function unitOfWorkOptionsFromEnv(
  env: Pick<Env, 'DB_LOCK_TIMEOUT_MS' | 'DB_TRANSACTION_MAX_ATTEMPTS'>,
): UnitOfWorkOptions {
  return {
    lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
    maxAttempts: env.DB_TRANSACTION_MAX_ATTEMPTS,
    backoff: new ExponentialBackoff(DEFAULT_RETRY_BACKOFF_OPTIONS, Math.random),
  };
}

const SQLSTATE_REASONS: Readonly<Record<string, ConcurrencyConflictReason>> = {
  '40P01': ConcurrencyConflictReason.Deadlock,
  '40001': ConcurrencyConflictReason.SerializationFailure,
  '55P03': ConcurrencyConflictReason.LockTimeout,
};

/**
 * Traduz o erro do driver para um conflito de concorrência refazível, ou `null` se o erro não é desse tipo.
 * Lê o SQLSTATE em `code` (o `DriverException` do MikroORM copia o do `pg`), e não usa `instanceof
 * DeadlockException`: o MikroORM junta 40001 e 40P01 nela e não converte 55P03.
 */
export function classifyConcurrencyConflict(error: unknown): ConcurrencyConflictError | null {
  if (error instanceof ConcurrencyConflictError) {
    return error;
  }
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const { code } = error;
  if (typeof code !== 'string') {
    return null;
  }
  const reason = SQLSTATE_REASONS[code];
  return reason === undefined ? null : new ConcurrencyConflictError(reason, `SQLSTATE ${code}`);
}

export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: ConcurrencyMetrics,
    private readonly options: UnitOfWorkOptions,
  ) {
    super();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    // Erro de programação: o retry refaria só a parte interna e a transação externa ficaria suja.
    if (this.em.isInTransaction()) {
      throw new Error('UnitOfWork.run must not be nested inside another transaction');
    }

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.em.transactional(async (em) => {
          // set_config(..., true) é o SET LOCAL parametrizado: vale só para esta transação e não vaza para o pool.
          // O isolamento fica no READ COMMITTED padrão: depois de esperar o FOR UPDATE, a leitura vê a versão já commitada.
          await em.execute("select set_config('lock_timeout', ?, true)", [
            `${this.options.lockTimeoutMs}ms`,
          ]);
          return work();
        });
      } catch (error) {
        const conflict = classifyConcurrencyConflict(error);
        if (conflict === null) {
          throw error;
        }
        if (attempt >= this.options.maxAttempts) {
          this.metrics.recordConflict(conflict.reason, 'exhausted');
          throw conflict;
        }
        this.metrics.recordConflict(conflict.reason, 'retried');
        await Bun.sleep(this.options.backoff.delayMs(attempt));
      }
    }
  }
}
