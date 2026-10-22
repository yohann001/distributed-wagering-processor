import type { Clock } from '../../../shared/application/clock';
import type { IdGenerator } from '../../../shared/application/id-generator';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import { FailureCode } from '../../../shared/domain/failure-code';
import type { OutboxRepository } from '../../messaging/application/outbox-repository';
import type { WalletLedgerRepository } from '../../wallet/application/wallet-ledger-repository';
import type { WalletRepository } from '../../wallet/application/wallet-repository';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import { WagerDecision, type WagerApplicationPolicy } from '../domain/wager-application-policy';
import type { WagerTransaction } from '../domain/wager-transaction';
import { enqueueWagerOutcomeEvents, type WagerEventContext } from './wager-outcome-events';
import type { WagerTransactionRepository } from './wager-transaction-repository';

export enum PendingReferenceOutcome {
  /** A referência chegou e a transação foi aplicada (inclui LOSS, que só registra). */
  Processed = 'processed',
  /** Regra de negócio rejeitou a transação agora que a referência existe (ex.: valor diferente, já revertida). */
  Rejected = 'rejected',
  /** A referência ainda não pode ser usada: próxima reavaliação reagendada com backoff. */
  Retried = 'retried',
  /** Limite de reavaliações esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` ou `REFERENCE_NOT_PROCESSED`. */
  Expired = 'expired',
}

export interface ReprocessedPendingReference {
  transaction: WagerTransaction;
  outcome: PendingReferenceOutcome;
  /** Reavaliações contadas até aqui, incluindo esta. */
  attempt: number;
}

export interface ReprocessPendingReferencesResult {
  reprocessed: readonly ReprocessedPendingReference[];
}

/**
 * Um ciclo do worker de `PENDING_REFERENCE` (§7.1, §7 regra 8): reavalia, uma a uma, as transações pendentes vencidas
 * e aplica a mesma `WagerApplicationPolicy` da submissão, sem uma segunda cópia das regras de negócio.
 *
 * - Cada transação roda na própria transação SQL. Várias numa só segurariam vários locks de wallet, e dois workers
 *   poderiam travar um no outro. O claim com `FOR UPDATE SKIP LOCKED` segura a linha até o commit: a instância que
 *   chega depois pula a linha em vez de esperar, então cada pendente é aplicada uma única vez.
 * - A ordem de locks é linha da transação pendente → wallet. Não há deadlock com a submissão: ela nunca trava uma
 *   linha de transação já existente (só insere e lê), e a FK `reference_transaction_id` só aponta `PROCESSED`,
 *   nunca uma pendente. O lock da wallet vem antes de ler a referência, para enxergar (READ COMMITTED) a `BET`
 *   commitada enquanto esta esperava.
 * - Referência ainda ausente ou pendente conta uma reavaliação perdida: abaixo de `maxAttempts` a próxima é
 *   reagendada com backoff exponencial; no limite a transação vira `REJECTED` (`REFERENCE_NOT_FOUND` se a referência
 *   não existe, `REFERENCE_NOT_PROCESSED` se existe mas ainda está pendente) e o evento `WagerTransactionRejected`
 *   entra na outbox. O evento de pendência já saiu na submissão e não se repete a cada reavaliação.
 */
export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly policy: WagerApplicationPolicy,
    private readonly retry: ReferenceRetryPolicy,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly batchSize: number,
  ) {}

  async execute(correlationId: string): Promise<ReprocessPendingReferencesResult> {
    const reprocessed: ReprocessedPendingReference[] = [];
    while (reprocessed.length < this.batchSize) {
      const item = await this.uow.run(() => this.reprocessNext(correlationId));
      if (item === null) {
        break;
      }
      reprocessed.push(item);
    }
    return { reprocessed };
  }

  /** Tudo é lido dentro do trabalho: o `UnitOfWork` pode reexecutá-lo do zero. */
  private async reprocessNext(correlationId: string): Promise<ReprocessedPendingReference | null> {
    const now = this.clock.now();
    const claimed = await this.transactions.claimDuePendingReference(now);
    if (claimed === null) {
      return null;
    }
    const { transaction } = claimed;
    const attempt = claimed.attempts + 1;
    const context: WagerEventContext = { correlationId, causationId: undefined, occurredAt: now };

    const wallet = await this.wallets.lockById(transaction.walletId);
    const expectedVersion = wallet?.version;

    // Depois do lock da wallet: uma `BET` commitada enquanto esperávamos já é visível (READ COMMITTED).
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    if (referenceExternalTransactionId === undefined) {
      throw new Error('pending reference transaction without reference');
    }
    const reference = await this.transactions.findByExternalId(transaction.providerId, referenceExternalTransactionId);
    const reversalsOfReference =
      reference === null ? [] : await this.transactions.findProcessedReversalsOf(reference.id);

    const outcome = this.policy.apply({
      transaction,
      wallet,
      reference,
      reversalsOfReference,
      ledgerEntryId: this.ids.next(),
      at: now,
    });

    if (outcome.decision === WagerDecision.AwaitingReference) {
      const step = this.retry.afterMissedAttempt(attempt, now);
      if (step.kind === 'retry') {
        await this.transactions.scheduleReferenceRetry(transaction.id, attempt, step.nextAttemptAt);
        return { transaction, outcome: PendingReferenceOutcome.Retried, attempt };
      }
      const failureCode = reference === null ? FailureCode.ReferenceNotFound : FailureCode.ReferenceNotProcessed;
      transaction.reject(failureCode, wallet === null ? null : wallet.balance);
      await this.transactions.update(transaction);
      await enqueueWagerOutcomeEvents(
        this.outbox,
        this.ids,
        transaction,
        { decision: WagerDecision.Rejected, failureCode, ledgerEntry: null },
        wallet,
        context,
      );
      return { transaction, outcome: PendingReferenceOutcome.Expired, attempt };
    }

    await this.transactions.update(transaction);
    if (outcome.ledgerEntry !== null) {
      if (wallet === null || expectedVersion === undefined) {
        throw new Error('ledger entry without a locked wallet');
      }
      await this.wallets.updateBalance(wallet, expectedVersion);
      await this.ledger.append(outcome.ledgerEntry);
    }
    await enqueueWagerOutcomeEvents(this.outbox, this.ids, transaction, outcome, wallet, context);

    return {
      transaction,
      outcome:
        outcome.decision === WagerDecision.Rejected
          ? PendingReferenceOutcome.Rejected
          : PendingReferenceOutcome.Processed,
      attempt,
    };
  }
}
