import { Module } from '@nestjs/common';

import { WagerTransactionRepository } from './application/wager-transaction-repository';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/mikro-orm-wager-transaction-repository';

@Module({
  providers: [{ provide: WagerTransactionRepository, useClass: MikroOrmWagerTransactionRepository }],
  exports: [WagerTransactionRepository],
})
export class WageringModule {}
