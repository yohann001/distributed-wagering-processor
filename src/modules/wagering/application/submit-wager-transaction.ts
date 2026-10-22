import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import type { Money } from '../../../shared/domain/money';
import type { InboxRepository } from '../../messaging/application/inbox-repository';
import type { OutboxRepository } from '../../messaging/application/outbox-repository';
import {
  InboxMessage,
  InboxMessageAlreadyExistsError,
  InboxMessageConflictError,
} from '../../messaging/domain/inbox-message';
import type { WalletLedgerRepository } from '../../wallet/application/wallet-ledger-repository';
import type { WalletRepository } from '../../wallet/application/wallet-repository';
import type { WagerApplicationPolicy } from '../domain/wager-application-policy';
import {
  IdempotencyConflictError,
  WagerTransaction,
  WagerTransactionAlreadyExistsError,
  type WagerTransactionKind,
} from '../domain/wager-transaction';
import { wagerPayloadHash } from './payload-hash';
import { enqueueWagerOutcomeEvents } from './wager-outcome-events';
import type { WagerTransactionRepository } from './wager-transaction-repository';

export interface InboxEntry {
  consumerName: string;
  messageId: string;
}

export interface SubmitWagerTransactionCommand {
  /** Fonte da verdade da idempotência (§9). A borda já normalizou ids e validou o payload. */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  /** Entrada SQS (T22): registro na inbox na mesma transação SQL (§10, §11). Ausente no HTTP. */
  inbox?: InboxEntry | undefined;
}

export interface SubmitWagerTransactionResult {
  /** Estado decidido: PROCESSED, REJECTED ou PENDING_REFERENCE. `balanceAfter` é o saldo observado na decisão. */
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

/**
 * Submete uma transação de aposta (§7, §9). É o mesmo caso de uso para HTTP e SQS (§10) e roda numa única
 * transação SQL (§11): idempotência, inbox opcional, lock da wallet, transação, saldo, ledger e outbox.
 * A ordem é busca da key → lock da wallet → nova busca: a segunda leitura enxerga o que uma submissão
 * concorrente da mesma wallet commitou enquanto esta esperava o lock. Sem linha de wallet para travar,
 * a unique constraint é a guarda final (§5.9): a perdedora é desfeita e refeita uma vez numa transação nova,
 * que devolve replay ou conflito. Rejeição de negócio vira `REJECTED` persistido; conflito de idempotência
 * é exceção, porque nada é gravado.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly inbox: InboxRepository,
    private readonly outbox: OutboxRepository,
    private readonly policy: WagerApplicationPolicy,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const payloadHash = wagerPayloadHash(command);
    try {
      return await this.uow.run(() => this.submit(command, payloadHash));
    } catch (error) {
      // Corrida de inserção (§9): a constraint barrou a perdedora e a transação dela foi desfeita. Uma
      // transação nova enxerga a vencedora já commitada e devolve replay ou conflito.
      if (error instanceof WagerTransactionAlreadyExistsError || error instanceof InboxMessageAlreadyExistsError) {
        return this.uow.run(() => this.submit(command, payloadHash));
      }
      throw error;
    }
  }

  private async submit(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult> {
    const now = this.clock.now();

    if (command.inbox) {
      const { consumerName, messageId } = command.inbox;
      const received = await this.inbox.findByKey(consumerName, messageId);
      if (received !== null) {
        if (!received.matchesPayload(payloadHash)) {
          throw new InboxMessageConflictError(consumerName, messageId);
        }
        const original = await this.findReplay(command, payloadHash);
        if (original === null) {
          // O messageId já foi usado por outro pedido: não é entrega duplicada desta submissão.
          throw new InboxMessageConflictError(consumerName, messageId);
        }
        return { transaction: original, idempotentReplay: true };
      }
    }

    // Caminho rápido: um replay não precisa do lock da wallet.
    const existing = await this.findReplay(command, payloadHash);
    if (existing !== null) {
      return this.replay(existing, command, payloadHash, now);
    }

    const wallet = await this.wallets.lockById(command.walletId);

    // Sob o lock: uma submissão concorrente da mesma key pode ter commitado enquanto esperávamos (READ COMMITTED).
    const committed = await this.findReplay(command, payloadHash);
    if (committed !== null) {
      return this.replay(committed, command, payloadHash, now);
    }

    // O mesmo id externo sob outra key é outra requisição para a mesma transação do provedor (§6.3).
    const sameExternalId = await this.transactions.findByExternalId(command.providerId, command.externalTransactionId);
    if (sameExternalId !== null) {
      // Sem linha de wallet não há lock que serialize: a vencedora pode ter commitado entre as duas leituras.
      // Com a mesma key e o mesmo payload é a própria submissão, ou seja, replay.
      if (sameExternalId.idempotencyKey !== command.idempotencyKey || !sameExternalId.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError(command.providerId, command.idempotencyKey);
      }
      return this.replay(sameExternalId, command, payloadHash, now);
    }

    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    const reference =
      transaction.referenceExternalTransactionId === undefined
        ? null
        : await this.transactions.findByExternalId(command.providerId, transaction.referenceExternalTransactionId);
    const reversalsOfReference =
      reference === null ? [] : await this.transactions.findProcessedReversalsOf(reference.id);

    const expectedVersion = wallet?.version;
    const outcome = this.policy.apply({
      transaction,
      wallet,
      reference,
      reversalsOfReference,
      ledgerEntryId: this.ids.next(),
      at: now,
    });

    await this.transactions.insert(transaction);
    if (outcome.ledgerEntry !== null) {
      if (wallet === null || expectedVersion === undefined) {
        throw new Error('ledger entry without a locked wallet');
      }
      await this.wallets.updateBalance(wallet, expectedVersion);
      await this.ledger.append(outcome.ledgerEntry);
    }
    await this.recordInbox(command, payloadHash, now);
    await enqueueWagerOutcomeEvents(this.outbox, this.ids, transaction, outcome, wallet, {
      correlationId: command.correlationId,
      causationId: command.inbox?.messageId,
      occurredAt: now,
    });

    return { transaction, idempotentReplay: false };
  }

  private async findReplay(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<WagerTransaction | null> {
    const existing = await this.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (existing === null) {
      return null;
    }
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(command.providerId, command.idempotencyKey);
    }
    return existing;
  }

  private async replay(
    existing: WagerTransaction,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    now: Date,
  ): Promise<SubmitWagerTransactionResult> {
    // Um messageId novo que carrega uma key já processada é registrado, para a reentrega dele ser deduplicada.
    await this.recordInbox(command, payloadHash, now);
    return { transaction: existing, idempotentReplay: true };
  }

  private async recordInbox(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    now: Date,
  ): Promise<void> {
    if (!command.inbox) {
      return;
    }
    const message = InboxMessage.receive({ ...command.inbox, payloadHash, receivedAt: now });
    message.markProcessed(now);
    await this.inbox.insert(message);
  }
}
