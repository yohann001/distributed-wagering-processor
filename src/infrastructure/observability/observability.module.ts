import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import pino from 'pino';
import { Registry, collectDefaultMetrics } from 'prom-client';

import { loadEnv, type Env } from '../../config/env';
import { LogContext } from './log-context';
import {
  LOG_DESTINATION,
  ROOT_LOGGER,
  buildLoggerOptions,
  buildPinoHttpOptions,
} from './logger.config';
import { MetricsController } from './metrics.controller';

export { LOG_DESTINATION, ROOT_LOGGER };

/**
 * `Registry` próprio do app, nunca o global do prom-client: um segundo app no mesmo processo
 * (testes) lançaria "metric already registered". As tasks seguintes injetam o `Registry` e criam
 * as métricas de negócio nele.
 */
export function buildMetricsRegistry(env: Pick<Env, 'INSTANCE_ID'>): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ instance_id: env.INSTANCE_ID });
  collectDefaultMetrics({ register: registry });
  return registry;
}

/** Um `ROOT_LOGGER` por app, construído a partir de `LOG_DESTINATION` (stdout; os testes trocam o destino). */
@Module({
  providers: [
    { provide: LOG_DESTINATION, useFactory: (): pino.DestinationStream => pino.destination(1) },
    {
      provide: ROOT_LOGGER,
      inject: [LOG_DESTINATION],
      useFactory: (destination: pino.DestinationStream): pino.Logger =>
        pino(buildLoggerOptions(loadEnv()), destination),
    },
  ],
  exports: [LOG_DESTINATION, ROOT_LOGGER],
})
class LoggerRootModule {}

@Global()
@Module({
  imports: [
    LoggerRootModule,
    LoggerModule.forRootAsync({
      imports: [LoggerRootModule],
      inject: [ROOT_LOGGER],
      useFactory: (logger: pino.Logger) => ({ pinoHttp: buildPinoHttpOptions(logger) }),
    }),
  ],
  providers: [{ provide: Registry, useFactory: () => buildMetricsRegistry(loadEnv()) }, LogContext],
  controllers: [MetricsController],
  exports: [Registry, LogContext, LoggerRootModule],
})
export class ObservabilityModule {}
