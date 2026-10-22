import { z } from 'zod';

import { idText, uuidText } from '../../../infrastructure/http/request-schemas';
import type { MoneyProps } from '../../../shared/domain/money';
import type { WalletReconciliation } from '../application/reconcile-wallet';
import { LEDGER_PAGE_MAX_LIMIT, type LedgerPageResult } from '../application/wallet-queries';
import type { Wallet } from '../domain/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/** `initialBalance` fica sem tipo aqui: `moneyFrom` o valida, para que todo problema de dinheiro seja `INVALID_MONEY`. */
export const openWalletBody = z.object({ playerId: idText, initialBalance: z.unknown() });

export const walletParams = z.object({ walletId: uuidText });

/**
 * Parâmetro repetido chega como array e falha a checagem de string. A faixa de `limit` (1..100) e o formato do
 * cursor são validados em `WalletQueries`, que lança `InvalidQueryError` (também `INVALID_PAYLOAD`).
 */
export const ledgerQuery = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .regex(/^\d{1,4}$/, `must be an integer between 1 and ${LEDGER_PAGE_MAX_LIMIT}`)
    .transform(Number)
    .optional(),
});

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageResponse {
  items: LedgerEntryResponse[];
  nextCursor: string | null;
}

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export function toWalletResponse(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function toLedgerEntryResponse(entry: WalletLedgerEntry): LedgerEntryResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toLedgerPageResponse(page: LedgerPageResult): LedgerPageResponse {
  return { items: page.entries.map(toLedgerEntryResponse), nextCursor: page.nextCursor };
}

export function toReconciliationResponse(reconciliation: WalletReconciliation): ReconciliationResponse {
  return {
    walletId: reconciliation.walletId,
    storedBalance: reconciliation.storedBalance.toJSON(),
    calculatedBalance: reconciliation.calculatedBalance.toJSON(),
    difference: reconciliation.difference.toJSON(),
    consistent: reconciliation.consistent,
    checkedEntries: reconciliation.checkedEntries,
  };
}
