import { Inject, Injectable } from '@nestjs/common';
import { Store, storage } from 'nestjs-pino/storage';
import type pino from 'pino';

import { ROOT_LOGGER } from './logger.config';

export interface LogContextFields {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

/**
 * Contexto de log para trabalho fora de uma requisição HTTP (consumer SQS, workers).
 *
 * Usa o `ROOT_LOGGER` próprio do app e não `PinoLogger.root`: o nestjs-pino guarda o logger de fora
 * de requisição num singleton do módulo, definido pelo primeiro app do processo. Com vários apps no
 * mesmo processo (bun test) esse singleton escreveria no destino errado. Dentro de `run`, o
 * `PinoLogger` lê o mesmo `AsyncLocalStorage` e loga com os campos do contexto.
 */
@Injectable()
export class LogContext {
  constructor(@Inject(ROOT_LOGGER) private readonly root: pino.Logger) {}

  run<T>(bindings: LogContextFields, fn: () => T): T {
    return storage.run(new Store(this.root.child(bindings)), fn);
  }

  /** Logger do escopo atual (requisição HTTP ou `run`), com os campos de contexto; fora de escopo, o `ROOT_LOGGER` do app. */
  current(): pino.Logger {
    return storage.getStore()?.logger ?? this.root;
  }

  /** Acrescenta campos aos logs do restante do escopo atual (também dentro de uma requisição HTTP). */
  assign(bindings: Partial<LogContextFields>): void {
    const store = storage.getStore();
    if (!store) {
      throw new Error('LogContext.assign called outside a log scope');
    }
    store.logger = store.logger.child(bindings);
  }
}
