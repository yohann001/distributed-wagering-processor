import { Counter, type Registry } from 'prom-client';

import type { LogContext } from '../../../../infrastructure/observability/log-context';
import {
  PendingReferenceOutcome,
  type ReprocessedPendingReference,
  type ReprocessPendingReferences,
} from '../../application/reprocess-pending-references';
import type { PendingReferenceWorkerOptions } from './pending-reference-worker-options';

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Worker de `PENDING_REFERENCE` (§7.1): uma instância por réplica, em loop de polling. Cada ciclo é um
 * `ReprocessPendingReferences`. Com o lote cheio, o próximo ciclo começa na hora para drenar o backlog vencido; com o
 * lote incompleto (ou vazio, ou falho), o worker espera `pollIntervalMs`. É só transporte e métricas: a correção
 * (uma aplicação por transação, mesma política da submissão) vem do claim por linha do caso de uso.
 */
export class PendingReferenceWorker {
  private readonly reprocessed: Counter<'outcome'>;
  private running = false;
  private loop: Promise<void> | undefined;
  private pauseAbort: AbortController | undefined;

  constructor(
    private readonly reprocess: ReprocessPendingReferences,
    private readonly options: PendingReferenceWorkerOptions,
    private readonly logContext: LogContext,
    registry: Registry,
  ) {
    this.reprocessed = new Counter({
      name: 'pending_reference_reprocessed_total',
      help: 'Reavaliações de transações PENDING_REFERENCE pelo worker, por resultado',
      labelNames: ['outcome'],
      registers: [registry],
    });
  }

  start(): void {
    if (!this.options.enabled || this.running) {
      return;
    }
    this.running = true;
    this.loop = this.pollLoop();
  }

  /**
   * Idempotente e seguro sem `start`. Interrompe a pausa e espera o ciclo em andamento: ele é limitado pela espera
   * por conexão do pool e pelo timeout de lock do `UnitOfWork`. Se o processo morrer antes, a transação do claim é
   * desfeita e outra instância reavalia.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.pauseAbort?.abort();
    await Promise.allSettled([this.loop]);
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const correlationId = Bun.randomUUIDv7();
      const count = await this.logContext.run({ correlationId }, () => this.runCycle(correlationId));
      if (!this.running) {
        break;
      }
      if (count < this.options.batchSize) {
        await this.pause(this.options.pollIntervalMs);
      }
    }
  }

  /** Nunca lança: o loop não pode morrer calado, ou a réplica para de reavaliar. */
  private async runCycle(correlationId: string): Promise<number> {
    try {
      const result = await this.reprocess.execute(correlationId);
      for (const item of result.reprocessed) {
        this.record(item);
      }
      return result.reprocessed.length;
    } catch (error) {
      // Nunca `error.message`: o erro pode vir do driver e carregar SQL com valores financeiros (§12).
      this.logContext.current().error({ errorName: errorNameOf(error) }, 'pending reference cycle failed');
      return 0;
    }
  }

  private record({ transaction, outcome, attempt }: ReprocessedPendingReference): void {
    this.reprocessed.inc({ outcome });
    const fields = {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      outcome,
      attempt,
      ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    };
    const logger = this.logContext.current();
    switch (outcome) {
      case PendingReferenceOutcome.Processed:
      case PendingReferenceOutcome.Rejected:
        logger.info(fields, 'pending reference reprocessed');
        return;
      case PendingReferenceOutcome.Retried:
        logger.debug(fields, 'pending reference reprocessed');
        return;
      case PendingReferenceOutcome.Expired:
        logger.warn(fields, 'pending reference reprocessed');
        return;
    }
  }

  /** Sleep que o `stop` interrompe. */
  private pause(ms: number): Promise<void> {
    const abort = new AbortController();
    this.pauseAbort = abort;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
