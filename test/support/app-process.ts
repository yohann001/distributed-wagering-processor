import type { Subprocess } from 'bun';

import type { LogLine } from './log-capture';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_STOP_TIMEOUT_MS = 15000;
const READY_POLL_INTERVAL_MS = 100;
const READY_REQUEST_TIMEOUT_MS = 1000;
const STDERR_TAIL_CHARS = 2000;

export interface AppProcess {
  readonly instanceId: string;
  /** `application_name` da conexão no Postgres (`PGAPPNAME`): identifica os backends deste processo em `pg_stat_activity`. */
  readonly applicationName: string;
  readonly baseUrl: string;
  /** Linhas de log JSON que o processo escreveu no stdout até agora. */
  lines(): LogLine[];
  /** Encerra o processo com o sinal dado e devolve o código de saída (`null` quando morreu por sinal). */
  stop(signal?: 'SIGTERM' | 'SIGKILL', timeoutMs?: number): Promise<number | null>;
}

export interface StartAppProcessOptions {
  instanceId: string;
  /** Variáveis por cima do ambiente do teste e do `.env`: o que vem daqui vence. */
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

function parseLogLine(text: string): LogLine | null {
  try {
    return JSON.parse(text) as LogLine;
  } catch {
    // Linha que não é JSON (saída de boot de dependência): não é log da aplicação.
    return null;
  }
}

/** Porta livre sondada com um servidor efêmero. Há uma pequena janela até o filho abrir a porta; aceitável em teste. */
function pickFreePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const { port } = probe;
  void probe.stop(true);
  if (port === undefined) {
    throw new Error('could not pick a free port');
  }
  return port;
}

/**
 * Lê o stream até o fim. Drenar é obrigatório: o pino escreve de forma síncrona no fd 1 e um pipe cheio travaria o filho.
 */
async function drain(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    onText(decoder.decode(chunk, { stream: true }));
  }
}

async function isReady(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS) });
    return response.status === 200;
  } catch {
    // Conexão recusada enquanto o processo ainda sobe: tenta de novo no próximo ciclo.
    return false;
  }
}

/**
 * Sobe um processo real da aplicação (`bun src/main.ts`, o mesmo entrypoint da imagem) com porta, pool, consumers e
 * `INSTANCE_ID` próprios, e espera `/health/ready`. Cada processo conecta ao Postgres com `PGAPPNAME` próprio, que o
 * `pg` lê sozinho: os testes distinguem os backends de cada instância sem mudar nada em `src/`.
 */
export async function startAppProcess(options: StartAppProcessOptions): Promise<AppProcess> {
  const { instanceId, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS } = options;
  const port = pickFreePort();
  const applicationName = `wagering-${instanceId}`;
  const baseUrl = `http://127.0.0.1:${port}`;

  const proc: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...options.env,
      PORT: String(port),
      INSTANCE_ID: instanceId,
      PGAPPNAME: applicationName,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const lines: LogLine[] = [];
  let pendingText = '';
  const stdoutDrained = drain(proc.stdout, (text) => {
    const parts = (pendingText + text).split('\n');
    pendingText = parts.pop() ?? '';
    for (const part of parts) {
      const line = parseLogLine(part);
      if (line !== null) {
        lines.push(line);
      }
    }
  });
  let stderrText = '';
  const stderrDrained = drain(proc.stderr, (text) => {
    stderrText += text;
  });

  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });

  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (!ready && !exited && Date.now() < deadline) {
    ready = await isReady(baseUrl);
    if (!ready) {
      await Bun.sleep(READY_POLL_INTERVAL_MS);
    }
  }
  if (!ready) {
    proc.kill('SIGKILL');
    await proc.exited;
    await Promise.all([stdoutDrained, stderrDrained]);
    throw new Error(
      `app process ${instanceId} did not become ready within ${readyTimeoutMs}ms (exit code ${String(proc.exitCode)}): ${stderrText.slice(-STDERR_TAIL_CHARS)}`,
    );
  }

  return {
    instanceId,
    applicationName,
    baseUrl,
    lines: () => [...lines],
    async stop(signal = 'SIGTERM', timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
      if (!exited) {
        proc.kill(signal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = Symbol('timed out');
        const deadlineReached = new Promise<symbol>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
        });
        const outcome = await Promise.race([proc.exited, deadlineReached]);
        clearTimeout(timer);
        if (outcome === timedOut) {
          proc.kill('SIGKILL');
          await proc.exited;
        }
      }
      await Promise.all([stdoutDrained, stderrDrained]);
      return proc.exitCode;
    },
  };
}
