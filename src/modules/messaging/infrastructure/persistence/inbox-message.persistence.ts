import { EntitySchema } from '@mikro-orm/core';

import { InboxMessage } from '../../domain/inbox-message';

// Row + mapper em vez de mapear a classe de domínio direto (§6.1): o estado é `private _campo` com
// getters e cópia defensiva de Date. O mapper só reconstrói pelo `rehydrate`, que não revalida (§6.0).

export interface InboxMessageRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  name: 'InboxMessageRow',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', columnType: 'text', primary: true },
    messageId: { type: 'string', columnType: 'text', primary: true },
    payloadHash: { type: 'string', columnType: 'text' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz' },
    processedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
  },
});

export function inboxMessageToRow(message: InboxMessage): InboxMessageRow {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function inboxMessageFromRow(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });
}
