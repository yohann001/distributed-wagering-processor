import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';

/** Campos do `DatabaseError` do driver `pg` que os testes de constraint conferem. */
export interface PgErrorLike {
  code?: string;
  constraint?: string;
  message: string;
}

/**
 * Esvazia as 5 tabelas da aplicação. Só existe em `test/support/`: `session_replication_role = replica`
 * desliga os triggers append-only/terminal (exige superuser; o usuário do compose é) e nunca pode existir
 * em código de produção. As 5 tabelas vão num único `TRUNCATE`, porque a FK do ledger barra o `TRUNCATE`
 * isolado de `wager_transactions` (`0A000`).
 */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetDatabase must never run in production');
  }
  await orm.em.fork().transactional(async (em) => {
    await em.execute('set local session_replication_role = replica');
    await em.execute(
      'truncate table wallet_ledger_entries, wager_transactions, wallets, inbox_messages, outbox_messages',
    );
  });
}

class RollbackSentinel extends Error {}

/** Roda `fn` numa transação e a reverte no fim: para casos que não podem deixar linhas nem DDL para trás. */
export async function withRollback(
  orm: MikroORM,
  fn: (em: EntityManager) => Promise<void>,
): Promise<void> {
  try {
    await orm.em.fork().transactional(async (em) => {
      await fn(em);
      throw new RollbackSentinel('rollback');
    });
  } catch (error) {
    if (!(error instanceof RollbackSentinel)) {
      throw error;
    }
  }
}

/** Exige que o banco rejeite a ação: confere o SQLSTATE e, quando informados, o nome da constraint e um trecho da mensagem. */
export async function expectDbError(
  action: Promise<unknown>,
  expected: { code: string; constraint?: string; message?: string },
): Promise<PgErrorLike> {
  try {
    await action;
  } catch (error) {
    const caught = error as PgErrorLike;
    expect(caught.code).toBe(expected.code);
    if (expected.constraint !== undefined) {
      expect(caught.constraint).toBe(expected.constraint);
    }
    if (expected.message !== undefined) {
      expect(caught.message).toContain(expected.message);
    }
    return caught;
  }
  throw new Error(`expected database error ${expected.code} but the statement succeeded`);
}
