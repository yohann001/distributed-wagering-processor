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
import { Clock } from '../../shared/application/clock';
import { UnitOfWork } from '../../shared/application/unit-of-work';
import { ExponentialBackoff } from '../../shared/domain/exponential-backoff';
import { SubmitWagerTransaction } from '../wagering/application/submit-wager-transaction';
import { InboxRepository } from './application/inbox-repository';
import { IntegrationEventPublisher } from './application/integration-event-publisher';
import { MessageQueue } from './application/message-queue';
import { OutboxRepository } from './application/outbox-repository';
import { PublishOutboxBatch } from './application/publish-outbox-batch';
import { DEFAULT_OUTBOX_BACKOFF } from './domain/outbox-message';
import {
  OUTBOX_PUBLISHER_OPTIONS,
  outboxPublisherOptionsFromEnv,
  type OutboxPublisherOptions,
} from './infrastructure/outbox/outbox-publisher-options';
import { OutboxPublisherWorker } from './infrastructure/outbox/outbox-publisher-worker';
import { MikroOrmInboxRepository } from './infrastructure/persistence/mikro-orm-inbox-repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/mikro-orm-outbox-repository';
import { buildSqsClient } from './infrastructure/sqs/sqs-client';
import {
  SQS_CONSUMER_OPTIONS,
  sqsConsumerOptionsFromEnv,
  type SqsConsumerOptions,
} from './infrastructure/sqs/sqs-consumer-options';
import { SqsIntegrationEventPublisher } from './infrastructure/sqs/sqs-integration-event-publisher';
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
    {
      provide: OUTBOX_PUBLISHER_OPTIONS,
      useFactory: (): OutboxPublisherOptions => outboxPublisherOptionsFromEnv(loadEnv()),
    },
    {
      provide: IntegrationEventPublisher,
      inject: [SQSClient, OUTBOX_PUBLISHER_OPTIONS],
      useFactory: (client: SQSClient, options: OutboxPublisherOptions): IntegrationEventPublisher =>
        new SqsIntegrationEventPublisher(client, options.queueUrl, options.publishTimeoutMs),
    },
    {
      provide: PublishOutboxBatch,
      inject: [UnitOfWork, OutboxRepository, IntegrationEventPublisher, Clock, OUTBOX_PUBLISHER_OPTIONS],
      useFactory: (
        uow: UnitOfWork,
        outbox: OutboxRepository,
        publisher: IntegrationEventPublisher,
        clock: Clock,
        options: OutboxPublisherOptions,
      ): PublishOutboxBatch =>
        new PublishOutboxBatch(
          uow,
          outbox,
          publisher,
          clock,
          new ExponentialBackoff(DEFAULT_OUTBOX_BACKOFF, Math.random),
          options.batchSize,
        ),
    },
    {
      provide: OutboxPublisherWorker,
      inject: [PublishOutboxBatch, OutboxRepository, Clock, OUTBOX_PUBLISHER_OPTIONS, LogContext, Registry],
      useFactory: (
        publishBatch: PublishOutboxBatch,
        outbox: OutboxRepository,
        clock: Clock,
        options: OutboxPublisherOptions,
        logContext: LogContext,
        registry: Registry,
      ): OutboxPublisherWorker => new OutboxPublisherWorker(publishBatch, outbox, clock, options, logContext, registry),
    },
  ],
  exports: [InboxRepository, OutboxRepository, MessageQueue, PublishOutboxBatch],
})
export class MessagingModule implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    private readonly sqsClient: SQSClient,
    private readonly consumer: SqsWagerTransactionConsumer,
    private readonly outboxPublisher: OutboxPublisherWorker,
  ) {}

  onApplicationBootstrap(): void {
    this.consumer.start();
    this.outboxPublisher.start();
  }

  // Todo `beforeApplicationShutdown` roda antes de qualquer `onApplicationShutdown`: o drain do consumer e o ciclo em
  // andamento do publisher ainda têm o banco (o MikroORM fecha no `onApplicationShutdown` dele) e o SQS (fechado no
  // `onApplicationShutdown` abaixo).
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer.stop(), this.outboxPublisher.stop()]);
  }

  // Fecha os sockets do agente HTTP do SDK no SIGTERM e no `app.close()`.
  onApplicationShutdown(): void {
    this.sqsClient.destroy();
  }
}
