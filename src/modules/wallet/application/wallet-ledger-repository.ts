import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface LedgerPageQuery {
  walletId: string;
  /** Posição opaca (seq) do último lançamento já visto; null = a partir do mais recente. */
  after: string | null;
  limit: number;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Posição do último lançamento da página quando há mais itens; null na última página. */
  nextPosition: string | null;
}

/** Porta de persistência do ledger (append-only). `append` exige transação ativa. */
export abstract class WalletLedgerRepository {
  abstract append(entry: WalletLedgerEntry): Promise<void>;

  abstract findById(id: string): Promise<WalletLedgerEntry | null>;

  /**
   * Lançamentos da wallet do mais recente para o mais antigo (`seq` decrescente, a ordem total por wallet).
   * Lançamentos acrescentados depois recebem `seq` maior, acima de qualquer posição já entregue, então
   * percorrer as páginas nunca pula nem repete itens.
   */
  abstract listByWallet(query: LedgerPageQuery): Promise<LedgerPage>;
}
