import { SQSClient } from '@aws-sdk/client-sqs';
import {
  Global,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Registry } from 'prom-client';

import { loadEnv } from '../../config/env';
import { LogContext } from '../../infrastructure/observability/log-context';
import { SubmitWagerTransaction } from '../wagering/application/submit-wager-transaction';
import { InboxRepository } from './application/inbox-repository';
import { MessageQueue } from './application/message-queue';
import { OutboxRepository } from './application/outbox-repository';
import { MikroOrmInboxRepository } from './infrastructure/persistence/mikro-orm-inbox-repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/mikro-orm-outbox-repository';
import { buildSqsClient } from './infrastructure/sqs/sqs-client';
import {
  SQS_CONSUMER_OPTIONS,
  sqsConsumerOptionsFromEnv,
  type SqsConsumerOptions,
} from './infrastructure/sqs/sqs-consumer-options';
import { SqsMessageQueue } from './infrastructure/sqs/sqs-message-queue';
import { SqsWagerTransactionConsumer } from './infrastructure/sqs/sqs-wager-transaction-consumer';

@Global()
@Module({
  providers: [
    { provide: InboxRepository, useClass: MikroOrmInboxRepository },
    { provide: OutboxRepository, useClass: MikroOrmOutboxRepository },
    { provide: SQSClient, useFactory: (): SQSClient => buildSqsClient(loadEnv()) },
    {
      provide: MessageQueue,
      inject: [SQSClient],
      useFactory: (client: SQSClient): MessageQueue => new SqsMessageQueue(client, loadEnv().SQS_WAGER_QUEUE_URL),
    },
    { provide: SQS_CONSUMER_OPTIONS, useFactory: (): SqsConsumerOptions => sqsConsumerOptionsFromEnv(loadEnv()) },
    {
      provide: SqsWagerTransactionConsumer,
      inject: [SQSClient, SubmitWagerTransaction, SQS_CONSUMER_OPTIONS, LogContext, Registry],
      useFactory: (
        client: SQSClient,
        submit: SubmitWagerTransaction,
        options: SqsConsumerOptions,
        logContext: LogContext,
        registry: Registry,
      ): SqsWagerTransactionConsumer => new SqsWagerTransactionConsumer(client, submit, options, logContext, registry),
    },
  ],
  exports: [InboxRepository, OutboxRepository, MessageQueue],
})
export class MessagingModule implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    private readonly sqsClient: SQSClient,
    private readonly consumer: SqsWagerTransactionConsumer,
  ) {}

  onApplicationBootstrap(): void {
    this.consumer.start();
  }

  // Todo `beforeApplicationShutdown` roda antes de qualquer `onApplicationShutdown`: o drain ainda tem o banco
  // (o MikroORM fecha no `onApplicationShutdown` dele) e o SQS (fechado no `onApplicationShutdown` abaixo).
  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }

  // Fecha os sockets do agente HTTP do SDK no SIGTERM e no `app.close()`.
  onApplicationShutdown(): void {
    this.sqsClient.destroy();
  }
}
