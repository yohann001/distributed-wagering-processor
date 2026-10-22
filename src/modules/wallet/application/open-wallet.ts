import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import type { Money } from '../../../shared/domain/money';
import type { OutboxRepository } from '../../messaging/application/outbox-repository';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { defaultIdempotencyKey, wagerPayloadHash } from '../../wagering/application/payload-hash';
import type { WagerTransactionRepository } from '../../wagering/application/wager-transaction-repository';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/domain/wager-transaction';
import { WagerTransactionProcessed } from '../../wagering/domain/wager-transaction-events';
import { InvalidWalletOpeningError, Wallet } from '../domain/wallet';
import { WalletBalanceChanged } from '../domain/wallet-balance-changed';
import type { WalletLedgerRepository } from './wallet-ledger-repository';
import type { WalletRepository } from './wallet-repository';

/**
 * Campos sintéticos da transação OPENING interna. O `:` no providerId é recusado na borda (T19/T22),
 * então nenhum provedor externo colide com ele.
 */
export const OPENING_PROVIDER_ID = 'internal:wallet-opening';
export const OPENING_GAME_ID = 'wallet-opening';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

/**
 * Abre a wallet (§9). Com saldo inicial > 0 grava, na mesma transação SQL (§6.2, §11), a transação
 * OPENING `PROCESSED`, o CREDIT de abertura e os eventos na outbox. Wallet duplicada
 * (`playerId + currency`) é detectada só pela constraint do banco e vira `WalletAlreadyExistsError`.
 */
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute(command: OpenWalletCommand): Promise<Wallet> {
    const { playerId, initialBalance, correlationId } = command;

    // Relógio e ids são lidos dentro do trabalho: um retry do UnitOfWork recomeça do zero.
    return this.uow.run(async () => {
      const now = this.clock.now();
      const walletId = this.ids.next();

      if (initialBalance.isZero()) {
        const { wallet } = Wallet.open({ id: walletId, playerId, initialBalance, openedAt: now });
        await this.wallets.insert(wallet);
        return wallet;
      }

      const transactionId = this.ids.next();
      const ledgerEntryId = this.ids.next();
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId,
        initialBalance,
        openedAt: now,
        opening: { transactionId, ledgerEntryId },
      });
      if (openingEntry === null) {
        throw new InvalidWalletOpeningError('a positive initial balance must produce an opening entry');
      }

      // externalTransactionId = walletId: wager_transactions_provider_external_uq também garante,
      // no banco, no máximo uma OPENING por wallet.
      const opening = WagerTransaction.createOpening({
        id: transactionId,
        providerId: OPENING_PROVIDER_ID,
        externalTransactionId: walletId,
        idempotencyKey: defaultIdempotencyKey(OPENING_PROVIDER_ID, walletId),
        payloadHash: wagerPayloadHash({
          providerId: OPENING_PROVIDER_ID,
          externalTransactionId: walletId,
          walletId,
          playerId,
          roundId: walletId,
          gameId: OPENING_GAME_ID,
          kind: WagerTransactionKind.Opening,
          money: initialBalance,
        }),
        walletId,
        playerId,
        roundId: walletId,
        gameId: OPENING_GAME_ID,
        money: initialBalance,
        createdAt: now,
      });

      // A wallet vai primeiro: a duplicada falha antes de qualquer outra escrita.
      await this.wallets.insert(wallet);
      await this.transactions.insert(opening);
      await this.ledger.append(openingEntry);
      await this.outbox.insert(
        OutboxMessage.enqueue(
          WagerTransactionProcessed.from(opening, {
            eventId: this.ids.next(),
            correlationId,
            occurredAt: now,
          }),
        ),
      );
      await this.outbox.insert(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, openingEntry, {
            eventId: this.ids.next(),
            correlationId,
            occurredAt: now,
          }),
        ),
      );
      return wallet;
    });
  }
}
