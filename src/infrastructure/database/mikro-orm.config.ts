import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';

import { loadEnv, type Env } from '../../config/env';
import { ENTITY_SCHEMAS } from './entity-schemas';

const migrationsPath = new URL('./migrations', import.meta.url).pathname;

export function buildMikroOrmConfig(env: Env): Options {
  return defineConfig({
    clientUrl: env.DATABASE_URL,
    // Sem `acquireTimeoutMillis` o knex espera 60 s por uma conexão livre; com pool cheio a requisição deve
    // falhar rápido em 503 + `Retry-After` (`isTransientDatabaseFailure`).
    pool: { min: 0, max: env.DATABASE_POOL_MAX, acquireTimeoutMillis: env.DB_POOL_ACQUIRE_TIMEOUT_MS },
    entities: [...ENTITY_SCHEMAS],
    extensions: [Migrator],
    // As migrations são escritas à mão (o schema da T10 tem constraints e triggers que o metadata não
    // conhece): use `migration:create --blank`, nunca a geração a partir dos schemas.
    migrations: {
      path: migrationsPath,
      pathTs: migrationsPath,
      emit: 'ts',
      // Cada migration roda na própria transação; alterações de schema são sempre reversíveis (up/down).
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: false,
  });
}

// Usado pela CLI do MikroORM (`bun run migration:*`).
export default buildMikroOrmConfig(loadEnv());
