import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import { Registry } from 'prom-client';

import { loadEnv } from '../../config/env';
import { UnitOfWork } from '../../shared/application/unit-of-work';
import { ConcurrencyMetrics } from './concurrency-metrics';
import { buildMikroOrmConfig } from './mikro-orm.config';
import { MikroOrmUnitOfWork, unitOfWorkOptionsFromEnv } from './mikro-orm-unit-of-work';

@Global()
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      // Registra também o EntityManager específico do driver (`@mikro-orm/postgresql`) para injeção.
      driver: PostgreSqlDriver,
      useFactory: () => buildMikroOrmConfig(loadEnv()),
    }),
  ],
  providers: [
    {
      provide: ConcurrencyMetrics,
      inject: [Registry],
      useFactory: (registry: Registry) => new ConcurrencyMetrics(registry),
    },
    {
      provide: UnitOfWork,
      inject: [EntityManager, ConcurrencyMetrics],
      useFactory: (em: EntityManager, metrics: ConcurrencyMetrics) =>
        new MikroOrmUnitOfWork(em, metrics, unitOfWorkOptionsFromEnv(loadEnv())),
    },
  ],
  exports: [UnitOfWork, ConcurrencyMetrics],
})
export class DatabaseModule {}
