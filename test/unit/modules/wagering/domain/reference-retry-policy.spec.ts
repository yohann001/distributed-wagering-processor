import { describe, expect, it } from 'bun:test';

import { ExponentialBackoff, InvalidBackoffError } from '../../../../../src/shared/domain/exponential-backoff';
import {
  DEFAULT_REFERENCE_RETRY_BACKOFF,
  DEFAULT_REFERENCE_RETRY_MAX_ATTEMPTS,
  ReferenceRetryPolicy,
} from '../../../../../src/modules/wagering/domain/reference-retry-policy';

const NOW = new Date('2026-10-22T10:00:00.000Z');

/** Sem jitter (`random: () => 0`): o atraso é `base · 2^(n-1)` limitado ao teto. */
function policy(maxAttempts: number): ReferenceRetryPolicy {
  return new ReferenceRetryPolicy(
    maxAttempts,
    new ExponentialBackoff({ baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0.2 }, () => 0),
  );
}

describe('ReferenceRetryPolicy.afterMissedAttempt', () => {
  it('schedules the next attempt with exponential backoff below the limit', () => {
    const retry = policy(20);

    expect(retry.afterMissedAttempt(1, NOW)).toEqual({ kind: 'retry', nextAttemptAt: new Date(NOW.getTime() + 1_000) });
    expect(retry.afterMissedAttempt(2, NOW)).toEqual({ kind: 'retry', nextAttemptAt: new Date(NOW.getTime() + 2_000) });
    expect(retry.afterMissedAttempt(6, NOW)).toEqual({ kind: 'retry', nextAttemptAt: new Date(NOW.getTime() + 32_000) });
  });

  it('caps the delay at the backoff ceiling', () => {
    expect(policy(20).afterMissedAttempt(19, NOW)).toEqual({
      kind: 'retry',
      nextAttemptAt: new Date(NOW.getTime() + 60_000),
    });
  });

  it('is exhausted at the limit and above it', () => {
    const retry = policy(3);

    expect(retry.afterMissedAttempt(2, NOW).kind).toBe('retry');
    expect(retry.afterMissedAttempt(3, NOW)).toEqual({ kind: 'exhausted' });
    expect(retry.afterMissedAttempt(4, NOW)).toEqual({ kind: 'exhausted' });
  });

  it('exhausts on the first attempt when the limit is 1', () => {
    expect(policy(1).afterMissedAttempt(1, NOW)).toEqual({ kind: 'exhausted' });
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses an attempt of %p', (attempt) => {
    expect(() => policy(3).afterMissedAttempt(attempt, NOW)).toThrow(InvalidBackoffError);
  });
});

describe('ReferenceRetryPolicy construction', () => {
  it.each([0, -2, 1.5, Number.NaN])('refuses maxAttempts %p', (maxAttempts) => {
    expect(() => policy(maxAttempts)).toThrow(InvalidBackoffError);
  });

  it('exposes the limit', () => {
    expect(policy(7).maxAttempts).toBe(7);
  });
});

describe('reference retry defaults', () => {
  it('match the documented numbers', () => {
    expect(DEFAULT_REFERENCE_RETRY_MAX_ATTEMPTS).toBe(20);
    expect(DEFAULT_REFERENCE_RETRY_BACKOFF).toEqual({ baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0.2 });
  });

  it('keep the whole window between 11 and 14 minutes, as documented', () => {
    const withoutJitter = new ExponentialBackoff({ ...DEFAULT_REFERENCE_RETRY_BACKOFF, jitterRatio: 0 }, () => 0);
    const withMaxJitter = new ExponentialBackoff(DEFAULT_REFERENCE_RETRY_BACKOFF, () => 0.999999);
    const windowMs = (backoff: ExponentialBackoff): number =>
      Array.from({ length: DEFAULT_REFERENCE_RETRY_MAX_ATTEMPTS - 1 }, (_, index) => backoff.delayMs(index + 1)).reduce(
        (sum, delay) => sum + delay,
        0,
      );

    expect(windowMs(withoutJitter)).toBe(843_000);
    expect(windowMs(withMaxJitter)).toBeGreaterThan(11 * 60_000);
    expect(windowMs(withMaxJitter)).toBeLessThan(14 * 60_000);
  });
});
