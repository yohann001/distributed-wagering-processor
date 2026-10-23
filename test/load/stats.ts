const LABEL_PAIR = /(\w+)="((?:[^"\\]|\\.)*)"/g;

/**
 * Percentil por nearest-rank, sem interpolação: `sorted` já vem em ordem crescente. Vazio devolve `null`.
 */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.ceil((p * sorted.length) / 100);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

/** Resume uma amostra de latências (não altera `values`). */
export function summarize(values: number[]): LatencySummary {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? null,
    mean: sorted.length === 0 ? null : total / sorted.length,
  };
}

export interface HistogramBucket {
  /** Limite superior do bucket; `Infinity` para `+Inf`. Os counts são cumulativos, como no formato Prometheus. */
  le: number;
  count: number;
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
 * Lê as linhas `<name>_bucket{...}` cujos labels contêm todos os pares pedidos e soma o count por `le` (entre
 * desfechos e instâncias presentes no texto). Labels não pedidos, como `outcome` e `instance_id`, são ignorados.
 */
export function histogramBuckets(text: string, name: string, labels: Record<string, string>): HistogramBucket[] {
  const prefix = `${name}_bucket`;
  const byLe = new Map<number, number>();
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(prefix)) {
      continue;
    }
    const sample = /^\{(.*)\} (\S+)$/.exec(line.slice(prefix.length));
    if (sample === null) {
      continue;
    }
    const sampleLabels = parseLabels(sample[1] ?? '');
    const { le } = sampleLabels;
    if (le === undefined || !Object.entries(labels).every(([key, value]) => sampleLabels[key] === value)) {
      continue;
    }
    const bound = le === '+Inf' ? Infinity : Number(le);
    byLe.set(bound, (byLe.get(bound) ?? 0) + Number(sample[2]));
  }
  return [...byLe.entries()].map(([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le);
}

/** Diferença por `le` entre duas leituras do mesmo histograma; bucket ausente em `before` conta como 0. */
export function subtractBuckets(after: HistogramBucket[], before: HistogramBucket[]): HistogramBucket[] {
  const beforeByLe = new Map(before.map((bucket) => [bucket.le, bucket.count]));
  return after.map(({ le, count }) => ({ le, count: count - (beforeByLe.get(le) ?? 0) }));
}

/** Soma dois conjuntos de buckets cumulativos, por `le` (histogramas de instâncias diferentes). */
export function addBuckets(a: HistogramBucket[], b: HistogramBucket[]): HistogramBucket[] {
  const byLe = new Map<number, number>();
  for (const { le, count } of [...a, ...b]) {
    byLe.set(le, (byLe.get(le) ?? 0) + count);
  }
  return [...byLe.entries()].map(([le, count]) => ({ le, count })).sort((x, y) => x.le - y.le);
}

/**
 * Estimativa de percentil de um histograma, no estilo do `histogram_quantile` do Prometheus: interpolação linear
 * dentro do bucket que contém o rank. A resolução é a dos buckets. Um rank que cai em `+Inf` devolve o maior limite
 * finito. `null` sem amostras.
 */
export function histogramPercentile(buckets: HistogramBucket[], p: number): number | null {
  const total = buckets.at(-1)?.count ?? 0;
  if (total <= 0) {
    return null;
  }
  const rank = (p / 100) * total;
  let previousLe = 0;
  let previousCount = 0;
  for (const bucket of buckets) {
    if (bucket.count >= rank) {
      if (bucket.le === Infinity) {
        return previousLe > 0 ? previousLe : null;
      }
      const inBucket = bucket.count - previousCount;
      if (inBucket <= 0) {
        return bucket.le;
      }
      return previousLe + (bucket.le - previousLe) * ((rank - previousCount) / inBucket);
    }
    previousLe = bucket.le === Infinity ? previousLe : bucket.le;
    previousCount = bucket.count;
  }
  return null;
}

/** Delta de um contador entre duas leituras; `after < before` é reset (a réplica reiniciou) e vale `after`. */
export function counterDelta(before: number, after: number): { delta: number; reset: boolean } {
  return after < before ? { delta: after, reset: true } : { delta: after - before, reset: false };
}
