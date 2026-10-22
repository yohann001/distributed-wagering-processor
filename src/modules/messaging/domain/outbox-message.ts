import { DomainError } from '../../../shared/domain/domain-error';
import type {
  ExponentialBackoff,
  ExponentialBackoffOptions,
} from '../../../shared/domain/exponential-backoff';
import { FailureCode } from '../../../shared/domain/failure-code';
import { deepFreeze, type IntegrationEvent } from '../../../shared/domain/integration-event';

/** Erro de programação: o publisher chamou a entidade com argumentos ou estado incoerentes. */
export class InvalidOutboxMessageError extends DomainError {
  readonly code = FailureCode.InvariantViolation;

  constructor(reason: string) {
    super(`Invalid outbox message: ${reason}`);
  }
}

/**
 * Padrão do publisher (T23): 1 s, dobrando até 60 s, com até 50% de jitter.
 * Sem limite de tentativas: evento confirmado nunca é descartado.
 */
export const DEFAULT_OUTBOX_BACKOFF: Readonly<ExponentialBackoffOptions> = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.5,
});

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date | undefined;
}

function assertValidDate(field: string, value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidOutboxMessageError(`${field} must be a valid date`);
  }
}

function frozenJsonCopy(value: unknown): Readonly<Record<string, unknown>> {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
}

export class OutboxMessage {
  private readonly _occurredAt: Date;
  private _nextAttemptAt: Date;
  private _publishedAt: Date | undefined;

  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    occurredAt: Date,
    private _attempts: number,
    nextAttemptAt: Date,
    publishedAt: Date | undefined,
  ) {
    this._occurredAt = new Date(occurredAt.getTime());
    this._nextAttemptAt = new Date(nextAttemptAt.getTime());
    this._publishedAt = publishedAt === undefined ? undefined : new Date(publishedAt.getTime());
  }

  /**
   * Evento pronto para publicar. id = eventId: o consumidor deduplica pelo eventId, e o mesmo id
   * na outbox evita enfileirar o mesmo evento duas vezes.
   */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // Cópia JSON do envelope (§11), exatamente o que vai para o jsonb e para a fila; também resolve
    // o pitfall interface -> Record.
    const payload = frozenJsonCopy(event);
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
    });
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    // Cópia própria: a entidade nunca congela um objeto que não é dela.
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      frozenJsonCopy(state.payload),
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  get nextAttemptAt(): Date {
    return new Date(this._nextAttemptAt.getTime());
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt === undefined ? undefined : new Date(this._publishedAt.getTime());
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    assertValidDate('now', now);
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  // ---- transições

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    assertValidDate('publishedAt', at);
    this._publishedAt = new Date(at.getTime());
  }

  /**
   * Incrementa attempts e calcula o próximo nextAttemptAt (backoff). O backoff é injetado porque o
   * jitter precisa de aleatoriedade, que o domínio não gera.
   */
  scheduleRetry(now: Date, backoff: ExponentialBackoff): void {
    this.assertPending('scheduleRetry');
    assertValidDate('now', now);
    const delay = backoff.delayMs(this._attempts + 1);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  private assertPending(transition: string): void {
    if (!this.isPending()) {
      throw new InvalidOutboxMessageError(`message ${this.id} is already published (${transition})`);
    }
  }
}
