import { DomainError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';

/** Erro de programação: o consumidor chamou a entidade com argumentos ou estado incoerentes. */
export class InvalidInboxMessageError extends DomainError {
  readonly code = FailureCode.InvariantViolation;

  constructor(reason: string) {
    super(`Invalid inbox message: ${reason}`);
  }
}

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

function assertNonEmpty(field: string, value: unknown): void {
  if (typeof value !== 'string' || value === '') {
    throw new InvalidInboxMessageError(`${field} must be a non-empty string`);
  }
}

function assertValidDate(field: string, value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidInboxMessageError(`${field} must be a valid date`);
  }
}

export class InboxMessage {
  private readonly _receivedAt: Date;
  private _processedAt: Date | undefined;

  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    receivedAt: Date,
    processedAt: Date | undefined,
  ) {
    this._receivedAt = new Date(receivedAt.getTime());
    this._processedAt = processedAt === undefined ? undefined : new Date(processedAt.getTime());
  }

  /**
   * Mensagem recebida, ainda não processada. A chave de deduplicação é (consumerName, messageId),
   * garantida pela PK no banco (T10); a entidade não deduplica.
   */
  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty('messageId', props.messageId);
    assertNonEmpty('consumerName', props.consumerName);
    assertNonEmpty('payloadHash', props.payloadHash);
    assertValidDate('receivedAt', props.receivedAt);
    return InboxMessage.rehydrate({ ...props, processedAt: undefined });
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt.getTime());
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt.getTime());
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  // ---- transições

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxMessageError(
        `message ${this.messageId} for consumer ${this.consumerName} is already processed`,
      );
    }
    assertValidDate('processedAt', at);
    this._processedAt = new Date(at.getTime());
  }
}
