import { InvalidQueryError } from '../../../shared/application/invalid-query-error';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import type { WalletLedgerRepository } from './wallet-ledger-repository';
import type { WalletRepository } from './wallet-repository';

export const LEDGER_PAGE_DEFAULT_LIMIT = 50;
export const LEDGER_PAGE_MAX_LIMIT = 100;

export interface ListLedgerQuery {
  walletId: string;
  /** Cursor opaco devolvido por uma página anterior da mesma wallet. */
  cursor?: string;
  /** Inteiro em `1..LEDGER_PAGE_MAX_LIMIT`; padrão `LEDGER_PAGE_DEFAULT_LIMIT`. */
  limit?: number;
}

export interface LedgerPageResult {
  entries: WalletLedgerEntry[];
  /** null na última página. */
  nextCursor: string | null;
}

/**
 * Lado de leitura da wallet (§9, Consultas). Lê fora do UnitOfWork: são leituras de um statement, sem lock.
 * `null` significa "não encontrado"; quem decide o que isso vira (404) é a borda.
 */
export class WalletQueries {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedgerRepository,
  ) {}

  getWallet(walletId: string): Promise<Wallet | null> {
    return this.wallets.findById(walletId);
  }

  /** Lançamentos da wallet, do mais recente para o mais antigo, ou `null` se a wallet não existe. */
  async listLedger(query: ListLedgerQuery): Promise<LedgerPageResult | null> {
    const { walletId } = query;
    const limit = this.validatedLimit(query.limit);
    const after = query.cursor === undefined ? null : decodeLedgerCursor(query.cursor, walletId);

    const wallet = await this.wallets.findById(walletId);
    if (wallet === null) {
      return null;
    }

    const { entries, nextPosition } = await this.ledger.listByWallet({ walletId, after, limit });
    return {
      entries,
      nextCursor: nextPosition === null ? null : encodeLedgerCursor(walletId, nextPosition),
    };
  }

  private validatedLimit(limit: number | undefined): number {
    if (limit === undefined) {
      return LEDGER_PAGE_DEFAULT_LIMIT;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_PAGE_MAX_LIMIT) {
      throw new InvalidQueryError('limit', `must be an integer between 1 and ${LEDGER_PAGE_MAX_LIMIT}`);
    }
    return limit;
  }
}
