import type { DestinationStream } from 'pino';

export type LogLine = Record<string, unknown>;

export interface LogCapture {
  stream: DestinationStream;
  /** Texto bruto de tudo que foi escrito, para provar que um valor nunca apareceu. */
  raw(): string;
  lines(): LogLine[];
  /** A linha "request completed" sai no `finish` da resposta, que pode chegar depois do `fetch`. */
  waitFor(predicate: (line: LogLine) => boolean, timeoutMs?: number): Promise<LogLine>;
}

/** Destino de log em memória para os testes lerem o que o pino escreveu. */
export function createLogCapture(): LogCapture {
  const chunks: string[] = [];

  const raw = (): string => chunks.join('');
  const lines = (): LogLine[] =>
    raw()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LogLine);

  return {
    stream: { write: (chunk: string) => void chunks.push(chunk) },
    raw,
    lines,
    async waitFor(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = lines().find(predicate);
        if (found) return found;
        await Bun.sleep(10);
      }
      throw new Error(`Log line not found within ${timeoutMs}ms (${lines().length} lines captured)`);
    },
  };
}
