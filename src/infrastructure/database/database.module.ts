import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import { loadEnv } from '../../config/env';
import { buildMikroOrmConfig } from './mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      // Registra também o EntityManager específico do driver (`@mikro-orm/postgresql`) para injeção.
      driver: PostgreSqlDriver,
      useFactory: () => buildMikroOrmConfig(loadEnv()),
    }),
  ],
})
export class DatabaseModule {}
