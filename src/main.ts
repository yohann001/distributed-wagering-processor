import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  // `bufferLogs` segura os logs do boot do Nest até o logger do pino assumir. `bodyParser: false` desliga o
  // parser urlencoded padrão: a API só aceita JSON, e um formulário cross-site (sem preflight) não vira corpo.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.useBodyParser('json');
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
}

await bootstrap();
