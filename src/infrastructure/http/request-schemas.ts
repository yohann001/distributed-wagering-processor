import { z } from 'zod';

import { Money, type MoneyProps } from '../../shared/domain/money';
import { InvalidRequestError } from './http-errors';

/** Qualquer versão de UUID: a coluna `uuid` do Postgres aceita todas, e `z.uuid()` exigiria os bits de variante da RFC. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const ID_MAX_LENGTH = 128;

/** Ids em formato de UUID vão para minúsculas antes do hash e da key; qualquer outro texto fica como veio. */
export function normalizeId(value: string): string {
  return UUID_PATTERN.test(value) ? value.toLowerCase() : value;
}

/**
 * Id de negócio vindo do cliente (player, rodada, jogo, id externo). Recusa vazio, espaço nas pontas e
 * caractere de controle: o domínio trata um valor em branco como erro de programação (`INVARIANT_VIOLATION`),
 * que não pode ser alcançável pela API.
 */
export const idText = z
  .string()
  .min(1)
  .max(ID_MAX_LENGTH)
  .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace')
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'must not contain control characters')
  .transform(normalizeId);

/** `defaultIdempotencyKey` usa `:` como separador, então um `providerId` com `:` poderia colidir com outra key. */
export const providerIdText = idText.refine((value) => !value.includes(':'), "must not contain ':'");

/** Id interno (wallet, transação): precisa ser UUID e é normalizado para minúsculas. */
export const uuidText = z
  .string()
  .regex(UUID_PATTERN, 'must be a UUID')
  .transform((value) => value.toLowerCase());

export type RequestSource = 'body' | 'params' | 'query' | 'headers';

/** Valida `input` com `schema`; qualquer problema vira um `InvalidRequestError` com o caminho prefixado pela origem. */
export function parseRequest<S extends z.ZodType>(source: RequestSource, schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidRequestError(
      parsed.error.issues.map((issue) => ({
        path: [source, ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/** Fora do zod para que todo problema de dinheiro tenha um só código, `INVALID_MONEY`, vindo do próprio `Money.from`. */
export function moneyFrom(value: unknown): Money {
  return Money.from(value as MoneyProps);
}
