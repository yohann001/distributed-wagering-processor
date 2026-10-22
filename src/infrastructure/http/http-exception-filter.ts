import { DriverException } from '@mikro-orm/core';
import { Catch, Injectable, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';

import { DatabaseError } from '../database/mikro-orm-unit-of-work';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_RESPONSE_HEADER,
  resolveCorrelationId,
} from '../observability/correlation-id';
import { LogContext } from '../observability/log-context';
import { mapErrorToHttp } from './http-error-mapping';

/** O pedaço do `Response` do Express que a borda usa. `@types/express` não é dependência do projeto. */
export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}

/** O pedaço do `Request` do Express que o filtro lê. */
interface HttpRequest {
  id?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/** O `DriverException` cru traz o SQL com os valores interpolados (§12): só o `DatabaseError` sanitizado vai para o log. */
function safeError(error: unknown): unknown {
  return error instanceof DriverException ? new DatabaseError(error) : error;
}

/**
 * Filtro global: todo erro que chega à borda HTTP vira o mesmo corpo `{ failureCode, action, message, issues? }`,
 * com o status vindo de uma única tabela (`mapErrorToHttp`). Loga só 5xx e 503, sem corpo nem headers da requisição.
 */
@Catch()
@Injectable()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logContext: LogContext) {}

  catch(error: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw error;
    }
    const http = host.switchToHttp();
    const response = http.getResponse<HttpResponse>();
    const request = http.getRequest<HttpRequest>();
    const mapped = mapErrorToHttp(error);

    // O body-parser do Express roda antes do pino-http: num JSON malformado `req.id` não existe e o header não foi definido.
    if (typeof request.id !== 'string') {
      response.setHeader(CORRELATION_ID_RESPONSE_HEADER, resolveCorrelationId(request.headers[CORRELATION_ID_HEADER]));
    }

    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    response.status(mapped.status).json(mapped.body);

    if (mapped.logLevel !== 'none') {
      const fields = { err: safeError(error), failureCode: mapped.body.failureCode, statusCode: mapped.status };
      this.logContext.current()[mapped.logLevel](fields, 'request failed');
    }
  }
}
