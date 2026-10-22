import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';

/** Subconjunto de JSON aceito: sem números, porque dinheiro trafega como string decimal. */
export type CanonicalJsonValue =
  | string
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue | undefined };

export class CanonicalJsonError extends DomainError {
  readonly code = FailureCode.InvariantViolation;

  constructor(reason: string) {
    super(`Value is not canonical JSON: ${reason}`);
  }
}

/**
 * Serialização JSON canônica: chaves ordenadas recursivamente (ordem de unidades UTF-16, como na RFC 8785),
 * sem espaços e com valores `undefined` de objeto omitidos. Compatível com a RFC 8785 para este subconjunto.
 * Números são rejeitados de propósito: dinheiro trafega como string e nunca pode virar float.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return serializeArray(value, path);
  }
  if (isPlainObject(value)) {
    return serializeObject(value, path);
  }
  throw new CanonicalJsonError(`${typeName(value)} at ${path}`);
}

function serializeArray(items: readonly unknown[], path: string): string {
  const parts: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    parts.push(serialize(items[index], `${path}[${index}]`));
  }
  return `[${parts.join(',')}]`;
}

function serializeObject(object: Record<string, unknown>, path: string): string {
  const parts = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(object[key], `${path}.${key}`)}`);
  return `{${parts.join(',')}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Só o tipo, nunca o valor: a mensagem de erro não pode vazar dado financeiro (§12). */
function typeName(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const constructorName: unknown = value.constructor?.name;
    return typeof constructorName === 'string' && constructorName !== '' ? constructorName : 'object';
  }
  return typeof value;
}
