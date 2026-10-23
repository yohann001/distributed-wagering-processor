import { sampleValue, scrapeMetrics } from '../support/metrics';
import { addBuckets, counterDelta, histogramBuckets, subtractBuckets, type HistogramBucket } from './stats';

/** Texto de `/metrics` mais recente de cada réplica, por `instance_id`. */
export type ReplicaSnapshot = Map<string, string>;

const INSTANCE_ID_LABEL = /instance_id="((?:[^"\\]|\\.)*)"/;
const SCRAPES_PER_REPLICA = 15;

function instanceIdOf(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith('#')) {
      const match = INSTANCE_ID_LABEL.exec(line);
      if (match?.[1] !== undefined) {
        return match[1];
      }
    }
  }
  return null;
}

/**
 * O nginx faz round-robin, então várias leituras de `/metrics` pelo mesmo endereço passam por todas as réplicas.
 * Para quando viu `expected` instâncias distintas; falha se não vir.
 */
export async function scrapeReplicas(baseUrl: string, expected: number): Promise<ReplicaSnapshot> {
  const snapshot: ReplicaSnapshot = new Map();
  for (let attempt = 0; attempt < expected * SCRAPES_PER_REPLICA && snapshot.size < expected; attempt += 1) {
    const text = await scrapeMetrics(baseUrl);
    const instanceId = instanceIdOf(text);
    if (instanceId !== null) {
      snapshot.set(instanceId, text);
    }
  }
  if (snapshot.size < expected) {
    throw new Error(`expected ${expected} replicas behind nginx, saw [${[...snapshot.keys()].join(', ')}]`);
  }
  return snapshot;
}

export interface CounterDelta {
  total: number;
  perInstance: Record<string, number>;
  /** Instâncias em que o contador diminuiu entre as leituras (reinício): o delta vale o valor final. */
  resets: string[];
}

/** Delta de um contador entre duas leituras, por réplica e somado. Réplica só presente em `after` parte de 0. */
export function sumDelta(
  before: ReplicaSnapshot,
  after: ReplicaSnapshot,
  name: string,
  labels: Record<string, string> = {},
): CounterDelta {
  const result: CounterDelta = { total: 0, perInstance: {}, resets: [] };
  for (const [instanceId, afterText] of after) {
    const beforeText = before.get(instanceId);
    const beforeValue = beforeText === undefined ? 0 : sampleValue(beforeText, name, labels);
    const { delta, reset } = counterDelta(beforeValue, sampleValue(afterText, name, labels));
    result.perInstance[instanceId] = delta;
    result.total += delta;
    if (reset) {
      result.resets.push(instanceId);
    }
  }
  return result;
}

/** Buckets do histograma na janela entre as duas leituras, somados entre as réplicas. */
export function histogramDelta(
  before: ReplicaSnapshot,
  after: ReplicaSnapshot,
  name: string,
  labels: Record<string, string>,
): HistogramBucket[] {
  let merged: HistogramBucket[] = [];
  for (const [instanceId, afterText] of after) {
    const beforeText = before.get(instanceId);
    const beforeBuckets = beforeText === undefined ? [] : histogramBuckets(beforeText, name, labels);
    merged = addBuckets(merged, subtractBuckets(histogramBuckets(afterText, name, labels), beforeBuckets));
  }
  return merged;
}
