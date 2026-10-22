import type { Clock } from '../../../shared/application/clock';
import type { UnitOfWork } from '../../../shared/application/unit-of-work';
import type { ExponentialBackoff } from '../../../shared/domain/exponential-backoff';
import type { OutboxMessage } from '../domain/outbox-message';
import type { IntegrationEventPublisher } from './integration-event-publisher';
import type { OutboxRepository } from './outbox-repository';

export interface PublishOutboxBatchResult {
  claimed: number;
  /** Já com `markPublished` aplicado: o worker lê `occurredAt` e `publishedAt` para a métrica de atraso. */
  published: readonly OutboxMessage[];
  retried: readonly { message: OutboxMessage; reason: string }[];
}

const UNKNOWN_FAILURE_REASON = 'NotPublished';

/**
 * Um ciclo do publisher da outbox (§11, §5.4): reivindica um lote de pendentes vencidas, envia e marca o resultado
 * na mesma transação SQL.
 *
 * - O `FOR UPDATE SKIP LOCKED` do claim segura as linhas do claim até o commit, então dois publishers nunca tratam
 *   o mesmo evento ao mesmo tempo: o segundo pula as linhas travadas, sem esperar.
 * - O claim só enxerga linhas commitadas, então nada é publicado antes do commit da transação financeira.
 * - Se o processo morrer antes do commit, a transação é desfeita e as linhas voltam a ficar pendentes para outra
 *   instância. Se o commit falhar depois de um envio bem-sucedido, o evento é publicado de novo mais tarde: a
 *   entrega é pelo menos uma vez, e o consumidor deduplica por `eventId`.
 * - Envio que falhou vira `scheduleRetry` (backoff), sem limite de tentativas.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxRepository,
    private readonly publisher: IntegrationEventPublisher,
    private readonly clock: Clock,
    private readonly backoff: ExponentialBackoff,
    private readonly batchSize: number,
  ) {}

  execute(): Promise<PublishOutboxBatchResult> {
    // Tudo é lido dentro do trabalho: o `UnitOfWork` pode reexecutá-lo do zero.
    return this.uow.run(async () => {
      const messages = await this.outbox.claimDue(this.clock.now(), this.batchSize);
      if (messages.length === 0) {
        return { claimed: 0, published: [], retried: [] };
      }

      const report = await this.publisher.publish(messages);
      const reasons = new Map(report.failures.map((failure) => [failure.id, failure.reason]));
      const now = this.clock.now();

      const published: OutboxMessage[] = [];
      const retried: { message: OutboxMessage; reason: string }[] = [];
      for (const message of messages) {
        if (report.publishedIds.has(message.id)) {
          message.markPublished(now);
          published.push(message);
        } else {
          message.scheduleRetry(now, this.backoff);
          retried.push({ message, reason: reasons.get(message.id) ?? UNKNOWN_FAILURE_REASON });
        }
        await this.outbox.update(message);
      }
      return { claimed: messages.length, published, retried };
    });
  }
}
