import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import { assertInTransaction } from '../../../../infrastructure/database/assert-in-transaction';
import {
  ConcurrencyConflictError,
  ConcurrencyConflictReason,
} from '../../../../shared/application/unit-of-work';
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

  async lockById(id: string): Promise<Wallet | null> {
    assertInTransaction(this.em, 'WalletRepository.lockById');
    const row = await this.em.findOne(
      WalletSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return row === null ? null : walletFromRow(row);
  }

  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    assertInTransaction(this.em, 'WalletRepository.updateBalance');
    // Erro de programação (§6.2): a version sobe 1 por mudança de saldo.
    if (wallet.version !== expectedVersion + 1) {
      throw new Error(
        `Wallet ${wallet.id} version ${wallet.version} must be expectedVersion + 1 (${expectedVersion + 1})`,
      );
    }
    const { balance, version, updatedAt } = walletToRow(wallet);
    // O FOR UPDATE já serializa; o WHERE version é a segunda barreira para um caminho que esqueça o lock.
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance, version, updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(
        ConcurrencyConflictReason.VersionConflict,
        `wallet ${wallet.id} is no longer at version ${expectedVersion}`,
      );
    }
  }
}
