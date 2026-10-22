import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';

/**
 * Erro de programação: eventos são montados pelo domínio a partir de objetos já decididos.
 * Um evento inválido indica bug no caso de uso, não payload errado.
 */
export class InvalidIntegrationEventError extends DomainError {
  readonly code = FailureCode.InvariantViolation;

  constructor(reason: string) {
    super(`Invalid integration event: ${reason}`);
  }
}

/** Ids e tempo vêm de quem chama (portas IdGenerator e Clock): o domínio não gera nem lê o relógio. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601 em UTC. */
  occurredAt: string;
  version: number;
  data: Readonly<T>;
}

function deepFreeze<V>(value: V): V {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function assertNonEmpty(field: string, value: unknown): void {
  if (typeof value !== 'string' || value === '') {
    throw new InvalidIntegrationEventError(`${field} must be a non-empty string`);
  }
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;

  /** Cópia própria: Date é mutável mesmo atrás de readonly. */
  private readonly _occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    const { eventId, aggregateId, correlationId, causationId, occurredAt, data } = props;
    assertNonEmpty('eventId', eventId);
    assertNonEmpty('aggregateId', aggregateId);
    assertNonEmpty('correlationId', correlationId);
    if (causationId !== undefined) {
      assertNonEmpty('causationId', causationId);
    }
    if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
      throw new InvalidIntegrationEventError('occurredAt must be a valid date');
    }

    this.eventId = eventId;
    this.aggregateId = aggregateId;
    this.correlationId = correlationId;
    this.causationId = causationId;
    this._occurredAt = new Date(occurredAt.getTime());
    this.data = deepFreeze(data);
    // Sem Object.freeze(this): os campos eventType e version da subclasse são inicializados depois do super().
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  /**
   * Envelope gravado no payload da outbox. A ordem das chaves é fixa e `causationId` é omitido
   * quando ausente, para que o mesmo evento gere sempre a mesma string.
   */
  toJSON(): IntegrationEventJson<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
