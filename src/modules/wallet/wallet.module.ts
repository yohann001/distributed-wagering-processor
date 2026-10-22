import { Global, Module } from '@nestjs/common';
import { Registry } from 'prom-client';

import { LogContext } from '../../infrastructure/observability/log-context';
import { Clock } from '../../shared/application/clock';
import { IdGenerator } from '../../shared/application/id-generator';
import { UnitOfWork } from '../../shared/application/unit-of-work';
import { OutboxRepository } from '../messaging/application/outbox-repository';
import { WagerTransactionRepository } from '../wagering/application/wager-transaction-repository';
import { OpenWallet } from './application/open-wallet';
import { ReconcileWallet } from './application/reconcile-wallet';
import { ReconciliationMonitor } from './application/reconciliation-monitor';
import { WalletLedgerRepository } from './application/wallet-ledger-repository';
import { WalletQueries } from './application/wallet-queries';
import { WalletRepository } from './application/wallet-repository';
import { PrometheusReconciliationMonitor } from './infrastructure/observability/prometheus-reconciliation-monitor';
import { MikroOrmWalletLedgerRepository } from './infrastructure/persistence/mikro-orm-wallet-ledger-repository';
import { MikroOrmWalletRepository } from './infrastructure/persistence/mikro-orm-wallet-repository';
import { WalletsController } from './presentation/wallets.controller';

// Global como o DatabaseModule: os casos de uso de um módulo injetam as portas de outro sem ciclo de imports entre módulos.
@Global()
@Module({
  controllers: [WalletsController],
  providers: [
    { provide: WalletRepository, useClass: MikroOrmWalletRepository },
    { provide: WalletLedgerRepository, useClass: MikroOrmWalletLedgerRepository },
    {
      provide: OpenWallet,
      inject: [
        UnitOfWork,
        WalletRepository,
        WalletLedgerRepository,
        WagerTransactionRepository,
        OutboxRepository,
        Clock,
        IdGenerator,
      ],
      useFactory: (
        uow: UnitOfWork,
        wallets: WalletRepository,
        ledger: WalletLedgerRepository,
        transactions: WagerTransactionRepository,
        outbox: OutboxRepository,
        clock: Clock,
        ids: IdGenerator,
      ) => new OpenWallet(uow, wallets, ledger, transactions, outbox, clock, ids),
    },
    {
      provide: WalletQueries,
      inject: [WalletRepository, WalletLedgerRepository],
      useFactory: (wallets: WalletRepository, ledger: WalletLedgerRepository) =>
        new WalletQueries(wallets, ledger),
    },
    {
      provide: ReconciliationMonitor,
      inject: [Registry, LogContext],
      useFactory: (registry: Registry, logContext: LogContext) =>
        new PrometheusReconciliationMonitor(registry, logContext),
    },
    {
      provide: ReconcileWallet,
      inject: [WalletLedgerRepository, ReconciliationMonitor],
      useFactory: (ledger: WalletLedgerRepository, monitor: ReconciliationMonitor) =>
        new ReconcileWallet(ledger, monitor),
    },
  ],
  exports: [WalletRepository, WalletLedgerRepository, OpenWallet, WalletQueries, ReconcileWallet],
})
export class WalletModule {}
