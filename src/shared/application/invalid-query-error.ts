import { DomainError } from '../domain/domain-error';
import { FailureCode } from '../domain/failure-code';

/** Parâmetro de leitura inválido (cursor, limit): vira `INVALID_PAYLOAD`, como qualquer requisição malformada. */
export class InvalidQueryError extends DomainError {
  readonly code = FailureCode.InvalidPayload;

  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(`Invalid query parameter '${field}': ${detail}`);
  }
}
