import type { OutboxMessage } from '../domain/outbox-message';

export interface PublishFailure {
  id: string;
  /** Nome do erro ou código do SQS, nunca a mensagem: ela pode trazer endpoint, URL da fila ou valores (§12). */
  reason: string;
}

export interface PublishReport {
  publishedIds: ReadonlySet<string>;
  failures: readonly PublishFailure[];
}

/**
 * Porta de saída dos eventos de integração (§11). Entrega pelo menos uma vez: o mesmo evento pode chegar duas vezes
 * ao destino e o consumidor deduplica por `eventId`. Nunca lança: falha do envio inteiro vira `failures` para todas
 * as mensagens.
 */
export abstract class IntegrationEventPublisher {
  abstract publish(messages: readonly OutboxMessage[]): Promise<PublishReport>;
}
