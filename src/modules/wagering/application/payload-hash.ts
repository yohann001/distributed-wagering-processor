import { createHash } from 'node:crypto';

import { canonicalJson } from '../../../shared/domain/canonical-json';
import type { CreateWagerTransactionProps } from '../domain/wager-transaction';

export type WagerPayload = Pick<
  CreateWagerTransactionProps,
  | 'providerId'
  | 'externalTransactionId'
  | 'walletId'
  | 'playerId'
  | 'roundId'
  | 'gameId'
  | 'kind'
  | 'money'
  | 'referenceExternalTransactionId'
>;

/**
 * SHA-256 (hex minúsculo, 64 chars) do JSON canônico dos campos de negócio: providerId, externalTransactionId,
 * walletId, playerId, roundId, gameId, kind, money e referenceExternalTransactionId (vazio equivale a ausente).
 * Header, idempotencyKey e metadados de transporte (envelope SQS, correlação) não entram.
 */
export function wagerPayloadHash(payload: WagerPayload): string {
  const { amount, currency } = payload.money.toJSON();
  const subset = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    walletId: payload.walletId,
    playerId: payload.playerId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount, currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId || undefined,
  };
  return createHash('sha256').update(canonicalJson(subset), 'utf8').digest('hex');
}

/** Formato recomendado da key (§9). No HTTP o header `Idempotency-Key` continua obrigatório. */
export function defaultIdempotencyKey(providerId: string, externalTransactionId: string): string {
  return `${providerId}:${externalTransactionId}`;
}
