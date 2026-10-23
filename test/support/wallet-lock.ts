import type { MikroORM } from '@mikro-orm/postgresql';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Segura o `FOR UPDATE` da wallet até `release()`: quem disputa o lock espera ou, com `lockTimeoutMs` curto, falha com `LOCK_TIMEOUT`. */
export async function holdWalletLock(orm: MikroORM, walletId: string): Promise<{ release: () => Promise<void> }> {
  return holdWalletLocks(orm, [walletId]);
}

/** Segura o `FOR UPDATE` de várias wallets numa só transação (uma conexão) até `release()`: quem disputa qualquer uma delas espera. */
export async function holdWalletLocks(orm: MikroORM, walletIds: string[]): Promise<{ release: () => Promise<void> }> {
  const locked = deferred();
  const released = deferred();
  const owner = orm.em.fork().transactional(async (em) => {
    for (const walletId of walletIds) {
      await em.execute('select id from wallets where id = ? for update', [walletId]);
    }
    locked.resolve();
    await released.promise;
  });
  await Promise.race([locked.promise, owner]);
  return {
    release: async () => {
      released.resolve();
      await owner;
    },
  };
}

/** Quantas queries esperam por lock de linha em `wallets`: consumers presos na transação do lock. */
export async function walletLockWaiters(orm: MikroORM): Promise<number> {
  const rows = await orm.em.fork().execute<{ total: number }[]>(
    `select count(*)::int as total from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query ilike '%wallets%'`,
  );
  return rows[0]?.total ?? 0;
}
