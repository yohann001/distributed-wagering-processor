import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';

import { loadEnv } from '../../../../src/config/env';
import { buildMikroOrmConfig } from '../../../../src/infrastructure/database/mikro-orm.config';
import { EMPTY_SCHEMA_OBJECTS, EXPECTED_SCHEMA_OBJECTS, readSchemaObjects } from '../../../support/schema-objects';

const INITIAL_MIGRATION = 'Migration20261022021041_initial_schema';

/**
 * Roda `up → down → up` num banco descartável: rodar `down` no banco compartilhado apagaria o schema
 * que os outros specs (e o ambiente de desenvolvimento) usam.
 */
describe('migrations roundtrip (Postgres real)', () => {
  let admin: MikroORM;
  let orm: MikroORM;
  let databaseName: string;

  beforeAll(async () => {
    const env = loadEnv();
    admin = await MikroORM.init(buildMikroOrmConfig(env));
    databaseName = `wagering_migrations_${Bun.randomUUIDv7().replaceAll('-', '')}`;
    await admin.em.getConnection().execute(`create database ${databaseName}`);

    const url = new URL(env.DATABASE_URL);
    url.pathname = `/${databaseName}`;
    const base = buildMikroOrmConfig({ ...env, DATABASE_URL: url.toString() });
    orm = await MikroORM.init({ ...base, migrations: { ...base.migrations, silent: true } });
  });

  afterAll(async () => {
    await orm?.close(true);
    if (databaseName !== undefined) {
      await admin?.em.getConnection().execute(`drop database if exists ${databaseName} with (force)`);
    }
    await admin?.close(true);
  });

  it('applies the schema, reverts it completely and applies it again', async () => {
    const migrator = orm.getMigrator();

    const applied = await migrator.up();
    expect(applied.map((migration) => migration.name)).toContain(INITIAL_MIGRATION);
    expect(await readSchemaObjects(orm.em.fork())).toEqual(EXPECTED_SCHEMA_OBJECTS);

    await migrator.down({ to: 0 });
    expect(await readSchemaObjects(orm.em.fork())).toEqual(EMPTY_SCHEMA_OBJECTS);
    expect(await migrator.getExecutedMigrations()).toEqual([]);

    await migrator.up();
    expect(await readSchemaObjects(orm.em.fork())).toEqual(EXPECTED_SCHEMA_OBJECTS);
    expect(await migrator.getPendingMigrations()).toEqual([]);
  });
});
