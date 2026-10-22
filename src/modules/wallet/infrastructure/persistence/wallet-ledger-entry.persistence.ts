import { BigIntType, EntitySchema } from '@mikro-orm/core';

import { Money } from '../../../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

// Row + mapper em vez de mapear a classe de domínio direto (§6.1): `WalletLedgerEntry` é `Object.freeze`
// e o MikroORM precisa anotar a instância; além disso `money`, `balanceBefore` e `balanceAfter` dividem
// uma única coluna `currency`, o que um custom type de coluna única não representa. A coluna `seq`
// (gerada pelo banco) é mapeada só para leitura, na paginação por cursor, e fica fora do domínio.

export interface WalletLedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  /** `numeric(18,2)` lido como string: dinheiro nunca passa por `number`. */
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
  /** Identity `bigint` lido como string (pode passar de `Number.MAX_SAFE_INTEGER`); gerado pelo banco, nunca gravado. */
  seq?: string;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
  name: 'WalletLedgerEntryRow',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string', columnType: 'text' },
    amount: { type: 'decimal', precision: 18, scale: 2 },
    currency: { type: 'string', columnType: 'text' },
    balanceBefore: { type: 'decimal', precision: 18, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 18, scale: 2 },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    seq: { type: new BigIntType('string'), columnType: 'bigint', nullable: true },
  },
});

export function walletLedgerEntryToRow(entry: WalletLedgerEntry): WalletLedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}

export function walletLedgerEntryFromRow(row: WalletLedgerEntryRow): WalletLedgerEntry {
  const { currency } = row;
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction,
    money: Money.from({ amount: row.amount, currency }),
    balanceBefore: Money.from({ amount: row.balanceBefore, currency }),
    balanceAfter: Money.from({ amount: row.balanceAfter, currency }),
    createdAt: row.createdAt,
  });
}
