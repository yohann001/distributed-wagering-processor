import { EntitySchema } from '@mikro-orm/core';

import { OutboxMessage } from '../../domain/outbox-message';

// Row + mapper em vez de mapear a classe de domínio direto (§6.1): o estado é `private _campo` com
// getters e cópia defensiva de Date, e o payload do domínio é congelado em profundidade (o MikroORM não
// pode anotar um objeto congelado). O mapper só reconstrói pelo `rehydrate`, que não revalida (§6.0).

export interface OutboxMessageRow {
  id: string;
  aggregateId: string;
  eventType: string;
  /** Coluna `json` (não `jsonb`): preserva a ordem das chaves do envelope até a fila. */
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  name: 'OutboxMessageRow',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string', columnType: 'text' },
    payload: { type: 'json', columnType: 'json' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz' },
    publishedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});

export function outboxMessageToRow(message: OutboxMessage): OutboxMessageRow {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    // Cópia mutável: o MikroORM escreve nos parâmetros ao processá-los, e o payload do domínio é congelado.
    payload: structuredClone(message.payload),
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt ?? null,
  };
}

export function outboxMessageFromRow(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    publishedAt: row.publishedAt ?? undefined,
  });
}
