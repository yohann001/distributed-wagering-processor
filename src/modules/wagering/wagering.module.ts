import { Global, Module } from '@nestjs/common';

import { Clock } from '../../shared/application/clock';
import { IdGenerator } from '../../shared/application/id-generator';
import { UnitOfWork } from '../../shared/application/unit-of-work';
import { InboxRepository } from '../messaging/application/inbox-repository';
import { OutboxRepository } from '../messaging/application/outbox-repository';
import { WalletLedgerRepository } from '../wallet/application/wallet-ledger-repository';
import { WalletRepository } from '../wallet/application/wallet-repository';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { WagerTransactionQueries } from './application/wager-transaction-queries';
import { WagerTransactionRepository } from './application/wager-transaction-repository';
import { WagerApplicationPolicy } from './domain/wager-application-policy';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/mikro-orm-wager-transaction-repository';
import { WagerTransactionsController } from './presentation/wager-transactions.controller';

@Global()
@Module({
  controllers: [WagerTransactionsController],
  providers: [
    { provide: WagerTransactionRepository, useClass: MikroOrmWagerTransactionRepository },
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
        ),
    },
    {
      provide: WagerTransactionQueries,
      inject: [WagerTransactionRepository],
      useFactory: (transactions: WagerTransactionRepository) => new WagerTransactionQueries(transactions),
    },
  ],
  exports: [WagerTransactionRepository, SubmitWagerTransaction, WagerTransactionQueries],
})
export class WageringModule {}
