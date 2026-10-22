import type { Wallet } from '../domain/wallet';

/** Porta de persistência da Wallet. `insert`, `lockById` e `updateBalance` exigem transação ativa. */
export abstract class WalletRepository {
  abstract insert(wallet: Wallet): Promise<void>;

  abstract findById(id: string): Promise<Wallet | null>;

  /**
   * `SELECT … FOR UPDATE` só na linha da wallet (§8: a unidade de concorrência é a walletId).
   * Segura o lock até o fim da transação; null se a wallet não existe.
   */
  abstract lockById(id: string): Promise<Wallet | null>;

  /**
   * Grava saldo, version e updatedAt se a linha ainda estiver em `expectedVersion`; senão lança
   * `ConcurrencyConflictError` (VERSION_CONFLICT). `wallet.version` deve ser `expectedVersion + 1`.
   */
  abstract updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}
