import { InvalidTransactionStateError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import type { Money } from '../../../shared/domain/money';
import type { Wallet } from '../../wallet/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export enum WagerDecision {
  /** PROCESSED com lançamento no ledger. */
  Applied = 'APPLIED',
  /** PROCESSED sem alterar o saldo (LOSS). */
  Recorded = 'RECORDED',
  /** REJECTED por regra de negócio, sem lançamento. */
  Rejected = 'REJECTED',
  /** PENDING_REFERENCE: a referência ainda não pode ser usada. */
  AwaitingReference = 'AWAITING_REFERENCE',
}

export type WagerApplicationOutcome =
  | { decision: WagerDecision.Applied; ledgerEntry: WalletLedgerEntry }
  | { decision: WagerDecision.Recorded; ledgerEntry: null }
  | { decision: WagerDecision.Rejected; failureCode: FailureCode; ledgerEntry: null }
  | { decision: WagerDecision.AwaitingReference; ledgerEntry: null };

export interface ApplyWagerInput {
  /** PENDING ou PENDING_REFERENCE. */
  transaction: WagerTransaction;
  /** Carregada por `transaction.walletId`; null quando não existe. */
  wallet: Wallet | null;
  /** Resolvida por (providerId, referenceExternalTransactionId); null quando não existe. Ignorada sem referência. */
  reference: WagerTransaction | null;
  /** Transações cujo referenceTransactionId é o id de `reference`; vazio quando não há referência. */
  reversalsOfReference: readonly WagerTransaction[];
  ledgerEntryId: string;
  at: Date;
}

/** Kinds que cada kind pode apontar. BET não referencia ninguém. */
const REFERENCE_KINDS: Readonly<
  Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>>
> = {
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
};

const REVERSAL_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/**
 * Decide o destino de uma transação sobre a wallet (§7): aplica, registra sem efeito, rejeita ou aguarda a referência.
 * A ordem das checagens importa e nada é alterado antes de todas passarem.
 */
export class WagerApplicationPolicy {
  apply(input: ApplyWagerInput): WagerApplicationOutcome {
    const { transaction: tx, wallet, ledgerEntryId, at } = input;
    const reference = tx.referenceExternalTransactionId === undefined ? null : input.reference;
    this.assertApplicable(tx, wallet, reference);

    if (wallet === null) {
      return this.reject(tx, FailureCode.WalletNotFound, null);
    }
    const walletRejection = this.checkWallet(tx, wallet);
    if (walletRejection !== null) {
      return walletRejection;
    }

    if (tx.referenceExternalTransactionId !== undefined) {
      const referenceOutcome = this.checkReference(tx, wallet, reference, input.reversalsOfReference);
      if (referenceOutcome !== null) {
        return referenceOutcome;
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed({
        at,
        balanceAfter: wallet.balance,
        referenceTransactionId: reference?.id,
      });
      return { decision: WagerDecision.Recorded, ledgerEntry: null };
    }

    const direction = tx.ledgerDirectionFor(reference ?? undefined);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      const code =
        tx.kind === WagerTransactionKind.Rollback
          ? FailureCode.ReversalInsufficientFunds
          : FailureCode.InsufficientFunds;
      return this.reject(tx, code, wallet.balance);
    }

    const movement = { money: tx.money, transactionId: tx.id, ledgerEntryId, at };
    const ledgerEntry =
      direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed({
      at,
      balanceAfter: ledgerEntry.balanceAfter,
      referenceTransactionId: reference?.id,
    });
    return { decision: WagerDecision.Applied, ledgerEntry };
  }

  /** Erros de programação: precisam lançar antes de qualquer mutação. */
  private assertApplicable(
    tx: WagerTransaction,
    wallet: Wallet | null,
    reference: WagerTransaction | null,
  ): void {
    if (tx.isTerminal()) {
      throw new InvalidTransactionStateError(tx.id, tx.status, 'apply');
    }
    // Dado reidratado com status desconhecido ou kind interno (OPENING) não pode ser aplicado.
    if (
      tx.status !== WagerTransactionStatus.Pending &&
      tx.status !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidTransactionStateError(tx.id, tx.status, 'apply');
    }
    if (!WagerTransaction.isSubmittableKind(tx.kind)) {
      throw new InvalidWagerTransactionError(`${tx.kind} cannot be applied by the provider policy`);
    }
    // `create` já barra; aqui protege dado reidratado, que creditaria antes de markProcessed lançar.
    if (tx.requiresReference() && tx.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(`${tx.kind} without reference cannot be applied`);
    }
    if (wallet !== null && wallet.id !== tx.walletId) {
      throw new InvalidWagerTransactionError('wallet does not belong to the transaction');
    }
    if (reference !== null && reference.externalTransactionId !== tx.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError('reference resolved for another id');
    }
  }

  /** Wallet de outro player ou de outra moeda não expõe o saldo na rejeição. */
  private checkWallet(tx: WagerTransaction, wallet: Wallet): WagerApplicationOutcome | null {
    if (wallet.playerId !== tx.playerId) {
      return this.reject(tx, FailureCode.WalletPlayerMismatch, null);
    }
    if (wallet.currency !== tx.money.currency) {
      return this.reject(tx, FailureCode.CurrencyMismatch, null);
    }
    return null;
  }

  private checkReference(
    tx: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | null,
    reversalsOfReference: readonly WagerTransaction[],
  ): WagerApplicationOutcome | null {
    const allowedKinds = REFERENCE_KINDS[tx.kind];
    if (allowedKinds === undefined) {
      return this.reject(tx, FailureCode.InvalidReferenceKind, wallet.balance);
    }
    if (reference === null) {
      return this.awaitReference(tx);
    }
    if (!this.sharesScope(tx, reference)) {
      return this.reject(tx, FailureCode.ReferenceMismatch, wallet.balance);
    }
    if (!allowedKinds.has(reference.kind)) {
      return this.reject(tx, FailureCode.InvalidReferenceKind, wallet.balance);
    }
    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return this.awaitReference(tx);
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return this.reject(tx, FailureCode.ReferenceNotProcessed, wallet.balance);
    }
    if (!REVERSAL_KINDS.has(tx.kind)) {
      return null;
    }
    if (!tx.money.equals(reference.money)) {
      return this.reject(tx, FailureCode.ReferenceAmountMismatch, wallet.balance);
    }
    if (reversalsOfReference.some((other) => this.blocksReversal(tx, reference, other))) {
      return this.reject(tx, FailureCode.AlreadyReversed, wallet.balance);
    }
    return null;
  }

  private sharesScope(tx: WagerTransaction, reference: WagerTransaction): boolean {
    return (
      tx.providerId === reference.providerId &&
      tx.playerId === reference.playerId &&
      tx.walletId === reference.walletId &&
      tx.money.currency === reference.money.currency &&
      tx.roundId === reference.roundId
    );
  }

  /**
   * Mais estrito que a letra do §7 regra 4: numa BET, REFUND e ROLLBACK se excluem
   * (senão a mesma aposta seria creditada duas vezes). WIN/LOSS que apontam a BET nunca bloqueiam.
   */
  private blocksReversal(
    tx: WagerTransaction,
    reference: WagerTransaction,
    other: WagerTransaction,
  ): boolean {
    return (
      other.referenceTransactionId === reference.id &&
      REVERSAL_KINDS.has(other.kind) &&
      other.status === WagerTransactionStatus.Processed &&
      other.id !== tx.id &&
      (other.kind === tx.kind || reference.kind === WagerTransactionKind.Bet)
    );
  }

  private awaitReference(tx: WagerTransaction): WagerApplicationOutcome {
    tx.markPendingReference();
    return { decision: WagerDecision.AwaitingReference, ledgerEntry: null };
  }

  private reject(
    tx: WagerTransaction,
    failureCode: FailureCode,
    balance: Money | null,
  ): WagerApplicationOutcome {
    tx.reject(failureCode, balance);
    return { decision: WagerDecision.Rejected, failureCode, ledgerEntry: null };
  }
}
