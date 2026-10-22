import type { EntityManager } from '@mikro-orm/postgresql';

/** Erro de programação: escrita financeira fora de `em.transactional()` (§6.5, §11). */
export function assertInTransaction(em: EntityManager, operation: string): void {
  if (!em.isInTransaction()) {
    throw new Error(`${operation} must run inside em.transactional()`);
  }
}
