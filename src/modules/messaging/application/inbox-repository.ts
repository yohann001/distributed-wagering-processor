import type { InboxMessage } from '../domain/inbox-message';

/**
 * Porta de persistência da inbox. `insert` e `update` exigem transação ativa.
 * `insert` lança `InboxMessageAlreadyExistsError` quando `(consumerName, messageId)` já existe (a transação SQL fica abortada).
 */
export abstract class InboxRepository {
  abstract insert(message: InboxMessage): Promise<void>;

  /** Grava só `processedAt`. */
  abstract update(message: InboxMessage): Promise<void>;

  abstract findByKey(consumerName: string, messageId: string): Promise<InboxMessage | null>;
}
