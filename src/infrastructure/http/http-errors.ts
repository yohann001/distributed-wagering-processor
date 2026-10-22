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

/** Recurso consultado que não existe. A mensagem cita só o tipo do recurso, nunca o id. */
export class ResourceNotFoundError extends DomainError {
  constructor(
    readonly code: FailureCode.WalletNotFound | FailureCode.TransactionNotFound,
    resource: string,
  ) {
    super(`${resource} not found`);
  }
}
