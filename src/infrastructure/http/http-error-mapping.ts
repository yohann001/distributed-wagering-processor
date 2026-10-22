import { HttpException } from '@nestjs/common';

import { InvalidQueryError } from '../../shared/application/invalid-query-error';
import { DomainError } from '../../shared/domain/domain-error';
import { FailureCode, failureActionOf, type FailureAction } from '../../shared/domain/failure-code';
import { isTransientDatabaseFailure } from '../database/mikro-orm-unit-of-work';
import { InvalidRequestError, type RequestIssue } from './http-errors';

/** Espera sugerida ao cliente em `Retry-After` quando a falha é transitória. */
export const RETRY_AFTER_SECONDS = 1;

/**
 * Status HTTP por `FailureCode`, exaustivo: um código novo não compila até ser mapeado. A tabela vale para
 * erros (exceções). As linhas 422 existem por completude: uma rejeição de negócio normalmente chega como
 * `REJECTED` persistido, e a rota de submissão escolhe o status pelo estado da transação.
 */
export const HTTP_STATUS_BY_FAILURE_CODE: Readonly<Record<FailureCode, number>> = Object.freeze({
  [FailureCode.InvalidPayload]: 400,
  [FailureCode.InvalidMoney]: 400,
  [FailureCode.CurrencyMismatch]: 400,
  [FailureCode.KindNotAllowed]: 400,
  [FailureCode.ReferenceRequired]: 400,
  [FailureCode.Unauthenticated]: 401,
  [FailureCode.IdempotencyConflict]: 409,
  [FailureCode.WalletAlreadyExists]: 409,
  [FailureCode.WalletNotFound]: 404,
  [FailureCode.TransactionNotFound]: 404,
  [FailureCode.WalletPlayerMismatch]: 422,
  [FailureCode.InsufficientFunds]: 422,
  [FailureCode.ReversalInsufficientFunds]: 422,
  [FailureCode.ReferenceNotFound]: 422,
  [FailureCode.ReferenceMismatch]: 422,
  [FailureCode.InvalidReferenceKind]: 422,
  [FailureCode.ReferenceAmountMismatch]: 422,
  [FailureCode.ReferenceNotProcessed]: 422,
  [FailureCode.AlreadyReversed]: 422,
  [FailureCode.TransientFailure]: 503,
  [FailureCode.PermanentFailure]: 500,
  [FailureCode.InvariantViolation]: 500,
});

export interface HttpErrorBody {
  failureCode: FailureCode;
  action: FailureAction;
  message: string;
  issues?: RequestIssue[];
}

export interface HttpErrorResponse {
  status: number;
  body: HttpErrorBody;
  retryAfterSeconds?: number;
  logLevel: 'none' | 'warn' | 'error';
}

const TRANSIENT_MESSAGE = 'Temporary failure, retry the same request';
const INTERNAL_MESSAGE = 'Internal error';

function bodyOf(failureCode: FailureCode, message: string): HttpErrorBody {
  return { failureCode, action: failureActionOf(failureCode), message };
}

function transient(): HttpErrorResponse {
  return {
    status: HTTP_STATUS_BY_FAILURE_CODE[FailureCode.TransientFailure],
    body: bodyOf(FailureCode.TransientFailure, TRANSIENT_MESSAGE),
    retryAfterSeconds: RETRY_AFTER_SECONDS,
    logLevel: 'warn',
  };
}

function internal(failureCode: FailureCode): HttpErrorResponse {
  return { status: 500, body: bodyOf(failureCode, INTERNAL_MESSAGE), logLevel: 'error' };
}

function fromDomainError(error: DomainError): HttpErrorResponse {
  const status = HTTP_STATUS_BY_FAILURE_CODE[error.code];
  if (status === 503) {
    return transient();
  }
  if (status >= 500) {
    return internal(error.code);
  }
  const body = bodyOf(error.code, error.message);
  if (error instanceof InvalidRequestError) {
    body.issues = error.issues;
  } else if (error instanceof InvalidQueryError) {
    // Mesmo formato do zod da borda: o parâmetro validado depois (faixa do `limit`, cursor) também sai em `issues`.
    body.issues = [{ path: `query.${error.field}`, message: error.detail }];
  }
  return { status, body, logLevel: 'none' };
}

/** A mensagem do framework pode citar o corpo recebido, então nunca é repetida na resposta. */
function fromFrameworkError(error: HttpException): HttpErrorResponse {
  const status = error.getStatus();
  if (status >= 500) {
    return internal(FailureCode.InvariantViolation);
  }
  const message = status === 404 ? 'Route not found' : 'Malformed request';
  return { status, body: bodyOf(FailureCode.InvalidPayload, message), logLevel: 'none' };
}

const CLIENT_ERROR_MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  413: 'Request body too large',
  415: 'Unsupported content type, charset or encoding',
});

/**
 * Erro 4xx do body-parser (pacote `http-errors`: 413 corpo grande, 415 charset ou encoding, 400 corpo abortado).
 * O Nest só converte `SyntaxError` em `BadRequestException`; os demais chegam aqui crus, com `status` e
 * `expose: true`. A mensagem original não é repetida: ela pode citar o corpo.
 */
function clientErrorStatusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const { status, expose } = error as { status?: unknown; expose?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && expose === true ? status : null;
}

/** Único ponto que decide status, corpo, `Retry-After` e nível de log de um erro que chegou à borda HTTP. */
export function mapErrorToHttp(error: unknown): HttpErrorResponse {
  // Antes da checagem transitória: um socket do cliente que cai no meio do corpo chega como 400 do body-parser
  // com o `code` do socket (`ECONNRESET`), que não é falha do banco.
  const clientStatus = clientErrorStatusOf(error);
  if (clientStatus !== null) {
    const message = CLIENT_ERROR_MESSAGES[clientStatus] ?? 'Malformed request';
    return { status: clientStatus, body: bodyOf(FailureCode.InvalidPayload, message), logLevel: 'none' };
  }
  if (isTransientDatabaseFailure(error)) {
    return transient();
  }
  if (error instanceof DomainError) {
    return fromDomainError(error);
  }
  if (error instanceof HttpException) {
    return fromFrameworkError(error);
  }
  return internal(FailureCode.InvariantViolation);
}
