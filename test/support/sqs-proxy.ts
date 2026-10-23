import { loadEnv } from '../../src/config/env';

export interface SqsCall {
  operation: string;
  body: Record<string, unknown>;
}

export interface SqsProxy {
  /** Origem do proxy (`http://127.0.0.1:<porta>`), para o `AWS_ENDPOINT_URL` do filho. */
  readonly endpoint: string;
  /** A mesma URL de fila com a origem trocada pela do proxy (o SDK usa a URL da fila como endpoint). */
  queueUrl(url: string): string;
  /** Chamadas já recebidas da operação (`'DeleteMessage'`, `'SendMessageBatch'`, ...), na ordem de chegada. */
  calls(operation: string): SqsCall[];
  /** A partir de agora a operação nunca sai para o LocalStack: a requisição fica pendurada (ack perdido). */
  holdRequests(operation: string): void;
  /** A partir de agora a operação vai para o LocalStack, mas a resposta fica pendurada (o efeito aconteceu, o cliente não sabe). */
  holdResponses(operation: string): void;
  /** Atraso antes de encaminhar cada chamada da operação. */
  delay(operation: string, ms: number): void;
  /** Quantas chamadas da operação estão penduradas agora. */
  held(operation: string): number;
  stop(): Promise<void>;
}

const TARGET_PREFIX = 'AmazonSQS.';
const UNKNOWN_OPERATION = 'unknown';
const HELD_STATUS = 503;
// O corpo já chega decodificado do `fetch`: repassar estes cabeçalhos faria o cliente decodificar de novo ou truncar.
const DROPPED_REQUEST_HEADERS = ['host', 'content-length'];
const DROPPED_RESPONSE_HEADERS = ['content-encoding', 'content-length'];

function operationOf(request: Request): string {
  const target = request.headers.get('x-amz-target');
  return target === null ? UNKNOWN_OPERATION : target.replace(TARGET_PREFIX, '');
}

function parseBody(text: string): Record<string, unknown> {
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/**
 * Proxy HTTP na frente do LocalStack real, para derrubar um processo filho num ponto exato de uma chamada ao SQS.
 * O filho é um processo de verdade (`bun src/main.ts`), então não dá para injetar a falha no cliente como o
 * `faultySqsClient`: ela entra na rede. O proxy registra as chamadas por operação e encaminha toda chamada ao
 * LocalStack; quando armado, segura uma operação, seja a requisição (ela nunca chega ao SQS, como um ack perdido),
 * seja a resposta (o SQS aplicou o efeito e o cliente não sabe). O teste dá o `SIGKILL` com a chamada pendurada.
 * Não é mock: nunca inventa uma resposta, só atrasa, segura ou repassa a do LocalStack.
 */
export function startSqsProxy(): SqsProxy {
  const upstream = loadEnv().AWS_ENDPOINT_URL;
  if (upstream === undefined) {
    throw new Error('the SQS proxy needs AWS_ENDPOINT_URL: it only fronts the LocalStack');
  }

  const recorded = new Map<string, SqsCall[]>();
  const requestHolds = new Set<string>();
  const responseHolds = new Set<string>();
  const delays = new Map<string, number>();
  const heldCounts = new Map<string, number>();
  const releases: (() => void)[] = [];

  /** Pendura a chamada até o `stop`; o contador diz quantas estão penduradas agora. */
  async function hold(operation: string): Promise<Response> {
    heldCounts.set(operation, (heldCounts.get(operation) ?? 0) + 1);
    try {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    } finally {
      heldCounts.set(operation, (heldCounts.get(operation) ?? 1) - 1);
    }
    return new Response(null, { status: HELD_STATUS });
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // Uma chamada pendurada pode durar o teste inteiro: o servidor não pode fechá-la por ociosidade.
    idleTimeout: 0,
    async fetch(request) {
      const operation = operationOf(request);
      const text = await request.text();
      const calls = recorded.get(operation) ?? [];
      calls.push({ operation, body: parseBody(text) });
      recorded.set(operation, calls);

      if (requestHolds.has(operation)) {
        return hold(operation);
      }
      const delayMs = delays.get(operation);
      if (delayMs !== undefined) {
        await Bun.sleep(delayMs);
      }

      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      for (const name of DROPPED_REQUEST_HEADERS) {
        headers.delete(name);
      }
      const forwarded = await fetch(`${upstream}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: text === '' ? undefined : text,
      });
      const payload = await forwarded.arrayBuffer();

      if (responseHolds.has(operation)) {
        return hold(operation);
      }
      const responseHeaders = new Headers(forwarded.headers);
      for (const name of DROPPED_RESPONSE_HEADERS) {
        responseHeaders.delete(name);
      }
      return new Response(payload, { status: forwarded.status, headers: responseHeaders });
    },
  });

  const endpoint = `http://127.0.0.1:${String(server.port)}`;

  return {
    endpoint,
    queueUrl: (url) => new URL(new URL(url).pathname, endpoint).toString(),
    calls: (operation) => [...(recorded.get(operation) ?? [])],
    holdRequests(operation) {
      requestHolds.add(operation);
    },
    holdResponses(operation) {
      responseHolds.add(operation);
    },
    delay(operation, ms) {
      delays.set(operation, ms);
    },
    held: (operation) => heldCounts.get(operation) ?? 0,
    async stop() {
      for (const release of releases.splice(0)) {
        release();
      }
      await server.stop(true);
    },
  };
}
