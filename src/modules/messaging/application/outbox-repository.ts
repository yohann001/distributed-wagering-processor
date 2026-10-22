import type { OutboxMessage } from '../domain/outbox-message';

/** Porta de persistência da outbox. `insert`, `update` e `claimDue` exigem transação ativa. */
export abstract class OutboxRepository {
  abstract insert(message: OutboxMessage): Promise<void>;

  /** Grava só `attempts`, `nextAttemptAt` e `publishedAt`. */
  abstract update(message: OutboxMessage): Promise<void>;

  abstract findById(id: string): Promise<OutboxMessage | null>;

  /** Pendentes vencidas (`next_attempt_at <= now`), mais antigas primeiro, travadas com FOR UPDATE SKIP LOCKED. Exige transação ativa. */
  abstract claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;

  /** `occurred_at` da pendente mais antiga (vencida ou não), ou `null` sem pendentes. */
  abstract oldestPendingOccurredAt(): Promise<Date | null>;
}
