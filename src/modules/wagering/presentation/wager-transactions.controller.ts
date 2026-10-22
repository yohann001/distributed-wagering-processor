import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';

import { CorrelationId } from '../../../infrastructure/http/correlation-id.decorator';
import type { HttpResponse } from '../../../infrastructure/http/http-exception-filter';
import { ResourceNotFoundError } from '../../../infrastructure/http/http-errors';
import { parseRequest } from '../../../infrastructure/http/request-schemas';
import { LogContext } from '../../../infrastructure/observability/log-context';
import { FailureCode } from '../../../shared/domain/failure-code';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import { WagerTransactionQueries } from '../application/wager-transaction-queries';
import {
  externalIdParams,
  httpStatusForTransaction,
  idempotencyKeyHeaders,
  toSubmitCommandFields,
  toSubmitResponse,
  toTransactionResponse,
  transactionIdParams,
  wagerTransactionPayloadSchema,
  type SubmitResponse,
  type TransactionResponse,
} from './wager-transaction-http.schemas';

function transactionNotFound(): ResourceNotFoundError {
  return new ResourceNotFoundError(FailureCode.TransactionNotFound, 'transaction');
}

@Controller()
export class WagerTransactionsController {
  constructor(
    private readonly submitWager: SubmitWagerTransaction,
    private readonly transactionQueries: WagerTransactionQueries,
    private readonly logContext: LogContext,
  ) {}

  /**
   * O status vem do estado decidido: 200 `PROCESSED`, 202 `PENDING_REFERENCE`, 422 `REJECTED`. O replay devolve
   * o mesmo status e o mesmo corpo, só com `idempotentReplay: true`.
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers() headers: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SubmitResponse> {
    const { 'idempotency-key': idempotencyKey } = parseRequest('headers', idempotencyKeyHeaders, headers);
    const fields = toSubmitCommandFields(parseRequest('body', wagerTransactionPayloadSchema, body));
    this.logContext.assign({ walletId: fields.walletId, providerId: fields.providerId });

    const result = await this.submitWager.execute({ ...fields, idempotencyKey, correlationId });
    this.logContext.assign({ transactionId: result.transaction.id });

    response.status(httpStatusForTransaction(result.transaction.status));
    return toSubmitResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param() params: unknown): Promise<TransactionResponse> {
    const { transactionId } = parseRequest('params', transactionIdParams, params);
    this.logContext.assign({ transactionId });
    const transaction = await this.transactionQueries.getById(transactionId);
    if (transaction === null) {
      throw transactionNotFound();
    }
    return toTransactionResponse(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param() params: unknown): Promise<TransactionResponse> {
    const { providerId, externalTransactionId } = parseRequest('params', externalIdParams, params);
    this.logContext.assign({ providerId });
    const transaction = await this.transactionQueries.getByExternalId(providerId, externalTransactionId);
    if (transaction === null) {
      throw transactionNotFound();
    }
    return toTransactionResponse(transaction);
  }
}
