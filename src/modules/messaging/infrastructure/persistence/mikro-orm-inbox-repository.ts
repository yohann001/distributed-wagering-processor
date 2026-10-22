import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { assertInTransaction } from '../../../../infrastructure/database/assert-in-transaction';
import { InboxRepository } from '../../application/inbox-repository';
import type { InboxMessage } from '../../domain/inbox-message';
import { InboxMessageSchema, inboxMessageFromRow, inboxMessageToRow } from './inbox-message.persistence';

@Injectable()
export class MikroOrmInboxRepository extends InboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async insert(message: InboxMessage): Promise<void> {
    assertInTransaction(this.em, 'InboxRepository.insert');
    await this.em.insert(InboxMessageSchema, inboxMessageToRow(message));
  }

  async update(message: InboxMessage): Promise<void> {
    assertInTransaction(this.em, 'InboxRepository.update');
    const { consumerName, messageId, processedAt } = inboxMessageToRow(message);
    const affected = await this.em.nativeUpdate(
      InboxMessageSchema,
      { consumerName, messageId },
      { processedAt },
    );
    if (affected !== 1) {
      throw new Error(`Inbox message ${messageId} of consumer ${consumerName} not found for update`);
    }
  }

  async findByKey(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const row = await this.em.findOne(
      InboxMessageSchema,
      { consumerName, messageId },
      { disableIdentityMap: true },
    );
    return row === null ? null : inboxMessageFromRow(row);
  }
}
