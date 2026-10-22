import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { assertInTransaction } from '../../../../infrastructure/database/assert-in-transaction';
import { WagerTransactionRepository } from '../../application/wager-transaction-repository';
import type { WagerTransaction } from '../../domain/wager-transaction';
import {
  WagerTransactionSchema,
  wagerTransactionFromRow,
  wagerTransactionToRow,
} from './wager-transaction.persistence';

@Injectable()
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    assertInTransaction(this.em, 'WagerTransactionRepository.insert');
    await this.em.insert(WagerTransactionSchema, wagerTransactionToRow(transaction));
  }

  async update(transaction: WagerTransaction): Promise<void> {
    assertInTransaction(this.em, 'WagerTransactionRepository.update');
    const { status, referenceTransactionId, failureCode, balanceAfter, processedAt } =
      wagerTransactionToRow(transaction);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      { status, referenceTransactionId, failureCode, balanceAfter, processedAt },
    );
    if (affected !== 1) {
      throw new Error(`Wager transaction ${transaction.id} not found for update`);
    }
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, { id }, { disableIdentityMap: true });
    return row === null ? null : wagerTransactionFromRow(row);
  }
}
