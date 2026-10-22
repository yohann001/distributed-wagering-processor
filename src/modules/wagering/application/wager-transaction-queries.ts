import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionRepository } from './wager-transaction-repository';

/**
 * Lado de leitura da transação (§9, Consultas). Lê fora do UnitOfWork: são leituras de um statement, sem lock.
 * `null` significa "não encontrado"; quem decide o que isso vira (404) é a borda.
 */
export class WagerTransactionQueries {
  constructor(private readonly transactions: WagerTransactionRepository) {}

  getById(transactionId: string): Promise<WagerTransaction | null> {
    return this.transactions.findById(transactionId);
  }

  /** O id externo é único só dentro do provedor: o mesmo texto sob outro `providerId` não acha nada. */
  getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.transactions.findByExternalId(providerId, externalTransactionId);
  }
}
