import pino from 'pino';
import type { Options, StdSerializedResults } from 'pino-http';

import type { Env } from '../../config/env';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_RESPONSE_HEADER,
  resolveCorrelationId,
} from './correlation-id';

/** Tokens de DI: destino de escrita do pino e logger raiz, um por app (a suíte de testes troca o destino). */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');
export const ROOT_LOGGER = Symbol('ROOT_LOGGER');

/** Campos financeiros e de corpo que nunca vão para o log (§12). Cobre o nível raiz e um nível de aninhamento. */
export const REDACTED_LOG_FIELDS = [
  'money',
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'storedBalance',
  'calculatedBalance',
  'difference',
  'payload',
  'body',
  'data',
] as const;

export const REDACT_CENSOR = '[REDACTED]';

/** Opções da raiz do pino: nível, `instanceId` no lugar de `pid`/`hostname`, timestamp ISO e redaction. */
export function buildLoggerOptions(env: Pick<Env, 'LOG_LEVEL' | 'INSTANCE_ID'>): pino.LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    base: { instanceId: env.INSTANCE_ID },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACTED_LOG_FIELDS.flatMap((field) => [field, `*.${field}`]),
      censor: REDACT_CENSOR,
    },
  };
}

/** Probes e scrape de métricas não geram a linha "request completed"; o `correlationId` continua valendo. */
function isProbe(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return path === '/metrics' || (path?.startsWith('/health/') ?? false);
}

/** Opções do `pino-http`: `correlationId` por requisição e serializers mínimos (sem headers, corpo ou query). */
export function buildPinoHttpOptions(logger: pino.Logger): Options {
  return {
    logger,
    genReqId: (req, res) => {
      const id = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
      res.setHeader(CORRELATION_ID_RESPONSE_HEADER, id);
      return id;
    },
    // O logger da requisição vira `logger.child({ correlationId })`, sem o objeto `req` inteiro.
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'correlationId' },
    serializers: {
      req: (req: StdSerializedResults['req']) => ({
        method: req.method,
        url: (req.url ?? '').split('?')[0],
      }),
      res: (res: StdSerializedResults['res']) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req) => isProbe(req.url) },
  };
}
