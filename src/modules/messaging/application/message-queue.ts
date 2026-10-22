/**
 * Porta da fila de transações (§10). Esconde o SDK da AWS da aplicação. Só tem o ping de readiness (T21): o consumer
 * (T22) é um adapter de entrada e o publisher (T23) usa a própria porta de saída, `IntegrationEventPublisher`
 * (outra fila), então nenhum dos dois estende esta.
 */
export abstract class MessageQueue {
  /** Resolve se a fila responde; rejeita se ela estiver inalcançável ou se `signal` abortar. */
  abstract ping(signal: AbortSignal): Promise<void>;
}
