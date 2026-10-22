import { Global, Module } from '@nestjs/common';

import { Clock } from '../../shared/application/clock';
import { IdGenerator } from '../../shared/application/id-generator';
import { UnitOfWork } from '../../shared/application/unit-of-work';
import { OutboxRepository } from '../messaging/application/outbox-repository';
import { WagerTransactionRepository } from '../wagering/application/wager-transaction-repository';
import { OpenWallet } from './application/open-wallet';
import { WalletLedgerRepository } from './application/wallet-ledger-repository';
import { WalletRepository } from './application/wallet-repository';
import { MikroOrmWalletLedgerRepository } from './infrastructure/persistence/mikro-orm-wallet-ledger-repository';
import { MikroOrmWalletRepository } from './infrastructure/persistence/mikro-orm-wallet-repository';

// Global como o DatabaseModule: os casos de uso de um módulo injetam as portas de outro sem ciclo de imports entre módulos.
@Global()
@Module({
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
  ],
  exports: [WalletRepository, WalletLedgerRepository, OpenWallet],
})
export class WalletModule {}
