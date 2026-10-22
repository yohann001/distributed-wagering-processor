/**
 * Porta da fila de transações (§10). Esconde o SDK da AWS da aplicação. Por enquanto só tem o ping
 * de readiness (T21); o consumer (T22) e o publisher (T23) acrescentam o que precisarem.
 */
export abstract class MessageQueue {
  /** Resolve se a fila responde; rejeita se ela estiver inalcançável ou se `signal` abortar. */
  abstract ping(signal: AbortSignal): Promise<void>;
}
