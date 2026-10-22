import { EntitySchema } from '@mikro-orm/core';

import type { FailureCode } from '../../../../shared/domain/failure-code';
import { Money } from '../../../../shared/domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';

// Row + mapper em vez de mapear a classe de domínio direto (§6.1): o estado mutável é `private _campo`
// com getters e cópia defensiva de Date, e `Money` ocupa duas colunas (`amount` + `currency`; o
// `balance_after` reaproveita a `currency` da transação). O mapper só reconstrói pelo `rehydrate`, que
// não revalida (§6.0).

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  /** `numeric(18,2)` lido como string: dinheiro nunca passa por `number`. */
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  balanceAfter: string | null;
  processedAt: Date | null;
  createdAt: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  name: 'WagerTransactionRow',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', columnType: 'text' },
    externalTransactionId: { type: 'string', columnType: 'text' },
    idempotencyKey: { type: 'string', columnType: 'text' },
    payloadHash: { type: 'string', columnType: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'string', columnType: 'text' },
    roundId: { type: 'string', columnType: 'text' },
    gameId: { type: 'string', columnType: 'text' },
    kind: { type: 'string', columnType: 'text' },
    amount: { type: 'decimal', precision: 18, scale: 2 },
    currency: { type: 'string', columnType: 'text' },
    referenceExternalTransactionId: { type: 'string', columnType: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string', columnType: 'text' },
    failureCode: { type: 'string', columnType: 'text', nullable: true },
    balanceAfter: { type: 'decimal', precision: 18, scale: 2, nullable: true },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});

export function wagerTransactionToRow(tx: WagerTransaction): WagerTransactionRow {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toJSON().amount,
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balanceAfter: tx.balanceAfter?.toJSON().amount ?? null,
    processedAt: tx.processedAt ?? null,
    createdAt: tx.createdAt,
  };
}

export function wagerTransactionFromRow(row: WagerTransactionRow): WagerTransaction {
  const { currency } = row;
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    money: Money.from({ amount: row.amount, currency }),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: row.failureCode ?? undefined,
    processedAt: row.processedAt ?? undefined,
    balanceAfter: row.balanceAfter === null ? undefined : Money.from({ amount: row.balanceAfter, currency }),
  });
}
