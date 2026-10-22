import { Module } from '@nestjs/common';

import { InboxRepository } from './application/inbox-repository';
import { OutboxRepository } from './application/outbox-repository';
import { MikroOrmInboxRepository } from './infrastructure/persistence/mikro-orm-inbox-repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/mikro-orm-outbox-repository';

@Module({
  providers: [
    { provide: InboxRepository, useClass: MikroOrmInboxRepository },
    { provide: OutboxRepository, useClass: MikroOrmOutboxRepository },
  ],
  exports: [InboxRepository, OutboxRepository],
})
export class MessagingModule {}
