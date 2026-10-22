import { DomainError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import type { Money } from '../../../shared/domain/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Erro de programação: lançamentos são produzidos pela Wallet, nunca pelo cliente.
 * Um lançamento inválido indica bug, não payload errado.
 */
export class InvalidLedgerEntryError extends DomainError {
  readonly code = FailureCode.InvariantViolation;

  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}

export class WalletLedgerEntry {
  /** Cópia própria: Date é mutável mesmo atrás de readonly. */
  private readonly _createdAt: Date;

  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this._createdAt = new Date(createdAt.getTime());
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { direction, money, balanceBefore, balanceAfter, createdAt } = props;
    if (direction !== LedgerDirection.Debit && direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError(`unknown direction ${String(direction)}`);
    }
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError(
        `mixed currencies (money ${money.currency}, before ${balanceBefore.currency}, after ${balanceAfter.currency})`,
      );
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('money must be positive');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('balances must not be negative');
    }
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new InvalidLedgerEntryError('createdAt must be a valid date');
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `${direction} entry ${props.id} of wallet ${props.walletId} (transaction ${props.transactionId}) is not balanced`,
      );
    }
    return entry;
  }

  /** Reconstrói um lançamento já persistido, sem revalidar. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  /** balanceBefore ± money === balanceAfter. Nunca lança: moedas misturadas contam como desbalanceado. */
  isBalanced(): boolean {
    const { currency } = this.money;
    if (this.balanceBefore.currency !== currency || this.balanceAfter.currency !== currency) {
      return false;
    }
    switch (this.direction) {
      case LedgerDirection.Debit:
        return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
      case LedgerDirection.Credit:
        return this.balanceBefore.add(this.money).equals(this.balanceAfter);
      default:
        return false;
    }
  }
}
