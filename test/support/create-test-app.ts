import { SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';

import { AppModule } from '../../src/app.module';
import { LOG_DESTINATION } from '../../src/infrastructure/observability/observability.module';
import { ProviderIdentityPort } from '../../src/shared/application/provider-identity';

const DISCARD_LOG_DESTINATION: DestinationStream = { write: () => undefined };

export interface CreateTestAppOptions {
  /** Destino dos logs do app; sem ele, os logs são descartados para a suíte ficar silenciosa. */
  logDestination?: DestinationStream;
  /** Substitui a porta de identidade; sem ele vale o adapter no-op, que aceita toda requisição. */
  providerIdentity?: ProviderIdentityPort;
  /** Substitui o cliente SQS do app (ex.: endpoint inalcançável nos testes de readiness). */
  sqsClient?: SQSClient;
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
  const moduleRef = await builder.compile();
  // Mesma configuração de corpo do `main.ts`: só JSON.
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, bodyParser: false });
  app.useBodyParser('json');
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  return app;
}
