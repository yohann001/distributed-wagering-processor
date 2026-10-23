import { describe, expect, it } from 'bun:test';

import {
  addBuckets,
  counterDelta,
  histogramBuckets,
  histogramPercentile,
  percentile,
  subtractBuckets,
  summarize,
} from '../../load/stats';

/** Dois processos (`instance_id`), dois desfechos por canal, com `+Inf`: a forma que o `/metrics` das réplicas tem. */
const EXPOSITION = [
  '# HELP wager_transaction_processing_seconds Latência',
  '# TYPE wager_transaction_processing_seconds histogram',
  'wager_transaction_processing_seconds_bucket{le="0.1",channel="http",outcome="processed",instance_id="a"} 4',
  'wager_transaction_processing_seconds_bucket{le="0.5",channel="http",outcome="processed",instance_id="a"} 6',
  'wager_transaction_processing_seconds_bucket{le="+Inf",channel="http",outcome="processed",instance_id="a"} 6',
  'wager_transaction_processing_seconds_bucket{le="0.1",channel="http",outcome="rejected",instance_id="a"} 1',
  'wager_transaction_processing_seconds_bucket{le="0.5",channel="http",outcome="rejected",instance_id="a"} 2',
  'wager_transaction_processing_seconds_bucket{le="+Inf",channel="http",outcome="rejected",instance_id="a"} 3',
  'wager_transaction_processing_seconds_bucket{le="0.1",channel="http",outcome="processed",instance_id="b"} 10',
  'wager_transaction_processing_seconds_bucket{le="0.5",channel="http",outcome="processed",instance_id="b"} 10',
  'wager_transaction_processing_seconds_bucket{le="+Inf",channel="http",outcome="processed",instance_id="b"} 10',
  'wager_transaction_processing_seconds_bucket{le="0.1",channel="sqs",outcome="processed",instance_id="a"} 7',
  'wager_transaction_processing_seconds_bucket{le="0.5",channel="sqs",outcome="processed",instance_id="a"} 7',
  'wager_transaction_processing_seconds_bucket{le="+Inf",channel="sqs",outcome="processed",instance_id="a"} 7',
  'wager_transaction_processing_seconds_sum{channel="http",outcome="processed",instance_id="a"} 1.5',
  'wager_transaction_processing_seconds_count{channel="http",outcome="processed",instance_id="a"} 6',
].join('\n');

describe('percentile (nearest-rank)', () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);

  it.each([
    [50, 50],
    [95, 95],
    [99, 99],
    [100, 100],
  ])('p%d of 1..100 is %d', (p, expected) => {
    expect(percentile(hundred, p)).toBe(expected);
  });

  it('returns the only value of a single-element sample for any percentile', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });

  it('returns null for an empty sample', () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe('summarize', () => {
  it('reports count, percentiles, max and mean without reordering the input', () => {
    const values = [30, 10, 20, 40];
    const summary = summarize(values);

    expect(summary).toEqual({ count: 4, p50: 20, p95: 40, p99: 40, max: 40, mean: 25 });
    expect(values).toEqual([30, 10, 20, 40]);
  });

  it('has null statistics and zero count for an empty sample', () => {
    expect(summarize([])).toEqual({ count: 0, p50: null, p95: null, p99: null, max: null, mean: null });
  });
});

describe('histogramBuckets', () => {
  it('sums the count per le across outcomes and instances and keeps +Inf last', () => {
    expect(histogramBuckets(EXPOSITION, 'wager_transaction_processing_seconds', { channel: 'http' })).toEqual([
      { le: 0.1, count: 15 },
      { le: 0.5, count: 18 },
      { le: Infinity, count: 19 },
    ]);
  });

  it('filters by the requested labels', () => {
    expect(histogramBuckets(EXPOSITION, 'wager_transaction_processing_seconds', { channel: 'sqs' })).toEqual([
      { le: 0.1, count: 7 },
      { le: 0.5, count: 7 },
      { le: Infinity, count: 7 },
    ]);
    expect(
      histogramBuckets(EXPOSITION, 'wager_transaction_processing_seconds', { channel: 'http', outcome: 'rejected' }),
    ).toEqual([
      { le: 0.1, count: 1 },
      { le: 0.5, count: 2 },
      { le: Infinity, count: 3 },
    ]);
  });

  it('ignores the _sum and _count series and returns nothing for an unknown metric', () => {
    expect(histogramBuckets(EXPOSITION, 'other_metric', {})).toEqual([]);
  });
});

describe('subtractBuckets and addBuckets', () => {
  it('subtracts per le and treats a missing bucket in before as 0', () => {
    const after = [
      { le: 0.1, count: 10 },
      { le: 0.5, count: 12 },
      { le: Infinity, count: 12 },
    ];
    const before = [{ le: 0.1, count: 4 }];

    expect(subtractBuckets(after, before)).toEqual([
      { le: 0.1, count: 6 },
      { le: 0.5, count: 12 },
      { le: Infinity, count: 12 },
    ]);
  });

  it('adds cumulative buckets of two instances per le', () => {
    expect(
      addBuckets(
        [
          { le: 0.1, count: 1 },
          { le: Infinity, count: 2 },
        ],
        [
          { le: 0.1, count: 3 },
          { le: Infinity, count: 3 },
        ],
      ),
    ).toEqual([
      { le: 0.1, count: 4 },
      { le: Infinity, count: 5 },
    ]);
  });
});

describe('histogramPercentile', () => {
  const buckets = [
    { le: 0.1, count: 50 },
    { le: 0.5, count: 100 },
    { le: Infinity, count: 100 },
  ];

  it('interpolates linearly inside the bucket that holds the rank', () => {
    expect(histogramPercentile(buckets, 50)).toBeCloseTo(0.1, 10);
    expect(histogramPercentile(buckets, 75)).toBeCloseTo(0.3, 10);
  });

  it('returns the highest finite bound when the rank falls in +Inf', () => {
    expect(
      histogramPercentile(
        [
          { le: 0.1, count: 10 },
          { le: 0.5, count: 20 },
          { le: Infinity, count: 100 },
        ],
        99,
      ),
    ).toBe(0.5);
  });

  it('returns null when there are no samples', () => {
    expect(histogramPercentile([], 50)).toBeNull();
    expect(
      histogramPercentile(
        [
          { le: 0.1, count: 0 },
          { le: Infinity, count: 0 },
        ],
        50,
      ),
    ).toBeNull();
  });
});

describe('counterDelta', () => {
  it('is the plain difference when the counter grew', () => {
    expect(counterDelta(10, 25)).toEqual({ delta: 15, reset: false });
    expect(counterDelta(5, 5)).toEqual({ delta: 0, reset: false });
  });

  it('detects a reset (the replica restarted) and takes the final value as the delta', () => {
    expect(counterDelta(100, 7)).toEqual({ delta: 7, reset: true });
  });
});
