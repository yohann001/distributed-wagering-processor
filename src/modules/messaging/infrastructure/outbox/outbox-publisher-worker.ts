import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

import type { LogContext } from '../../../../infrastructure/observability/log-context';
import type { Clock } from '../../../../shared/application/clock';
import type { OutboxRepository } from '../../application/outbox-repository';
import type { PublishOutboxBatch, PublishOutboxBatchResult } from '../../application/publish-outbox-batch';
import type { OutboxPublisherOptions } from './outbox-publisher-options';

/** Atraso de publicação vai de milissegundos (caminho feliz) a minutos (SQS fora e retry no teto de 60 s). */
const LAG_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Worker do publisher da outbox (§11): uma instância por réplica, em loop de polling. Cada ciclo é um
 * `PublishOutboxBatch`. Com o lote cheio, o próximo ciclo começa na hora para drenar o backlog; com o lote
 * incompleto (ou vazio, ou falho), o worker espera `pollIntervalMs`. É só transporte e métricas: a correção
 * (um publisher por evento por vez, nada antes do commit) vem do claim por linha do caso de uso.
 */
export class OutboxPublisherWorker {
  private readonly published: Counter<'event_type'>;
  private readonly retries: Counter<'event_type'>;
  private readonly lag: Histogram<'event_type'>;
  private readonly oldestPendingAge: Gauge;
  private running = false;
  private loop: Promise<void> | undefined;
  private pauseAbort: AbortController | undefined;

  constructor(
    private readonly publishBatch: PublishOutboxBatch,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
    private readonly options: OutboxPublisherOptions,
    private readonly logContext: LogContext,
    registry: Registry,
  ) {
    this.published = new Counter({
      name: 'outbox_messages_published_total',
      help: 'Eventos da outbox publicados no SQS, por tipo de evento',
      labelNames: ['event_type'],
      registers: [registry],
    });
    this.retries = new Counter({
      name: 'outbox_publish_retries_total',
      help: 'Eventos da outbox cujo envio falhou e foram reagendados com backoff, por tipo de evento',
      labelNames: ['event_type'],
      registers: [registry],
    });
    this.lag = new Histogram({
      name: 'outbox_publish_lag_seconds',
      help: 'Segundos entre o occurredAt do evento e a sua publicação no SQS, por tipo de evento',
      labelNames: ['event_type'],
      buckets: LAG_BUCKETS_SECONDS,
      registers: [registry],
    });
    this.oldestPendingAge = new Gauge({
      name: 'outbox_oldest_pending_age_seconds',
      help: 'Idade (s) do evento pendente mais antigo da outbox, vencido ou não; 0 sem pendentes. Toda réplica reporta o mesmo valor global: agregue com max',
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
   * por conexão do pool mais `publishTimeoutMs`, abaixo do período de graça do compose. Se o processo morrer antes,
   * a transação do claim é desfeita e outra instância publica.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.pauseAbort?.abort();
    await Promise.allSettled([this.loop]);
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const claimed = await this.logContext.run({ correlationId: Bun.randomUUIDv7() }, () => this.runCycle());
      if (!this.running) {
        break;
      }
      if (claimed < this.options.batchSize) {
        await this.pause(this.options.pollIntervalMs);
      }
    }
  }

  /** Nunca lança: o loop não pode morrer calado, ou a réplica para de publicar. */
  private async runCycle(): Promise<number> {
    let claimed = 0;
    try {
      const result = await this.publishBatch.execute();
      claimed = result.claimed;
      this.record(result);
    } catch (error) {
      // Nunca `error.message`: o erro pode vir do driver e carregar SQL com valores financeiros (§12).
      this.logContext.current().error({ errorName: errorNameOf(error) }, 'outbox publish cycle failed');
    }
    await this.refreshOldestPendingAge();
    return claimed;
  }

  private record(result: PublishOutboxBatchResult): void {
    for (const message of result.published) {
      this.published.inc({ event_type: message.eventType });
      const publishedAt = message.publishedAt;
      if (publishedAt !== undefined) {
        this.lag.observe({ event_type: message.eventType }, (publishedAt.getTime() - message.occurredAt.getTime()) / 1000);
      }
    }
    for (const { message, reason } of result.retried) {
      this.retries.inc({ event_type: message.eventType });
      this.logContext
        .current()
        .warn(
          { eventId: message.id, eventType: message.eventType, reason, attempts: message.attempts },
          'outbox event publish failed',
        );
    }
  }

  private async refreshOldestPendingAge(): Promise<void> {
    try {
      const oldest = await this.outbox.oldestPendingOccurredAt();
      const ageSeconds = oldest === null ? 0 : Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000);
      this.oldestPendingAge.set(ageSeconds);
    } catch (error) {
      this.logContext.current().warn({ errorName: errorNameOf(error) }, 'outbox oldest pending age refresh failed');
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
