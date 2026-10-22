import { DomainError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import { CurrencyMismatchError, Money } from '../../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openedAt: Date;
  /** Obrigatório quando initialBalance > 0: ids da transação OPENING e do seu lançamento CREDIT. */
  opening?: { transactionId: string; ledgerEntryId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  /** CREDIT de abertura; null quando o saldo inicial é zero. */
  openingEntry: WalletLedgerEntry | null;
}

export interface WalletMovementProps {
  money: Money;
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

/** Recusa de débito. A política (T06) decide se o código final é INSUFFICIENT_FUNDS ou REVERSAL_INSUFFICIENT_FUNDS. */
export class InsufficientFundsError extends DomainError {
  readonly code = FailureCode.InsufficientFunds;

  constructor(readonly walletId: string) {
    super(`Insufficient funds in wallet ${walletId}`);
  }
}

/** Já existe wallet para playerId + currency (§6.2). Detectado pela constraint do banco, nunca por consulta prévia. */
export class WalletAlreadyExistsError extends DomainError {
  readonly code = FailureCode.WalletAlreadyExists;

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`A wallet already exists for player ${playerId} in ${currency}`);
  }
}

/** Erro de programação: abertura chamada com dados incoerentes pelo caso de uso. */
export class InvalidWalletOpeningError extends DomainError {
  readonly code = FailureCode.InvariantViolation;

  constructor(reason: string) {
    super(`Invalid wallet opening: ${reason}`);
  }
}

export class Wallet {
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
    private _lastLedgerEntryId: string | undefined,
  ) {
    this._createdAt = new Date(createdAt.getTime());
    this._updatedAt = new Date(updatedAt.getTime());
  }

  /**
   * Nasce com version 1. Saldo inicial > 0 já vem com o CREDIT de abertura,
   * para que saldo e ledger sejam consistentes desde a criação.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    const { id, playerId, initialBalance, openedAt, opening } = props;
    // Erro de programação: a borda (T19) valida com zod antes.
    for (const [field, value] of [['id', id], ['playerId', playerId]] as const) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidWalletOpeningError(`${field} must not be blank`);
      }
    }
    if (!(openedAt instanceof Date) || Number.isNaN(openedAt.getTime())) {
      throw new InvalidWalletOpeningError('openedAt must be a valid date');
    }
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOpeningError('initial balance must not be negative');
    }
    if (initialBalance.isPositive() && opening === undefined) {
      throw new InvalidWalletOpeningError('a positive initial balance requires an opening transaction');
    }
    if (initialBalance.isZero() && opening !== undefined) {
      throw new InvalidWalletOpeningError('a zero initial balance must not have an opening transaction');
    }

    const zero = Money.zero(initialBalance.currency);
    const openingEntry =
      opening === undefined
        ? null
        : WalletLedgerEntry.create({
            id: opening.ledgerEntryId,
            walletId: id,
            transactionId: opening.transactionId,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: zero,
            balanceAfter: initialBalance,
            createdAt: openedAt,
          });

    const wallet = new Wallet(
      id,
      playerId,
      initialBalance.currency,
      openingEntry?.balanceAfter ?? zero,
      1,
      openedAt,
      openedAt,
      openingEntry?.id,
    );
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
      undefined,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  /** Id do lançamento aplicado por esta instância; undefined em wallet reidratada sem movimento. */
  get lastLedgerEntryId(): string | undefined {
    return this._lastLedgerEntryId;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  /** O novo saldo sai do lançamento; qualquer erro ocorre antes de alterar o estado. */
  private apply(direction: LedgerDirection, props: WalletMovementProps): WalletLedgerEntry {
    const { money, transactionId, ledgerEntryId, at } = props;
    const balanceAfter =
      direction === LedgerDirection.Debit ? this._balance.subtract(money) : this._balance.add(money);
    const entry = WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: at,
    });

    this._balance = entry.balanceAfter;
    this._version += 1;
    this._updatedAt = entry.createdAt;
    this._lastLedgerEntryId = entry.id;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
