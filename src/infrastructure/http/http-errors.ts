import { DomainError } from '../../shared/domain/domain-error';
import { FailureCode } from '../../shared/domain/failure-code';

export interface RequestIssue {
  /** Caminho pontuado com a origem na frente: `body.money`, `params.walletId`, `query.limit`, `headers.idempotency-key`. */
  path: string;
  message: string;
}

/** Requisição fora do contrato (corpo, rota, query ou header): vira `INVALID_PAYLOAD` com a lista de problemas. */
export class InvalidRequestError extends DomainError {
  readonly code = FailureCode.InvalidPayload;

  constructor(readonly issues: RequestIssue[]) {
    super('Invalid request');
  }
}

/** Requisição sem credencial válida para a porta de identidade (§2). A mensagem é fixa e nunca cita a credencial. */
export class UnauthenticatedError extends DomainError {
  readonly code = FailureCode.Unauthenticated;

  constructor() {
    super('Authentication required');
  }
}

/** Recurso consultado que não existe. A mensagem cita só o tipo do recurso, nunca o id. */
export class ResourceNotFoundError extends DomainError {
  constructor(
    readonly code: FailureCode.WalletNotFound | FailureCode.TransactionNotFound,
    resource: string,
  ) {
    super(`${resource} not found`);
  }
}
