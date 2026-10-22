import type { WagerTransaction } from '../domain/wager-transaction';

/**
 * Porta de persistência da WagerTransaction. `insert` e `update` exigem transação ativa.
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
}
