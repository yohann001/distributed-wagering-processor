import { SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EntityManager } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';

import { AppModule } from '../../src/app.module';
import { loadEnv } from '../../src/config/env';
import { ConcurrencyMetrics } from '../../src/infrastructure/database/concurrency-metrics';
import {
  MikroOrmUnitOfWork,
  unitOfWorkOptionsFromEnv,
  type UnitOfWorkOptions,
} from '../../src/infrastructure/database/mikro-orm-unit-of-work';
import { LOG_DESTINATION } from '../../src/infrastructure/observability/observability.module';
import {
  OUTBOX_PUBLISHER_OPTIONS,
  outboxPublisherOptionsFromEnv,
  type OutboxPublisherOptions,
} from '../../src/modules/messaging/infrastructure/outbox/outbox-publisher-options';
import {
  SQS_CONSUMER_OPTIONS,
  sqsConsumerOptionsFromEnv,
  type SqsConsumerOptions,
} from '../../src/modules/messaging/infrastructure/sqs/sqs-consumer-options';
import { ProviderIdentityPort } from '../../src/shared/application/provider-identity';
import { UnitOfWork } from '../../src/shared/application/unit-of-work';

const DISCARD_LOG_DESTINATION: DestinationStream = { write: () => undefined };

export interface CreateTestAppOptions {
  /** Destino dos logs do app; sem ele, os logs são descartados para a suíte ficar silenciosa. */
  logDestination?: DestinationStream;
  /** Substitui a porta de identidade; sem ele vale o adapter no-op, que aceita toda requisição. */
  providerIdentity?: ProviderIdentityPort;
  /** Substitui o cliente SQS do app (ex.: endpoint inalcançável nos testes de readiness). */
  sqsClient?: SQSClient;
  /**
   * Liga o consumer SQS com estas opções por cima das do ambiente. Sem ele o consumer fica desligado: as outras
   * suítes usam a mesma fila e um consumer rodando roubaria as mensagens delas.
   */
  sqsConsumer?: Partial<Omit<SqsConsumerOptions, 'enabled'>>;
  /**
   * Liga o publisher da outbox com estas opções por cima das do ambiente. Sem ele o worker fica desligado: as outras
   * suítes conferem linhas pendentes da outbox e um worker rodando as publicaria.
   */
  outboxPublisher?: Partial<Omit<OutboxPublisherOptions, 'enabled'>>;
  /** Opções do `UnitOfWork` por cima das do ambiente (ex.: `lockTimeoutMs` curto). O adapter continua o real. */
  unitOfWork?: Partial<UnitOfWorkOptions>;
}

/** Sobe a aplicação Nest completa contra a infraestrutura real do docker compose. */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LOG_DESTINATION)
    .useValue(options.logDestination ?? DISCARD_LOG_DESTINATION);
  if (options.providerIdentity !== undefined) {
    builder.overrideProvider(ProviderIdentityPort).useValue(options.providerIdentity);
  }
  if (options.sqsClient !== undefined) {
    builder.overrideProvider(SQSClient).useValue(options.sqsClient);
  }
  const consumerOptions = sqsConsumerOptionsFromEnv(loadEnv());
  builder
    .overrideProvider(SQS_CONSUMER_OPTIONS)
    .useValue(
      options.sqsConsumer === undefined
        ? { ...consumerOptions, enabled: false }
        : { ...consumerOptions, ...options.sqsConsumer, enabled: true },
    );
  const publisherOptions = outboxPublisherOptionsFromEnv(loadEnv());
  builder
    .overrideProvider(OUTBOX_PUBLISHER_OPTIONS)
    .useValue(
      options.outboxPublisher === undefined
        ? { ...publisherOptions, enabled: false }
        : { ...publisherOptions, ...options.outboxPublisher, enabled: true },
    );
  if (options.unitOfWork !== undefined) {
    const overrides = options.unitOfWork;
    builder.overrideProvider(UnitOfWork).useFactory({
      inject: [EntityManager, ConcurrencyMetrics],
      factory: (em: EntityManager, metrics: ConcurrencyMetrics) =>
        new MikroOrmUnitOfWork(em, metrics, { ...unitOfWorkOptionsFromEnv(loadEnv()), ...overrides }),
    });
  }
  const moduleRef = await builder.compile();
  // Mesma configuração de corpo do `main.ts`: só JSON.
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, bodyParser: false });
  app.useBodyParser('json');
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  return app;
}
