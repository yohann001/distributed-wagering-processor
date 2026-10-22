import { DomainError, InvalidTransactionStateError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import { InvalidMoneyError, type Money } from '../../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca aceito pela API nem pela fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada (§7.1). */
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Códigos que uma transação pode carregar em REJECTED: a coluna "REJECTED persistido" da tabela
 * de códigos do ARCHITECTURE.md. Os de resposta síncrona e os de infraestrutura ficam de fora.
 */
const PERSISTED_REJECTION_CODES: ReadonlySet<FailureCode> = new Set([
  FailureCode.CurrencyMismatch,
  FailureCode.WalletNotFound,
  FailureCode.WalletPlayerMismatch,
  FailureCode.InsufficientFunds,
  FailureCode.ReversalInsufficientFunds,
  FailureCode.ReferenceNotFound,
  FailureCode.ReferenceMismatch,
  FailureCode.InvalidReferenceKind,
  FailureCode.ReferenceAmountMismatch,
  FailureCode.ReferenceNotProcessed,
  FailureCode.AlreadyReversed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id no provedor, não o id interno. Obrigatório para REFUND e ROLLBACK. */
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

/** OPENING nasce PROCESSED em createdAt, com balanceAfter = money. */
export type CreateOpeningProps = Omit<
  CreateWagerTransactionProps,
  'kind' | 'referenceExternalTransactionId'
>;

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Saldo da wallet observado na decisão (PROCESSED/REJECTED), devolvido no replay (§7 regra 7). */
  balanceAfter?: Money | undefined;
}

export interface MarkProcessedProps {
  at: Date;
  balanceAfter: Money;
  /** Id interno da referência resolvida. Obrigatório para REFUND e ROLLBACK. */
  referenceTransactionId?: string | undefined;
}

export class KindNotAllowedError extends DomainError {
  readonly code = FailureCode.KindNotAllowed;

  constructor(readonly kind: string) {
    super(`Transaction kind ${kind} is not allowed`);
  }
}

export class ReferenceRequiredError extends DomainError {
  readonly code = FailureCode.ReferenceRequired;

  constructor(readonly kind: string) {
    super(`Transaction kind ${kind} requires referenceExternalTransactionId`);
  }
}

/** Mesma idempotency key (ou mesmo id externo) com outro payload (§6.3, §9): conflito, não replay. Nada é gravado. */
export class IdempotencyConflictError extends DomainError {
  readonly code = FailureCode.IdempotencyConflict;

  constructor(
    readonly providerId: string,
    readonly idempotencyKey: string,
  ) {
    super(`Idempotency key of provider ${providerId} was already used with a different payload`);
  }
}

/**
 * Outra transação com a mesma key ou o mesmo id externo commitou primeiro (corrida de inserção). Traduzido
 * da unique constraint pelo adapter; o caso de uso refaz o trabalho numa transação nova, que devolve replay
 * ou conflito. Se escapar, reenviar resolve.
 */
export class WagerTransactionAlreadyExistsError extends DomainError {
  readonly code = FailureCode.TransientFailure;

  constructor(
    readonly providerId: string,
    readonly constraint: string,
  ) {
    super(`A wager transaction of provider ${providerId} already exists (${constraint})`);
  }
}

/** Erro de programação: o caso de uso ou a política chamou a entidade com argumentos incoerentes. */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = FailureCode.InvariantViolation;

  constructor(reason: string) {
    super(`Invalid wager transaction: ${reason}`);
  }
}

const REQUIRED_TEXT_FIELDS = [
  'id',
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'payloadHash',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
] as const;

/** Erro de programação: a borda (T19/T22) valida com zod antes. As mensagens citam só o nome do campo. */
function assertNotBlank(field: string, value: unknown): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidWagerTransactionError(`${field} must not be blank`);
  }
}

function assertRequiredFields(props: CreateOpeningProps): void {
  for (const field of REQUIRED_TEXT_FIELDS) {
    assertNotBlank(field, props[field]);
  }
  if (!(props.createdAt instanceof Date) || Number.isNaN(props.createdAt.getTime())) {
    throw new InvalidWagerTransactionError('createdAt must be a valid date');
  }
}

export class WagerTransaction {
  private readonly _createdAt: Date;
  private _processedAt: Date | undefined;

  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    processedAt: Date | undefined,
    private _balanceAfter: Money | undefined,
  ) {
    this._createdAt = new Date(createdAt.getTime());
    this._processedAt = processedAt === undefined ? undefined : new Date(processedAt.getTime());
  }

  /** Transação vinda de provedor (API ou fila). Nasce PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId } = props;
    if (!WagerTransaction.isSubmittableKind(kind)) {
      throw new KindNotAllowedError(String(kind));
    }
    assertRequiredFields(props);
    if (WagerTransaction.kindRequiresReference(kind) && !referenceExternalTransactionId) {
      throw new ReferenceRequiredError(kind);
    }
    // '' vira undefined (contrato do payload hash); só espaços não é referência.
    if (referenceExternalTransactionId !== undefined && referenceExternalTransactionId !== '') {
      assertNotBlank('referenceExternalTransactionId', referenceExternalTransactionId);
    }
    // LOSS só registra o resultado; os demais geram lançamento, que exige valor positivo.
    if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
      throw new InvalidMoneyError(`amount must be positive for ${kind}`);
    }
    if (money.isNegative()) {
      throw new InvalidMoneyError('amount must not be negative');
    }
    return WagerTransaction.rehydrate({
      ...props,
      referenceExternalTransactionId: referenceExternalTransactionId || undefined,
      status: WagerTransactionStatus.Pending,
    });
  }

  /** Kinds que um provedor pode submeter (tudo menos OPENING). */
  static isSubmittableKind(kind: string): boolean {
    return SUBMITTABLE_KINDS.has(kind);
  }

  /** Crédito interno de abertura da wallet: único caminho para um OPENING. */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    assertRequiredFields(props);
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('opening requires a positive amount');
    }
    return WagerTransaction.rehydrate({
      ...props,
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Processed,
      processedAt: props.createdAt,
      balanceAfter: props.money,
    });
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt.getTime());
  }

  // ---- transições

  markProcessed(props: MarkProcessedProps): void {
    this.assertNotTerminal('markProcessed');
    const { at, balanceAfter, referenceTransactionId } = props;
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidWagerTransactionError(`${this.kind} must be processed with its reference`);
    }
    this.assertObservedBalance(balanceAfter);
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new InvalidWagerTransactionError('processedAt must be a valid date');
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId || undefined;
    this._processedAt = new Date(at.getTime());
    this._balanceAfter = balanceAfter;
  }

  /** Idempotente a partir de PENDING_REFERENCE: o worker reavalia sem mudar de estado. */
  markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');
    // Vale para qualquer kind com referência (§7 regra 8), inclusive WIN apontando a BET.
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError('a transaction without reference cannot wait for one');
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  /**
   * Rejeição de negócio. balanceAfter é o saldo observado na decisão, devolvido no replay;
   * null quando não há saldo a expor (wallet inexistente, de outro player ou de outra moeda).
   */
  reject(code: FailureCode, balanceAfter: Money | null): void {
    this.assertNotTerminal('reject');
    if (!PERSISTED_REJECTION_CODES.has(code)) {
      throw new InvalidWagerTransactionError(`${code} is not a persisted business rejection`);
    }
    if (balanceAfter !== null) {
      this.assertObservedBalance(balanceAfter);
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter ?? undefined;
  }

  /** Erro permanente de infraestrutura, registrado para auditoria. */
  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    if (code !== FailureCode.PermanentFailure) {
      throw new InvalidWagerTransactionError(`${code} is not a permanent failure`);
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return WagerTransaction.kindRequiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverte a direção da referência. LOSS não gera lançamento. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        return WagerTransaction.invertedDirectionOf(reference);
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not produce a ledger entry');
      default:
        throw new InvalidWagerTransactionError(`unknown kind ${String(this.kind)}`);
    }
  }

  private static invertedDirectionOf(reference: WagerTransaction | undefined): LedgerDirection {
    if (reference === undefined) {
      throw new InvalidWagerTransactionError('ROLLBACK requires the reference to pick a direction');
    }
    switch (reference.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Debit;
      default:
        throw new InvalidWagerTransactionError(`ROLLBACK cannot reverse ${reference.kind}`);
    }
  }

  private static kindRequiresReference(kind: WagerTransactionKind): boolean {
    return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, transition);
    }
  }

  private assertObservedBalance(balance: Money): void {
    if (balance.currency !== this.money.currency) {
      throw new InvalidWagerTransactionError(
        `balance currency ${balance.currency} differs from transaction currency ${this.money.currency}`,
      );
    }
    if (balance.isNegative()) {
      throw new InvalidWagerTransactionError('observed balance must not be negative');
    }
  }
}
