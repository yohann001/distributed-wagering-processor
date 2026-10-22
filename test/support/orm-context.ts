import { RequestContext, type MikroORM } from '@mikro-orm/postgresql';

/** Escrita dentro de `em.transactional()`: os repositórios resolvem o contexto pela AsyncLocalStorage. */
export function inTransaction<T>(orm: MikroORM, fn: () => Promise<T>): Promise<T> {
  return orm.em.transactional(() => fn());
}

/** Fork novo (identity map vazio): a leitura sempre vai ao banco, como numa requisição nova. */
export function inFreshContext<T>(orm: MikroORM, fn: () => Promise<T>): Promise<T> {
  return RequestContext.create(orm.em.fork(), fn);
}

/** Estreita `T | null | undefined` para `T`; falha o teste com mensagem clara se o valor não existir. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
}
