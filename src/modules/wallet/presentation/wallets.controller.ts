import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';

import { CorrelationId } from '../../../infrastructure/http/correlation-id.decorator';
import { ResourceNotFoundError } from '../../../infrastructure/http/http-errors';
import { moneyFrom, parseRequest } from '../../../infrastructure/http/request-schemas';
import { FailureCode } from '../../../shared/domain/failure-code';
import { OpenWallet } from '../application/open-wallet';
import { ReconcileWallet } from '../application/reconcile-wallet';
import { WalletQueries, type ListLedgerQuery } from '../application/wallet-queries';
import {
  ledgerQuery,
  openWalletBody,
  toLedgerPageResponse,
  toReconciliationResponse,
  toWalletResponse,
  walletParams,
  type LedgerPageResponse,
  type ReconciliationResponse,
  type WalletResponse,
} from './wallet-http.schemas';

function walletNotFound(): ResourceNotFoundError {
  return new ResourceNotFoundError(FailureCode.WalletNotFound, 'wallet');
}

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly walletQueries: WalletQueries,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async open(@Body() body: unknown, @CorrelationId() correlationId: string): Promise<WalletResponse> {
    const { playerId, initialBalance } = parseRequest('body', openWalletBody, body);
    const wallet = await this.openWallet.execute({
      playerId,
      initialBalance: moneyFrom(initialBalance),
      correlationId,
    });
    return toWalletResponse(wallet);
  }

  @Get(':walletId')
  async get(@Param() params: unknown): Promise<WalletResponse> {
    const { walletId } = parseRequest('params', walletParams, params);
    const wallet = await this.walletQueries.getWallet(walletId);
    if (wallet === null) {
      throw walletNotFound();
    }
    return toWalletResponse(wallet);
  }

  @Get(':walletId/ledger')
  async ledger(@Param() params: unknown, @Query() query: unknown): Promise<LedgerPageResponse> {
    const { walletId } = parseRequest('params', walletParams, params);
    const { cursor, limit } = parseRequest('query', ledgerQuery, query);
    const listQuery: ListLedgerQuery = { walletId };
    if (cursor !== undefined) {
      listQuery.cursor = cursor;
    }
    if (limit !== undefined) {
      listQuery.limit = limit;
    }
    const page = await this.walletQueries.listLedger(listQuery);
    if (page === null) {
      throw walletNotFound();
    }
    return toLedgerPageResponse(page);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param() params: unknown): Promise<ReconciliationResponse> {
    const { walletId } = parseRequest('params', walletParams, params);
    const reconciliation = await this.reconcileWallet.execute(walletId);
    if (reconciliation === null) {
      throw walletNotFound();
    }
    return toReconciliationResponse(reconciliation);
  }
}
