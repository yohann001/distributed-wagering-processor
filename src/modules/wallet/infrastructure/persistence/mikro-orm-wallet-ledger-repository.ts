import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { assertInTransaction } from '../../../../infrastructure/database/assert-in-transaction';
import { WalletLedgerRepository } from '../../application/wallet-ledger-repository';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  WalletLedgerEntrySchema,
  walletLedgerEntryFromRow,
  walletLedgerEntryToRow,
} from './wallet-ledger-entry.persistence';

@Injectable()
export class MikroOrmWalletLedgerRepository extends WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async append(entry: WalletLedgerEntry): Promise<void> {
    assertInTransaction(this.em, 'WalletLedgerRepository.append');
    await this.em.insert(WalletLedgerEntrySchema, walletLedgerEntryToRow(entry));
  }

  async findById(id: string): Promise<WalletLedgerEntry | null> {
    const row = await this.em.findOne(WalletLedgerEntrySchema, { id }, { disableIdentityMap: true });
    return row === null ? null : walletLedgerEntryFromRow(row);
  }
}
