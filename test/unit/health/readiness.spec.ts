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

  it('runs the checks in parallel', async () => {
    const { probe } = probeFor([resolvingAfter('postgres', 40), resolvingAfter('sqs', 40)], 1000);
    const startedAt = performance.now();

    const report = await probe.run();

    expect(report.status).toBe('ok');
    expect(performance.now() - startedAt).toBeLessThan(75);
  });
});
