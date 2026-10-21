import { FailureCode, failureActionOf, type FailureAction } from './failure-code';

export abstract class DomainError extends Error {
  abstract readonly code: FailureCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }

  get action(): FailureAction {
    return failureActionOf(this.code);
  }
}

/** Erro de programação: transição a partir de um estado que não a permite (ex.: estado terminal). */
export class InvalidTransactionStateError extends DomainError {
  readonly code = FailureCode.InvariantViolation;

  constructor(
    readonly transactionId: string,
    readonly currentStatus: string,
    readonly attemptedTransition: string,
  ) {
    super(
      `Invalid transition '${attemptedTransition}' for transaction ${transactionId} in status ${currentStatus}`,
    );
  }
}
