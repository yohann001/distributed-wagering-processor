import type { WagerTransaction } from '../domain/wager-transaction';

/** Porta de persistência da WagerTransaction. `insert` e `update` exigem transação ativa. */
export abstract class WagerTransactionRepository {
  abstract insert(transaction: WagerTransaction): Promise<void>;

  /** Grava só as colunas mutáveis: status, referência resolvida, failureCode, balanceAfter e processedAt. */
  abstract update(transaction: WagerTransaction): Promise<void>;

  abstract findById(id: string): Promise<WagerTransaction | null>;
}
