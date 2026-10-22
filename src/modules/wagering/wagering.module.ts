import { Global, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { Registry } from 'prom-client';

import { loadEnv } from '../../config/env';
import { LogContext } from '../../infrastructure/observability/log-context';
import { Clock } from '../../shared/application/clock';
import { IdGenerator } from '../../shared/application/id-generator';
import { UnitOfWork } from '../../shared/application/unit-of-work';
import { ExponentialBackoff } from '../../shared/domain/exponential-backoff';
import { InboxRepository } from '../messaging/application/inbox-repository';
import { OutboxRepository } from '../messaging/application/outbox-repository';
import { WalletLedgerRepository } from '../wallet/application/wallet-ledger-repository';
import { WalletRepository } from '../wallet/application/wallet-repository';
import { ReprocessPendingReferences } from './application/reprocess-pending-references';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { WagerTransactionMonitor } from './application/wager-transaction-monitor';
import { WagerTransactionQueries } from './application/wager-transaction-queries';
import { WagerTransactionRepository } from './application/wager-transaction-repository';
import { DEFAULT_REFERENCE_RETRY_BACKOFF, ReferenceRetryPolicy } from './domain/reference-retry-policy';
import { WagerApplicationPolicy } from './domain/wager-application-policy';
import { PrometheusWagerTransactionMonitor } from './infrastructure/observability/prometheus-wager-transaction-monitor';
import {
  PENDING_REFERENCE_WORKER_OPTIONS,
  pendingReferenceWorkerOptionsFromEnv,
  type PendingReferenceWorkerOptions,
} from './infrastructure/pending-reference/pending-reference-worker-options';
import { PendingReferenceWorker } from './infrastructure/pending-reference/pending-reference-worker';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/mikro-orm-wager-transaction-repository';
import { WagerTransactionsController } from './presentation/wager-transactions.controller';

@Global()
@Module({
  controllers: [WagerTransactionsController],
  providers: [
    { provide: WagerTransactionRepository, useClass: MikroOrmWagerTransactionRepository },
    {
      provide: WagerTransactionMonitor,
      inject: [Registry],
      useFactory: (registry: Registry) => new PrometheusWagerTransactionMonitor(registry),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [
        UnitOfWork,
        WagerTransactionRepository,
        WalletRepository,
        WalletLedgerRepository,
        InboxRepository,
        OutboxRepository,
        Clock,
        IdGenerator,
        WagerTransactionMonitor,
      ],
      useFactory: (
        uow: UnitOfWork,
        transactions: WagerTransactionRepository,
        wallets: WalletRepository,
        ledger: WalletLedgerRepository,
        inbox: InboxRepository,
        outbox: OutboxRepository,
        clock: Clock,
        ids: IdGenerator,
        monitor: WagerTransactionMonitor,
      ) =>
        new SubmitWagerTransaction(
          uow,
          transactions,
          wallets,
          ledger,
          inbox,
          outbox,
          new WagerApplicationPolicy(),
          clock,
          ids,
          monitor,
        ),
    },
    {
      provide: WagerTransactionQueries,
      inject: [WagerTransactionRepository],
      useFactory: (transactions: WagerTransactionRepository) => new WagerTransactionQueries(transactions),
    },
    {
      provide: PENDING_REFERENCE_WORKER_OPTIONS,
      useFactory: (): PendingReferenceWorkerOptions => pendingReferenceWorkerOptionsFromEnv(loadEnv()),
    },
    {
      provide: ReprocessPendingReferences,
      inject: [
        UnitOfWork,
        WagerTransactionRepository,
        WalletRepository,
        WalletLedgerRepository,
        OutboxRepository,
        Clock,
        IdGenerator,
        PENDING_REFERENCE_WORKER_OPTIONS,
        WagerTransactionMonitor,
      ],
      useFactory: (
        uow: UnitOfWork,
        transactions: WagerTransactionRepository,
        wallets: WalletRepository,
        ledger: WalletLedgerRepository,
        outbox: OutboxRepository,
        clock: Clock,
        ids: IdGenerator,
        options: PendingReferenceWorkerOptions,
        monitor: WagerTransactionMonitor,
      ) =>
        new ReprocessPendingReferences(
          uow,
          transactions,
          wallets,
          ledger,
          outbox,
          new WagerApplicationPolicy(),
          new ReferenceRetryPolicy(
            options.maxAttempts,
            new ExponentialBackoff(
              {
                baseDelayMs: options.retryBaseDelayMs,
                maxDelayMs: options.retryMaxDelayMs,
                jitterRatio: DEFAULT_REFERENCE_RETRY_BACKOFF.jitterRatio,
              },
              Math.random,
            ),
          ),
          clock,
          ids,
          options.batchSize,
          monitor,
        ),
    },
    {
      provide: PendingReferenceWorker,
      inject: [ReprocessPendingReferences, PENDING_REFERENCE_WORKER_OPTIONS, LogContext, Registry],
      useFactory: (
        reprocess: ReprocessPendingReferences,
        options: PendingReferenceWorkerOptions,
        logContext: LogContext,
        registry: Registry,
      ) => new PendingReferenceWorker(reprocess, options, logContext, registry),
    },
  ],
  exports: [WagerTransactionRepository, SubmitWagerTransaction, WagerTransactionQueries, ReprocessPendingReferences],
})
export class WageringModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(private readonly worker: PendingReferenceWorker) {}

  onApplicationBootstrap(): void {
    this.worker.start();
  }

  // Antes de qualquer `onApplicationShutdown`: o ciclo em andamento ainda tem o banco (o MikroORM fecha no dele).
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}
