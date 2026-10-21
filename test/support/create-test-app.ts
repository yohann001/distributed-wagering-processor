import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';

/** Sobe a aplicação Nest completa contra a infraestrutura real do docker compose. */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  return app;
}
