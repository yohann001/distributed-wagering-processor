import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';

import { AppModule } from '../../src/app.module';
import { LOG_DESTINATION } from '../../src/infrastructure/observability/observability.module';

const DISCARD_LOG_DESTINATION: DestinationStream = { write: () => undefined };

export interface CreateTestAppOptions {
  /** Destino dos logs do app; sem ele, os logs são descartados para a suíte ficar silenciosa. */
  logDestination?: DestinationStream;
}

/** Sobe a aplicação Nest completa contra a infraestrutura real do docker compose. */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LOG_DESTINATION)
    .useValue(options.logDestination ?? DISCARD_LOG_DESTINATION)
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  return app;
}
