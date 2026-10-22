import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Registry } from 'prom-client';

import { ConcurrencyMetrics } from '../../../../src/infrastructure/database/concurrency-metrics';
import {
  MikroOrmUnitOfWork,
  type UnitOfWorkOptions,
} from '../../../../src/infrastructure/database/mikro-orm-unit-of-work';
import { WalletRepository } from '../../../../src/modules/wallet/application/wallet-repository';
import {
  ConcurrencyConflictError,
  ConcurrencyConflictReason,
  UnitOfWork,
} from '../../../../src/shared/application/unit-of-work';
import { ExponentialBackoff } from '../../../../src/shared/domain/exponential-backoff';
import { createTestApp } from '../../../support/create-test-app';
import { openWalletWithBalance } from '../../../support/fixtures';
import { present } from '../../../support/orm-context';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('MikroOrmUnitOfWork (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let wallets: WalletRepository;
  let metrics: ConcurrencyMetrics;
  let registry: Registry;
  let uow: UnitOfWork;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    wallets = app.get(WalletRepository);
    metrics = app.get(ConcurrencyMetrics);
    registry = app.get(Registry);
    uow = app.get(UnitOfWork);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function conflictCounts() {
    const metric = present(registry.getSingleMetric('lock_conflicts_total'), 'lock_conflicts_total');
    return (await metric.get()).values;
  }

  async function conflictCount(reason: string, outcome: string): Promise<number> {
    return (await conflictCounts())
      .filter((sample) => sample.labels.reason === reason && sample.labels.outcome === outcome)
      .reduce((sum, sample) => sum + sample.value, 0);
  }

  async function totalConflicts(): Promise<number> {
    return (await conflictCounts()).reduce((sum, sample) => sum + sample.value, 0);
  }

  function fastUow(overrides: Partial<UnitOfWorkOptions> = {}): MikroOrmUnitOfWork {
    return new MikroOrmUnitOfWork(orm.em, metrics, {
      lockTimeoutMs: 200,
      maxAttempts: 3,
      backoff: new ExponentialBackoff({ baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 }, () => 0),
      ...overrides,
    });
  }

  it('retries a deadlock victim and lets both transactions finish', async () => {
    const x = (await openWalletWithBalance(app, { amount: '100.00' })).wallet.id;
    const y = (await openWalletWithBalance(app, { amount: '100.00' })).wallet.id;
    const retriedBefore = await conflictCount('deadlock', 'retried');
    const bothHoldTheirFirstLock = deferred();
    let holders = 0;
    let executions = 0;

    // Só o teste trava duas wallets na mesma transação; o domínio nunca faz isso (§8).
    const crossLock = (first: string, second: string): Promise<void> => {
      let attempt = 0;
      return uow.run(async () => {
        attempt += 1;
        executions += 1;
        await wallets.lockById(first);
        if (attempt === 1) {
          holders += 1;
          if (holders === 2) {
            bothHoldTheirFirstLock.resolve();
          }
          await bothHoldTheirFirstLock.promise;
        }
        await wallets.lockById(second);
      });
    };

    await Promise.all([crossLock(x, y), crossLock(y, x)]);

    expect(executions).toBe(3);
    expect((await conflictCount('deadlock', 'retried')) - retriedBefore).toBe(1);
  });

  it('gives up with LOCK_TIMEOUT after maxAttempts executions while the row stays locked', async () => {
    const id = (await openWalletWithBalance(app, { amount: '100.00' })).wallet.id;
    const retriedBefore = await conflictCount('lock_timeout', 'retried');
    const exhaustedBefore = await conflictCount('lock_timeout', 'exhausted');
    const locked = deferred();
    const release = deferred();
    const owner = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [id]);
      locked.resolve();
      await release.promise;
    });
    await Promise.race([locked.promise, owner]);

    let calls = 0;
    try {
      const error = await fastUow()
        .run(async () => {
          calls += 1;
          await wallets.lockById(id);
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConcurrencyConflictError);
      expect((error as ConcurrencyConflictError).reason).toBe(ConcurrencyConflictReason.LockTimeout);
    } finally {
      release.resolve();
      await owner;
    }

    expect(calls).toBe(3);
    expect((await conflictCount('lock_timeout', 'retried')) - retriedBefore).toBe(2);
    expect((await conflictCount('lock_timeout', 'exhausted')) - exhaustedBefore).toBe(1);
  });

  it('retries a VERSION_CONFLICT raised by the work', async () => {
    const retriedBefore = await conflictCount('version_conflict', 'retried');
    let calls = 0;

    const result = await fastUow().run(async () => {
      calls += 1;
      if (calls === 1) {
        throw new ConcurrencyConflictError(ConcurrencyConflictReason.VersionConflict, 'test');
      }
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect((await conflictCount('version_conflict', 'retried')) - retriedBefore).toBe(1);
  });

  it('does not retry an error that is not a concurrency conflict', async () => {
    const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });
    const totalBefore = await totalConflicts();
    let calls = 0;

    const error = await fastUow()
      .run(async () => {
        calls += 1;
        await wallets.insert(wallet);
      })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
    expect(await totalConflicts()).toBe(totalBefore);
  });

  it('refuses a nested run', async () => {
    await expect(uow.run(() => uow.run(async () => 1))).rejects.toThrow('must not be nested');
  });

  it('keeps lock_timeout local to the transaction instead of leaking it to the pool', async () => {
    const lockTimeoutInside = await fastUow().run(async () => {
      const rows = await orm.em.execute<{ lock_timeout: string }[]>('show lock_timeout');
      return rows[0]?.lock_timeout;
    });

    // Várias consultas em paralelo para passar por todas as conexões do pool.
    const outside = await Promise.all(
      Array.from({ length: 10 }, () => orm.em.fork().execute<{ lock_timeout: string }[]>('show lock_timeout')),
    );

    expect(lockTimeoutInside).toBe('200ms');
    expect(outside.map((rows) => rows[0]?.lock_timeout)).toEqual(Array(10).fill('0'));
  });
});
