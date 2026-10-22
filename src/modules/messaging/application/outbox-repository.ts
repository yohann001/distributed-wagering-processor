import type { OutboxMessage } from '../domain/outbox-message';

/** Porta de persistência da outbox. `insert` e `update` exigem transação ativa. */
export abstract class OutboxRepository {
  abstract insert(message: OutboxMessage): Promise<void>;

  /** Grava só `attempts`, `nextAttemptAt` e `publishedAt`. */
  abstract update(message: OutboxMessage): Promise<void>;

  abstract findById(id: string): Promise<OutboxMessage | null>;
}
