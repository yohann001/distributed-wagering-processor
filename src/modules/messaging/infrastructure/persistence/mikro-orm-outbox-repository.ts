import { LockMode } from '@mikro-orm/core';
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

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    assertInTransaction(this.em, 'OutboxRepository.claimDue');
    // PESSIMISTIC_PARTIAL_WRITE = FOR UPDATE SKIP LOCKED: as linhas que outro publisher já travou são puladas, nunca
    // esperadas. Linhas ainda não commitadas são invisíveis (READ COMMITTED), então nada é publicado antes do commit (§5.4).
    const rows = await this.em.find(
      OutboxMessageSchema,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        disableIdentityMap: true,
      },
    );
    return rows.map(outboxMessageFromRow);
  }

  async oldestPendingOccurredAt(): Promise<Date | null> {
    // O MikroORM devolve `timestamptz` cru como texto em `execute`: milissegundos desde a época evitam parsear o formato.
    const [row] = await this.em.execute<{ oldest_ms: string | null }[]>(
      'select (extract(epoch from min(occurred_at)) * 1000)::bigint::text as oldest_ms from outbox_messages where published_at is null',
    );
    const oldestMs = row?.oldest_ms;
    return oldestMs === undefined || oldestMs === null ? null : new Date(Number(oldestMs));
  }
}
