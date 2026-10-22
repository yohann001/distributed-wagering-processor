import { Module } from '@nestjs/common';

import { WalletLedgerRepository } from './application/wallet-ledger-repository';
import { WalletRepository } from './application/wallet-repository';
import { MikroOrmWalletLedgerRepository } from './infrastructure/persistence/mikro-orm-wallet-ledger-repository';
import { MikroOrmWalletRepository } from './infrastructure/persistence/mikro-orm-wallet-repository';

@Module({
  providers: [
    { provide: WalletRepository, useClass: MikroOrmWalletRepository },
    { provide: WalletLedgerRepository, useClass: MikroOrmWalletLedgerRepository },
  ],
  exports: [WalletRepository, WalletLedgerRepository],
})
export class WalletModule {}
