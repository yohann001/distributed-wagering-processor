import { EntityManager } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import { loadEnv } from '../config/env';
import { LogContext } from '../infrastructure/observability/log-context';
import { MessageQueue } from '../modules/messaging/application/message-queue';
import { postgresCheck, sqsCheck } from './dependency-checks';
import { HealthController } from './health.controller';
import { ReadinessProbe, type ReadinessFailure } from './readiness';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: ReadinessProbe,
      inject: [EntityManager, MessageQueue, LogContext],
      useFactory: (em: EntityManager, queue: MessageQueue, logContext: LogContext) =>
        new ReadinessProbe(
          [postgresCheck(em), sqsCheck(queue)],
          loadEnv().HEALTH_CHECK_TIMEOUT_MS,
          (failure: ReadinessFailure) => logContext.current().warn(failure, 'readiness check failed'),
        ),
    },
  ],
})
export class HealthModule {}
