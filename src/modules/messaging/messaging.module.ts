import { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';

import { loadEnv } from '../../config/env';
import { InboxRepository } from './application/inbox-repository';
import { MessageQueue } from './application/message-queue';
import { OutboxRepository } from './application/outbox-repository';
import { MikroOrmInboxRepository } from './infrastructure/persistence/mikro-orm-inbox-repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/mikro-orm-outbox-repository';
import { buildSqsClient } from './infrastructure/sqs/sqs-client';
import { SqsMessageQueue } from './infrastructure/sqs/sqs-message-queue';

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
  ],
  exports: [InboxRepository, OutboxRepository, MessageQueue],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(private readonly sqsClient: SQSClient) {}

  // Fecha os sockets do agente HTTP do SDK no SIGTERM e no `app.close()`.
  onApplicationShutdown(): void {
    this.sqsClient.destroy();
  }
}
