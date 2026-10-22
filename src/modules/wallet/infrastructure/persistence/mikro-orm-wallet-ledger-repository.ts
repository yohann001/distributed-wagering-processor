import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { assertInTransaction } from '../../../../infrastructure/database/assert-in-transaction';
import {
  WalletLedgerRepository,
  type LedgerPage,
  type LedgerPageQuery,
} from '../../application/wallet-ledger-repository';
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

  async listByWallet({ walletId, after, limit }: LedgerPageQuery): Promise<LedgerPage> {
    // A linha extra (limit + 1) só detecta se há próxima página; o índice único (wallet_id, seq) atende a consulta.
    const rows = await this.em.find(
      WalletLedgerEntrySchema,
      after === null ? { walletId } : { walletId, seq: { $lt: after } },
      { disableIdentityMap: true, orderBy: { seq: 'desc' }, limit: limit + 1 },
    );
    const page = rows.slice(0, limit);
    let nextPosition: string | null = null;
    if (rows.length > limit) {
      const lastSeq = page.at(-1)?.seq;
      if (lastSeq === undefined) {
        throw new Error(`Ledger row of wallet ${walletId} came back without seq`);
      }
      nextPosition = lastSeq;
    }
    return { entries: page.map(walletLedgerEntryFromRow), nextPosition };
  }
}
