import type { WagerTransaction } from '../domain/wager-transaction';
import type { SubmitWagerTransactionResult } from './submit-wager-transaction';

export type SubmissionChannel = 'http' | 'sqs';

export interface SubmissionObservation {
  succeeded(result: SubmitWagerTransactionResult): void;
  failed(): void;
}

/** Porta de métricas do processamento de transações (§12). Implementação nunca registra valor financeiro. */
export abstract class WagerTransactionMonitor {
  /** Abre a medição de uma submissão; chamada uma vez por `execute`, fechada depois do commit (ou da falha). */
  abstract submissionStarted(channel: SubmissionChannel): SubmissionObservation;
  /** O worker decidiu uma `PENDING_REFERENCE` (agora `PROCESSED` ou `REJECTED`). */
  abstract pendingReferenceDecided(transaction: WagerTransaction): void;
}
