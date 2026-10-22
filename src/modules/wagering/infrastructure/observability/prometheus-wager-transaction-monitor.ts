import { Counter, Histogram, type Registry } from 'prom-client';

import { DuplicateDetection } from '../../application/submit-wager-transaction';
import {
  WagerTransactionMonitor,
  type SubmissionChannel,
  type SubmissionObservation,
} from '../../application/wager-transaction-monitor';
import type { WagerTransaction } from '../../domain/wager-transaction';

/** O caminho feliz leva milissegundos; o teto cobre a espera de lock vezes as tentativas do `UnitOfWork`. */
const PROCESSING_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const PENDING_REFERENCE_WORKER_SOURCE = 'pending_reference_worker';

/**
 * Uma instância por app: as métricas são registradas no `Registry` do app (T13), nunca no global.
 * Sem `walletId`/`providerId` como label (cardinalidade ilimitada) e sem valor financeiro, como no
 * `PrometheusReconciliationMonitor`.
 */
export class PrometheusWagerTransactionMonitor extends WagerTransactionMonitor {
  private readonly transactions: Counter<'status' | 'kind' | 'source'>;
  private readonly duplicates: Counter<'channel' | 'detected_by'>;
  private readonly processing: Histogram<'channel' | 'outcome'>;

  constructor(registry: Registry) {
    super();
    this.transactions = new Counter({
      name: 'wager_transactions_total',
      help: 'Transações decididas por status final ou PENDING_REFERENCE, por tipo e origem (http, sqs, pending_reference_worker); replay não conta',
      labelNames: ['status', 'kind', 'source'],
      registers: [registry],
    });
    this.duplicates = new Counter({
      name: 'wager_transaction_duplicates_total',
      help: 'Duplicatas detectadas por canal (http, sqs) e por mecanismo (idempotency_key, inbox)',
      labelNames: ['channel', 'detected_by'],
      registers: [registry],
    });
    this.processing = new Histogram({
      name: 'wager_transaction_processing_seconds',
      help: 'Latência de uma submissão (SubmitWagerTransaction.execute) por canal e desfecho',
      labelNames: ['channel', 'outcome'],
      buckets: PROCESSING_BUCKETS_SECONDS,
      registers: [registry],
    });
  }

  submissionStarted(channel: SubmissionChannel): SubmissionObservation {
    const end = this.processing.startTimer({ channel });
    return {
      succeeded: (result) => {
        if (result.idempotentReplay) {
          this.duplicates.inc({
            channel,
            detected_by: result.duplicateDetectedBy ?? DuplicateDetection.IdempotencyKey,
          });
          end({ outcome: 'replayed' });
          return;
        }
        const { status, kind } = result.transaction;
        this.transactions.inc({ status, kind, source: channel });
        end({ outcome: status.toLowerCase() });
      },
      failed: () => {
        end({ outcome: 'failed' });
      },
    };
  }

  pendingReferenceDecided(transaction: WagerTransaction): void {
    this.transactions.inc({
      status: transaction.status,
      kind: transaction.kind,
      source: PENDING_REFERENCE_WORKER_SOURCE,
    });
  }
}
