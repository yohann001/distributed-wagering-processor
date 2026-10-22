import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/** Porta de persistência do ledger (append-only). `append` exige transação ativa. */
export abstract class WalletLedgerRepository {
  abstract append(entry: WalletLedgerEntry): Promise<void>;

  abstract findById(id: string): Promise<WalletLedgerEntry | null>;
}
