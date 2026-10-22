import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { assertInTransaction } from '../../../../infrastructure/database/assert-in-transaction';
import { WagerTransactionRepository } from '../../application/wager-transaction-repository';
import {
  WagerTransactionAlreadyExistsError,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from '../../domain/wager-transaction';
import {
  WagerTransactionSchema,
  wagerTransactionFromRow,
  wagerTransactionToRow,
} from './wager-transaction.persistence';

export const WAGER_TRANSACTION_IDEMPOTENCY_CONSTRAINT = 'wager_transactions_provider_idempotency_uq';
export const WAGER_TRANSACTION_EXTERNAL_ID_CONSTRAINT = 'wager_transactions_provider_external_uq';

const KEY_CONSTRAINTS: ReadonlySet<unknown> = new Set([
  WAGER_TRANSACTION_IDEMPOTENCY_CONSTRAINT,
  WAGER_TRANSACTION_EXTERNAL_ID_CONSTRAINT,
]);

@Injectable()
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    assertInTransaction(this.em, 'WagerTransactionRepository.insert');
    try {
      await this.em.insert(WagerTransactionSchema, wagerTransactionToRow(transaction));
    } catch (error) {
      // A constraint, e não uma leitura prévia, é a guarda final: vale também entre instâncias (§5.8, §9).
      if (error instanceof UniqueConstraintViolationException) {
        const { constraint } = error as { constraint?: unknown };
        if (typeof constraint === 'string' && KEY_CONSTRAINTS.has(constraint)) {
          throw new WagerTransactionAlreadyExistsError(transaction.providerId, constraint);
        }
      }
      throw error;
    }
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

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, idempotencyKey },
      { disableIdentityMap: true },
    );
    return row === null ? null : wagerTransactionFromRow(row);
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, externalTransactionId },
      { disableIdentityMap: true },
    );
    return row === null ? null : wagerTransactionFromRow(row);
  }

  async findProcessedReversalsOf(referenceTransactionId: string): Promise<WagerTransaction[]> {
    // kind e status repetem o predicado do índice parcial wager_transactions_single_reversal_uq.
    const rows = await this.em.find(
      WagerTransactionSchema,
      {
        referenceTransactionId,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
        status: WagerTransactionStatus.Processed,
      },
      { disableIdentityMap: true, orderBy: { createdAt: 'asc', id: 'asc' } },
    );
    return rows.map(wagerTransactionFromRow);
  }
}
