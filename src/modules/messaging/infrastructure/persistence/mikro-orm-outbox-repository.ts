import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { assertInTransaction } from '../../../../infrastructure/database/assert-in-transaction';
import { OutboxRepository } from '../../application/outbox-repository';
import type { OutboxMessage } from '../../domain/outbox-message';
import {
  OutboxMessageSchema,
  outboxMessageFromRow,
  outboxMessageToRow,
} from './outbox-message.persistence';

@Injectable()
export class MikroOrmOutboxRepository extends OutboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async insert(message: OutboxMessage): Promise<void> {
    assertInTransaction(this.em, 'OutboxRepository.insert');
    await this.em.insert(OutboxMessageSchema, outboxMessageToRow(message));
  }

  async update(message: OutboxMessage): Promise<void> {
    assertInTransaction(this.em, 'OutboxRepository.update');
    const { attempts, nextAttemptAt, publishedAt } = outboxMessageToRow(message);
    const affected = await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      { attempts, nextAttemptAt, publishedAt },
    );
    if (affected !== 1) {
      throw new Error(`Outbox message ${message.id} not found for update`);
    }
  }

  async findById(id: string): Promise<OutboxMessage | null> {
    const row = await this.em.findOne(OutboxMessageSchema, { id }, { disableIdentityMap: true });
    return row === null ? null : outboxMessageFromRow(row);
  }
}
