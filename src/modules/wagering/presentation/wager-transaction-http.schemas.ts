import { z } from 'zod';

import {
  idText,
  moneyFrom,
  providerIdText,
  uuidText,
} from '../../../infrastructure/http/request-schemas';
import type { FailureCode } from '../../../shared/domain/failure-code';
import type { MoneyProps } from '../../../shared/domain/money';
import type {
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionResult,
} from '../application/submit-wager-transaction';
import {
  KindNotAllowedError,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../domain/wager-transaction';

/**
 * Campos de negócio de uma transação, validados e normalizados (ids UUID em minúsculas, sem `:` no `providerId`).
 * Compartilhado com o consumer SQS (T22): as duas bordas normalizam do mesmo jeito antes do hash.
 */
export const wagerTransactionPayloadSchema = z.object({
  providerId: providerIdText,
  externalTransactionId: idText,
  playerId: idText,
  walletId: uuidText,
  roundId: idText,
  gameId: idText,
  kind: z.enum(WagerTransactionKind),
  money: z.unknown(),
  referenceExternalTransactionId: idText.nullish().transform((value) => value ?? undefined),
});

export type WagerTransactionPayload = z.output<typeof wagerTransactionPayloadSchema>;

export type SubmitCommandFields = Omit<SubmitWagerTransactionCommand, 'idempotencyKey' | 'correlationId' | 'inbox'>;

/** Recusa `OPENING` (interno) antes de qualquer acesso ao banco e converte o dinheiro com `Money.from`. */
export function toSubmitCommandFields(parsed: WagerTransactionPayload): SubmitCommandFields {
  if (parsed.kind === WagerTransactionKind.Opening) {
    throw new KindNotAllowedError(parsed.kind);
  }
  return {
    providerId: parsed.providerId,
    externalTransactionId: parsed.externalTransactionId,
    walletId: parsed.walletId,
    playerId: parsed.playerId,
    roundId: parsed.roundId,
    gameId: parsed.gameId,
    kind: parsed.kind,
    money: moneyFrom(parsed.money),
    referenceExternalTransactionId: parsed.referenceExternalTransactionId,
  };
}

/** O header é opaco: usado como recebido. O Node coloca os nomes em minúsculas. */
export const idempotencyKeyHeaders = z.object({
  'idempotency-key': z.string().regex(/^[\x21-\x7e]{1,255}$/, 'must be 1-255 visible ASCII characters'),
});

export const transactionIdParams = z.object({ transactionId: uuidText });

export const externalIdParams = z.object({ providerId: providerIdText, externalTransactionId: idText });

/** Status HTTP da submissão pelo estado decidido; `PENDING` e `FAILED` não saem do caso de uso (erro de programação). */
export function httpStatusForTransaction(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.Failed:
      throw new Error('unexpected status from submission');
  }
}

export interface SubmitResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
}

export interface TransactionResponse {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export function toSubmitResponse(result: SubmitWagerTransactionResult): SubmitResponse {
  const { transaction, idempotentReplay } = result;
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.balanceAfter?.toJSON() ?? null,
    failureCode: transaction.failureCode ?? null,
    idempotentReplay,
  };
}

export function toTransactionResponse(transaction: WagerTransaction): TransactionResponse {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balanceAfter: transaction.balanceAfter?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
