import type { Wallet } from '../domain/wallet';

/** Porta de persistência da Wallet. `insert` exige transação ativa. */
export abstract class WalletRepository {
  abstract insert(wallet: Wallet): Promise<void>;

  abstract findById(id: string): Promise<Wallet | null>;
}
