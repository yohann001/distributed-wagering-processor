import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { WagerTransactionRepository } from '../../src/modules/wagering/application/wager-transaction-repository';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WalletLedgerRepository } from '../../src/modules/wallet/application/wallet-ledger-repository';
import { WalletRepository } from '../../src/modules/wallet/application/wallet-repository';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../src/modules/wallet/domain/wallet-ledger-entry';
import { Money } from '../../src/shared/domain/money';
import { inTransaction } from './orm-context';

/** Instante fixo (com milissegundos) usado na abertura das wallets de teste. */
export const FIXTURE_OPENED_AT = new Date('2026-10-22T10:00:00.123Z');

/** Provider único por chamada: as chaves de idempotência e de transação são por provider (§9). */
export function newProviderId(): string {
  return `provider-${Bun.randomUUIDv7()}`;
}

export interface OpenedWalletFixture {
  wallet: Wallet;
  /** Ausente quando o saldo inicial é zero. */
  openingTransaction: WagerTransaction | undefined;
  /** Ausente quando o saldo inicial é zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

/**
 * Persiste uma wallet nova com `amount` de saldo: wallet, transação OPENING e CREDIT de abertura
 * pelos repositórios, na mesma transação. Com saldo zero só a wallet existe.
 */
export async function openWalletWithBalance(
  app: INestApplication,
  props: { amount: string; currency?: string; playerId?: string },
): Promise<OpenedWalletFixture> {
  const orm: MikroORM = app.get(MikroORM);
  const wallets = app.get(WalletRepository);
  const transactions = app.get(WagerTransactionRepository);
  const ledger = app.get(WalletLedgerRepository);

  const walletId = Bun.randomUUIDv7();
  const playerId = props.playerId ?? `player-${Bun.randomUUIDv7()}`;
  const initialBalance = Money.from({ amount: props.amount, currency: props.currency ?? 'BRL' });

  if (initialBalance.isZero()) {
    const { wallet } = Wallet.open({ id: walletId, playerId, initialBalance, openedAt: FIXTURE_OPENED_AT });
    await inTransaction(orm, () => wallets.insert(wallet));
    return { wallet, openingTransaction: undefined, openingEntry: undefined };
  }

  const transactionId = Bun.randomUUIDv7();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance,
    openedAt: FIXTURE_OPENED_AT,
    opening: { transactionId, ledgerEntryId: Bun.randomUUIDv7() },
  });
  const openingTransaction = WagerTransaction.createOpening({
    id: transactionId,
    providerId: 'wallet-opening',
    externalTransactionId: `opening-${transactionId}`,
    idempotencyKey: `opening-${transactionId}`,
    payloadHash: `hash-${transactionId}`,
    walletId,
    playerId,
    roundId: `round-${transactionId}`,
    gameId: 'game-1',
    money: initialBalance,
    createdAt: FIXTURE_OPENED_AT,
  });
  if (openingEntry === null) {
    throw new Error('expected a positive initial balance to produce an opening entry');
  }

  await inTransaction(orm, async () => {
    await wallets.insert(wallet);
    await transactions.insert(openingTransaction);
    await ledger.append(openingEntry);
  });
  return { wallet, openingTransaction, openingEntry };
}
