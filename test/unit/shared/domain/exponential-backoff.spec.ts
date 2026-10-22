import { describe, expect, it } from 'bun:test';

import { DomainError } from '../../../../src/shared/domain/domain-error';
import {
  ExponentialBackoff,
  InvalidBackoffError,
  type ExponentialBackoffOptions,
  type RandomSource,
} from '../../../../src/shared/domain/exponential-backoff';
import { FailureAction, FailureCode } from '../../../../src/shared/domain/failure-code';

const OPTIONS: ExponentialBackoffOptions = {
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitterRatio: 0.5,
};

const NEVER_JITTER: RandomSource = () => 0;
const MAX_JITTER: RandomSource = () => 0.999999;

const make = (
  random: RandomSource = NEVER_JITTER,
  overrides: Partial<ExponentialBackoffOptions> = {},
): ExponentialBackoff => new ExponentialBackoff({ ...OPTIONS, ...overrides }, random);

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

const expectInvalid = (error: unknown): void => {
  expect(error).toBeInstanceOf(InvalidBackoffError);
  expect<string>((error as InvalidBackoffError).code).toBe('INVARIANT_VIOLATION');
};

describe('ExponentialBackoff.delayMs: growth and cap', () => {
  it('doubles on every attempt until the cap, then stays at the cap', () => {
    const backoff = make();
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => backoff.delayMs(attempt));

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it('never exceeds the cap for huge attempts and never returns Infinity or NaN', () => {
    const backoff = make();

    for (const attempt of [100, 1_024, 10_000, Number.MAX_SAFE_INTEGER]) {
      const delay = backoff.delayMs(attempt);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBe(60000);
    }
  });

  it('never exceeds the cap with maximum jitter either', () => {
    const backoff = make(MAX_JITTER);

    for (let attempt = 1; attempt <= 50; attempt += 1) {
      expect(backoff.delayMs(attempt)).toBeLessThanOrEqual(60000);
    }
  });

  it('is deterministic without jitter', () => {
    const backoff = make(MAX_JITTER, { jitterRatio: 0 });

    expect([1, 2, 3, 4].map((attempt) => backoff.delayMs(attempt))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it('applies the jitter proportionally to the random value', () => {
    expect(make(() => 0.5).delayMs(3)).toBe(3000);
  });
});

describe('ExponentialBackoff.delayMs: bounded jitter', () => {
  it('keeps the delay in [capped * (1 - jitterRatio), capped] and the floor grows until the cap', () => {
    const backoff = make(MAX_JITTER);
    const capped = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];

    capped.forEach((ceiling, index) => {
      const delay = backoff.delayMs(index + 1);
      expect(delay).toBeGreaterThanOrEqual(ceiling * 0.5);
      expect(delay).toBeLessThanOrEqual(ceiling);
    });
    expect(backoff.delayMs(1)).toBeGreaterThanOrEqual(500);
    expect(backoff.delayMs(2)).toBeGreaterThanOrEqual(1000);
    expect(backoff.delayMs(3)).toBeGreaterThanOrEqual(2000);
  });

  it('never rounds below the floor when the floor is fractional', () => {
    // floor = 1000 * (1 - 0.3336) = 666.4; Math.round daria 666.
    expect(make(MAX_JITTER, { jitterRatio: 0.3336 }).delayMs(1)).toBeGreaterThanOrEqual(666.4);
  });

  it('reaches the full ceiling when the random value is 0', () => {
    expect(make(() => 0).delayMs(4)).toBe(8000);
  });

  it('can remove the whole delay only when jitterRatio is 1', () => {
    expect(make(() => 0.5, { jitterRatio: 1 }).delayMs(2)).toBe(1000);
  });
});

describe('ExponentialBackoff: invalid input', () => {
  it.each<[string, number]>([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects an attempt that is %s', (_label, attempt) => {
    expectInvalid(caught(() => make().delayMs(attempt)));
  });

  it.each<[string, Partial<ExponentialBackoffOptions>]>([
    ['zero baseDelayMs', { baseDelayMs: 0 }],
    ['negative baseDelayMs', { baseDelayMs: -1 }],
    ['fractional baseDelayMs', { baseDelayMs: 1.5 }],
    ['NaN baseDelayMs', { baseDelayMs: Number.NaN }],
    ['maxDelayMs lower than baseDelayMs', { maxDelayMs: 999 }],
    ['fractional maxDelayMs', { maxDelayMs: 60000.5 }],
    ['infinite maxDelayMs', { maxDelayMs: Number.POSITIVE_INFINITY }],
    ['negative jitterRatio', { jitterRatio: -0.1 }],
    ['jitterRatio above 1', { jitterRatio: 1.1 }],
    ['NaN jitterRatio', { jitterRatio: Number.NaN }],
  ])('rejects %s', (_label, overrides) => {
    expectInvalid(caught(() => make(NEVER_JITTER, overrides)));
  });

  it.each<[string, number]>([
    ['1', 1],
    ['a negative number', -0.1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects a random source that returns %s', (_label, value) => {
    expectInvalid(caught(() => make(() => value).delayMs(1)));
  });

  it('accepts the boundary options', () => {
    expect(make(NEVER_JITTER, { baseDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 }).delayMs(9)).toBe(5);
    expect(make(NEVER_JITTER, { jitterRatio: 1 }).delayMs(1)).toBe(1000);
  });
});

describe('ExponentialBackoff: options', () => {
  it('exposes a frozen copy of the options', () => {
    const input = { ...OPTIONS };
    const backoff = new ExponentialBackoff(input, NEVER_JITTER);
    input.maxDelayMs = 1;

    expect(backoff.options).toEqual(OPTIONS);
    expect(Object.isFrozen(backoff.options)).toBe(true);
    expect(backoff.delayMs(10)).toBe(60000);
  });
});

describe('InvalidBackoffError', () => {
  it('is an invariant violation that must not be retried', () => {
    const error = new InvalidBackoffError('x');

    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('InvalidBackoffError');
    expect(error.message).toBe('Invalid backoff: x');
    expect(error.code).toBe(FailureCode.InvariantViolation);
    expect(error.action).toBe(FailureAction.GiveUp);
  });
});
