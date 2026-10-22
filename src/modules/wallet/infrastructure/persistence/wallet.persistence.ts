import { EntitySchema } from '@mikro-orm/core';

import { Money } from '../../../../shared/domain/money';
import { Wallet } from '../../domain/wallet';

// Row + mapper em vez de mapear a classe de domínio direto (§6.1): o domínio tem estado `private _campo`
// com getters, cópia defensiva de Date e `Wallet.lastLedgerEntryId` transitório, e `Money` ocupa duas
// colunas (`amount` + `currency`). O mapper só reconstrói pelo `rehydrate`, que não revalida (§6.0).

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  /** `numeric(18,2)` lido como string: dinheiro nunca passa por `number`. */
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  name: 'WalletRow',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', columnType: 'text' },
    currency: { type: 'string', columnType: 'text' },
    balance: { type: 'decimal', precision: 18, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});

export function walletToRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
