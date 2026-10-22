import { InvalidQueryError } from '../../../shared/application/invalid-query-error';

const CURSOR_VERSION = 1;
const CURSOR_MAX_LENGTH = 512;
const CURSOR_ALPHABET = /^[A-Za-z0-9_-]+$/;
/** `seq` é um identity `bigint` que começa em 1: inteiro positivo, sem zero à esquerda, cabe em 19 dígitos. */
const SEQ_PATTERN = /^[1-9][0-9]{0,18}$/;
/** Maior `bigint` do Postgres: acima dele a comparação estouraria no banco em vez de virar cursor inválido. */
const BIGINT_MAX = 9223372036854775807n;

// O cursor é preso à wallet: o de outra wallet começaria a página num ponto arbitrário, sem erro visível.
export function encodeLedgerCursor(walletId: string, position: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, w: walletId, s: position }), 'utf8').toString('base64url');
}

/** Devolve a posição (`seq`) do cursor ou lança `InvalidQueryError` se ele for inválido ou de outra wallet. */
export function decodeLedgerCursor(cursor: string, walletId: string): string {
  if (cursor.length === 0 || cursor.length > CURSOR_MAX_LENGTH || !CURSOR_ALPHABET.test(cursor)) {
    throw new InvalidQueryError('cursor', 'malformed');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidQueryError('cursor', 'malformed');
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new InvalidQueryError('cursor', 'malformed');
  }
  const { v, w, s } = payload as Record<string, unknown>;
  if (v !== CURSOR_VERSION) {
    throw new InvalidQueryError('cursor', 'unsupported version');
  }
  if (typeof w !== 'string' || w.toLowerCase() !== walletId.toLowerCase()) {
    throw new InvalidQueryError('cursor', 'does not belong to this wallet');
  }
  if (typeof s !== 'string' || !SEQ_PATTERN.test(s) || BigInt(s) > BIGINT_MAX) {
    throw new InvalidQueryError('cursor', 'malformed');
  }
  return s;
}
