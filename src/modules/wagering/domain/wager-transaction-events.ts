import type { FailureCode } from '../../../shared/domain/failure-code';
import {
  IntegrationEvent,
  InvalidIntegrationEventError,
  type EventContext,
  type IntegrationEventProps,
} from '../../../shared/domain/integration-event';
import type { Money, MoneyProps } from '../../../shared/domain/money';
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from './wager-transaction';

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  /** Id interno da referência resolvida (REFUND, ROLLBACK e WIN/LOSS que apontam uma BET). */
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  /** Ausente quando não há saldo a expor: wallet inexistente, de outro player ou de outra moeda. */
  balanceAfter?: MoneyProps;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
}

/** Cópia em objeto literal: o evento nunca guarda a instância de Money. */
function moneyProps(money: Money): MoneyProps {
  const { amount, currency } = money.toJSON();
  return { amount, currency };
}

function baseData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: moneyProps(tx.money),
    ...(tx.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: tx.referenceExternalTransactionId }),
  };
}

/** Qualquer transação aplicada, inclusive LOSS (sem lançamento) e OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionProcessed requires a PROCESSED transaction, ${tx.id} is ${tx.status}`,
      );
    }
    const balanceAfter = tx.balanceAfter;
    if (balanceAfter === undefined) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionProcessed requires the observed balance, ${tx.id} has none`,
      );
    }
    const referenceTransactionId = tx.referenceTransactionId;
    const data: WagerTransactionProcessedData = {
      ...baseData(tx),
      ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
      balanceAfter: moneyProps(balanceAfter),
    };
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.id, data });
  }
}

/** Rejeição de negócio persistida como REJECTED. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const failureCode = tx.failureCode;
    if (tx.status !== WagerTransactionStatus.Rejected || failureCode === undefined) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionRejected requires a REJECTED transaction with a failure code, ${tx.id} is ${tx.status}`,
      );
    }
    const balanceAfter = tx.balanceAfter;
    const data: WagerTransactionRejectedData = {
      ...baseData(tx),
      failureCode,
      ...(balanceAfter === undefined ? {} : { balanceAfter: moneyProps(balanceAfter) }),
    };
    return new WagerTransactionRejected({ ...ctx, aggregateId: tx.id, data });
  }
}

/** Referência ainda ausente: a transação espera em PENDING_REFERENCE (§7.1). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const referenceExternalTransactionId = tx.referenceExternalTransactionId;
    if (
      tx.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined
    ) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionPendingReference requires a PENDING_REFERENCE transaction with a reference, ${tx.id} is ${tx.status}`,
      );
    }
    const data: WagerTransactionPendingReferenceData = {
      ...baseData(tx),
      referenceExternalTransactionId,
    };
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: tx.id, data });
  }
}
