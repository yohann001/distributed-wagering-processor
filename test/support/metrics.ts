const LABEL_PAIR = /(\w+)="((?:[^"\\]|\\.)*)"/g;

/** Texto de `GET /metrics` no formato Prometheus. */
export async function scrapeMetrics(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/metrics`);
  return response.text();
}

function parseLabels(block: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of block.matchAll(LABEL_PAIR)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) {
      labels[key] = value;
    }
  }
  return labels;
}

/**
 * Soma as amostras de `name` cujos labels contêm todos os pares pedidos (labels não pedidos, como o `instance_id`
 * padrão do registry, são ignorados). Devolve 0 quando nenhuma amostra bate. Para histogramas, passe o nome com
 * o sufixo da série (`_count`, `_sum`, `_bucket`).
 */
export function sampleValue(text: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) {
      continue;
    }
    const rest = line.slice(name.length);
    const sample = /^(?:\{(.*)\})? (\S+)$/.exec(rest);
    if (sample === null) {
      continue;
    }
    const sampleLabels = parseLabels(sample[1] ?? '');
    if (Object.entries(labels).every(([key, value]) => sampleLabels[key] === value)) {
      total += Number(sample[2]);
    }
  }
  return total;
}

/** A família existe no registry mesmo sem amostras (`# TYPE <name> ...`). */
export function hasMetricFamily(text: string, name: string): boolean {
  return text.split('\n').some((line) => line.startsWith(`# TYPE ${name} `));
}
