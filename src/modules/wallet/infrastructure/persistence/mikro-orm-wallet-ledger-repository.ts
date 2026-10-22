import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { assertInTransaction } from '../../../../infrastructure/database/assert-in-transaction';
import { Money } from '../../../../shared/domain/money';
import {
  WalletLedgerRepository,
  type LedgerBalanceSnapshot,
  type LedgerPage,
  type LedgerPageQuery,
} from '../../application/wallet-ledger-repository';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  WalletLedgerEntrySchema,
  walletLedgerEntryFromRow,
  walletLedgerEntryToRow,
} from './wallet-ledger-entry.persistence';

interface BalanceSnapshotRow {
  currency: string;
  stored_balance: string;
  credits: string;
  debits: string;
  entry_count: number;
}

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

  async balanceSnapshot(walletId: string): Promise<LedgerBalanceSnapshot | null> {
    // Um único statement: saldo e soma saem do mesmo snapshot, então um commit entre duas leituras não fabrica divergência.
    const rows = await this.em.execute<BalanceSnapshotRow[]>(
      `select w.currency,
              w.balance::text as stored_balance,
              coalesce(sum(e.amount) filter (where e.direction = 'CREDIT'), 0)::numeric(18,2)::text as credits,
              coalesce(sum(e.amount) filter (where e.direction = 'DEBIT'), 0)::numeric(18,2)::text as debits,
              count(e.id)::int as entry_count
         from wallets w
         left join wallet_ledger_entries e on e.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const { currency } = row;
    return {
      storedBalance: Money.from({ amount: row.stored_balance, currency }),
      ledgerBalance: Money.from({ amount: row.credits, currency }).subtract(
        Money.from({ amount: row.debits, currency }),
      ),
      entryCount: row.entry_count,
    };
  }
}
