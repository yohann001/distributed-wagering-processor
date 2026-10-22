import { DomainError } from '../domain/domain-error';
import { FailureCode } from '../domain/failure-code';

/** Por que uma transação perdeu a disputa de concorrência. Valores viram label de métrica: só adicionar. */
export enum ConcurrencyConflictReason {
  Deadlock = 'DEADLOCK',
  SerializationFailure = 'SERIALIZATION_FAILURE',
  LockTimeout = 'LOCK_TIMEOUT',
  /** UPDATE condicional por `version` não achou a versão esperada. */
  VersionConflict = 'VERSION_CONFLICT',
}

/** Conflito de concorrência: transitório, reenviar pode dar certo (TRANSIENT_FAILURE → RETRY). */
export class ConcurrencyConflictError extends DomainError {
  readonly code = FailureCode.TransientFailure;

  constructor(
    readonly reason: ConcurrencyConflictReason,
    detail: string,
  ) {
    super(`Concurrency conflict (${reason}): ${detail}`);
  }
}

/**
 * Fronteira transacional dos casos de uso. `run` executa `work` numa transação SQL nova e, em
 * `ConcurrencyConflictError`, refaz `work` do zero (rollback + nova transação) até o limite de
 * tentativas. `work` precisa ser reexecutável: tudo o que ele lê deve ser lido dentro dele.
 */
export abstract class UnitOfWork {
  abstract run<T>(work: () => Promise<T>): Promise<T>;
}
