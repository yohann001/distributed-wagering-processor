/** O que o chamador deve fazer diante de uma falha. */
export enum FailureAction {
  /** Reenviar o mesmo request pode dar certo. */
  Retry = 'RETRY',
  /** O request está errado: corrigir e enviar com nova idempotency key. */
  FixPayload = 'FIX_PAYLOAD',
  /** Resultado terminal: não reenviar. */
  GiveUp = 'GIVE_UP',
}

/**
 * Os valores são contrato público (persistidos e expostos): nunca renomear nem reutilizar, só adicionar.
 */
export enum FailureCode {
  // Payload/contrato
  InvalidPayload = 'INVALID_PAYLOAD',
  InvalidMoney = 'INVALID_MONEY',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  KindNotAllowed = 'KIND_NOT_ALLOWED',
  ReferenceRequired = 'REFERENCE_REQUIRED',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',

  // Wallet
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',

  // Saldo
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',

  // Referência
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed = 'ALREADY_REVERSED',

  // Infraestrutura/interno
  TransientFailure = 'TRANSIENT_FAILURE',
  PermanentFailure = 'PERMANENT_FAILURE',
  InvariantViolation = 'INVARIANT_VIOLATION',
}

export const FAILURE_ACTIONS: Readonly<Record<FailureCode, FailureAction>> = Object.freeze({
  [FailureCode.InvalidPayload]: FailureAction.FixPayload,
  [FailureCode.InvalidMoney]: FailureAction.FixPayload,
  [FailureCode.CurrencyMismatch]: FailureAction.FixPayload,
  [FailureCode.KindNotAllowed]: FailureAction.FixPayload,
  [FailureCode.ReferenceRequired]: FailureAction.FixPayload,
  [FailureCode.IdempotencyConflict]: FailureAction.FixPayload,
  [FailureCode.WalletNotFound]: FailureAction.FixPayload,
  [FailureCode.WalletPlayerMismatch]: FailureAction.FixPayload,
  [FailureCode.WalletAlreadyExists]: FailureAction.GiveUp,
  [FailureCode.InsufficientFunds]: FailureAction.GiveUp,
  [FailureCode.ReversalInsufficientFunds]: FailureAction.GiveUp,
  [FailureCode.ReferenceNotFound]: FailureAction.FixPayload,
  [FailureCode.ReferenceMismatch]: FailureAction.FixPayload,
  [FailureCode.InvalidReferenceKind]: FailureAction.FixPayload,
  [FailureCode.ReferenceAmountMismatch]: FailureAction.FixPayload,
  [FailureCode.ReferenceNotProcessed]: FailureAction.GiveUp,
  [FailureCode.AlreadyReversed]: FailureAction.GiveUp,
  [FailureCode.TransientFailure]: FailureAction.Retry,
  [FailureCode.PermanentFailure]: FailureAction.GiveUp,
  [FailureCode.InvariantViolation]: FailureAction.GiveUp,
});

export function failureActionOf(code: FailureCode): FailureAction {
  return FAILURE_ACTIONS[code];
}
