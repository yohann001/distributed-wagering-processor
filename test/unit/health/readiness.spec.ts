import { describe, expect, it } from 'bun:test';

import {
  ReadinessProbe,
  type DependencyCheck,
  type DependencyName,
  type ReadinessFailure,
} from '../../../src/health/readiness';

const TIMEOUT_MS = 50;

function resolvingAfter(name: DependencyName, delayMs: number): DependencyCheck {
  return { name, check: () => new Promise<void>((resolve) => setTimeout(resolve, delayMs)) };
}

function rejecting(name: DependencyName, error: Error): DependencyCheck {
  return { name, check: () => Promise.reject(error) };
}

function neverSettling(name: DependencyName): DependencyCheck {
  return { name, check: () => new Promise<void>(() => undefined) };
}

function probeFor(checks: readonly DependencyCheck[], timeoutMs = TIMEOUT_MS) {
  const failures: ReadinessFailure[] = [];
  const probe = new ReadinessProbe(checks, timeoutMs, (failure) => failures.push(failure));
  return { probe, failures };
}

describe('ReadinessProbe', () => {
  it('reports ok when every check resolves', async () => {
    const { probe, failures } = probeFor([resolvingAfter('postgres', 0), resolvingAfter('sqs', 0)]);

    const report = await probe.run();

    expect(report).toEqual({
      status: 'ok',
      checks: { postgres: { status: 'up' }, sqs: { status: 'up' } },
    });
    expect(failures).toEqual([]);
  });

  it('reports unavailable with reason error when a check rejects, and reports it once', async () => {
    const { probe, failures } = probeFor([resolvingAfter('postgres', 0), rejecting('sqs', new TypeError('boom'))]);

    const report = await probe.run();

    expect(report).toEqual({
      status: 'unavailable',
      checks: { postgres: { status: 'up' }, sqs: { status: 'down', reason: 'error' } },
    });
    expect(failures).toEqual([{ dependency: 'sqs', reason: 'error', errorName: 'TypeError' }]);
  });

  it('never puts the error message in the report', async () => {
    const { probe } = probeFor([rejecting('postgres', new Error('password=secret host=db'))]);

    const report = await probe.run();

    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('names a non-Error rejection UnknownError', async () => {
    const { probe, failures } = probeFor([{ name: 'sqs', check: () => Promise.reject('plain string') }]);

    await probe.run();

    expect(failures).toEqual([{ dependency: 'sqs', reason: 'error', errorName: 'UnknownError' }]);
  });

  it('reports reason timeout for a check that never settles and ignores the signal', async () => {
    const { probe, failures } = probeFor([resolvingAfter('postgres', 0), neverSettling('sqs')]);
    const startedAt = performance.now();

    const report = await probe.run();

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(report).toEqual({
      status: 'unavailable',
      checks: { postgres: { status: 'up' }, sqs: { status: 'down', reason: 'timeout' } },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ dependency: 'sqs', reason: 'timeout' });
  });

  it('reports reason timeout when a check rejects because the signal aborted', async () => {
    const abortAware: DependencyCheck = {
      name: 'sqs',
      check: (signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const { probe } = probeFor([abortAware]);

    const report = await probe.run();

    expect(report.checks.sqs).toEqual({ status: 'down', reason: 'timeout' });
  });

  it('starts every check before any of them settles', async () => {
    const started: DependencyName[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = (name: DependencyName): DependencyCheck => ({
      name,
      check: async () => {
        started.push(name);
        await gate;
      },
    });
    const { probe } = probeFor([gated('postgres'), gated('sqs')], 1000);

    const running = probe.run();
    await Promise.resolve();

    // Em série, a segunda checagem só começaria depois que a primeira terminasse.
    expect(started).toEqual(['postgres', 'sqs']);
    release();
    expect((await running).status).toBe('ok');
  });

  it('shares one in-flight round of checks between concurrent callers', async () => {
    let calls = 0;
    const counted: DependencyCheck = {
      name: 'postgres',
      check: async () => {
        calls += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      },
    };
    const { probe } = probeFor([counted], 1000);

    const reports = await Promise.all([probe.run(), probe.run(), probe.run()]);

    expect(calls).toBe(1);
    expect(reports.every((report) => report.status === 'ok')).toBe(true);
  });

  it('reuses the last report within cacheMs and runs the checks again after it', async () => {
    let calls = 0;
    let now = 1_000;
    const counted: DependencyCheck = {
      name: 'sqs',
      check: async () => {
        calls += 1;
      },
    };
    const probe = new ReadinessProbe([counted], TIMEOUT_MS, () => undefined, { cacheMs: 1000, now: () => now });

    await probe.run();
    now += 999;
    await probe.run();
    expect(calls).toBe(1);

    now += 1;
    await probe.run();
    expect(calls).toBe(2);
  });

  it('runs the checks on every call when cacheMs is zero', async () => {
    let calls = 0;
    const counted: DependencyCheck = {
      name: 'sqs',
      check: async () => {
        calls += 1;
      },
    };
    const { probe } = probeFor([counted]);

    await probe.run();
    await probe.run();

    expect(calls).toBe(2);
  });
});
