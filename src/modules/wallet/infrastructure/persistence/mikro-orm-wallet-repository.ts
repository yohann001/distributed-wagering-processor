import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { assertInTransaction } from '../../../../infrastructure/database/assert-in-transaction';
import { WalletRepository } from '../../application/wallet-repository';
import type { Wallet } from '../../domain/wallet';
import { WalletSchema, walletFromRow, walletToRow } from './wallet.persistence';

@Injectable()
export class MikroOrmWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async insert(wallet: Wallet): Promise<void> {
    assertInTransaction(this.em, 'WalletRepository.insert');
    await this.em.insert(WalletSchema, walletToRow(wallet));
  }

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletSchema, { id }, { disableIdentityMap: true });
    return row === null ? null : walletFromRow(row);
  }
}
