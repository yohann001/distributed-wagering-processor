import type { IdGenerator } from '../../../shared/application/id-generator';
import type { OutboxRepository } from '../../messaging/application/outbox-repository';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { Wallet } from '../../wallet/domain/wallet';
import { WalletBalanceChanged } from '../../wallet/domain/wallet-balance-changed';
import { WagerDecision, type WagerApplicationOutcome } from '../domain/wager-application-policy';
import type { WagerTransaction } from '../domain/wager-transaction';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/wager-transaction-events';

export interface WagerEventContext {
  correlationId: string;
  causationId: string | undefined;
  occurredAt: Date;
}

/**
 * Grava na outbox os eventos de integração da decisão (§11), na transação em curso. Compartilhado pela submissão e
 * pelo worker de PENDING_REFERENCE: a mesma decisão gera os mesmos eventos por qualquer caminho.
 */
export async function enqueueWagerOutcomeEvents(
  outbox: OutboxRepository,
  ids: IdGenerator,
  transaction: WagerTransaction,
  outcome: WagerApplicationOutcome,
  wallet: Wallet | null,
  context: WagerEventContext,
): Promise<void> {
  const ctx = () => ({ eventId: ids.next(), ...context });

  switch (outcome.decision) {
    case WagerDecision.Applied:
      if (wallet === null) {
        throw new Error('applied transaction without a locked wallet');
      }
      await outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, ctx())));
      await outbox.insert(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx())));
      return;
    case WagerDecision.Recorded:
      await outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, ctx())));
      return;
    case WagerDecision.Rejected:
      await outbox.insert(OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, ctx())));
      return;
    case WagerDecision.AwaitingReference:
      await outbox.insert(OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, ctx())));
      return;
  }
}
