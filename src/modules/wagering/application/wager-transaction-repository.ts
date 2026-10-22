import type { WagerTransaction } from '../domain/wager-transaction';

export interface ClaimedPendingReference {
  transaction: WagerTransaction;
  /** Reavaliações anteriores que não acharam a referência utilizável. */
  attempts: number;
}

/**
 * Porta de persistência da WagerTransaction. `insert`, `update`, `claimDuePendingReference` e
 * `scheduleReferenceRetry` exigem transação ativa.
 * `insert` lança `WagerTransactionAlreadyExistsError` quando a key ou o id externo já existem
 * (a transação SQL fica abortada).
 */
export abstract class WagerTransactionRepository {
  abstract insert(transaction: WagerTransaction): Promise<void>;

  /** Grava só as colunas mutáveis: status, referência resolvida, failureCode, balanceAfter e processedAt. */
  abstract update(transaction: WagerTransaction): Promise<void>;

  abstract findById(id: string): Promise<WagerTransaction | null>;

  /** Pela unique `(provider_id, idempotency_key)`: a key é por provedor, nunca global. */
  abstract findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;

  /** Pela unique `(provider_id, external_transaction_id)`; também resolve a referência (§7 regra 2). */
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;

  /** REFUND/ROLLBACK `PROCESSED` que apontam `referenceTransactionId` (índice parcial `wager_transactions_single_reversal_uq`). */
  abstract findProcessedReversalsOf(referenceTransactionId: string): Promise<WagerTransaction[]>;

  /** A `PENDING_REFERENCE` vencida mais antiga (`next_reference_attempt_at <= now`), travada com FOR UPDATE SKIP LOCKED; null sem nenhuma. Exige transação ativa. */
  abstract claimDuePendingReference(now: Date): Promise<ClaimedPendingReference | null>;

  /** Grava a contagem e a próxima tentativa de uma `PENDING_REFERENCE`. Exige transação ativa. */
  abstract scheduleReferenceRetry(id: string, attempts: number, nextAttemptAt: Date): Promise<void>;
}
