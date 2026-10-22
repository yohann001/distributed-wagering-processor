import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { loadEnv } from '../../src/config/env';
import { ReadinessProbe } from '../../src/health/readiness';
import { buildSqsClient } from '../../src/modules/messaging/infrastructure/sqs/sqs-client';
import { ProviderIdentityPort } from '../../src/shared/application/provider-identity';
import { createTestApp } from '../support/create-test-app';

class DenyAllIdentityPort extends ProviderIdentityPort {
  async authenticate(): Promise<null> {
    return null;
  }
}

describe('sanity: app boot', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('connects to PostgreSQL', async () => {
    const orm = app.get(MikroORM);
    expect(await orm.isConnected()).toBe(true);

    const [row] = await orm.em.getConnection().execute<{ ok: number }[]>('select 1 as ok');
    expect(row?.ok).toBe(1);
  });

  it('GET /health/live responds 200', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready responds 200 with Postgres and SQS up', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      checks: { postgres: { status: 'up' }, sqs: { status: 'up' } },
    });
  });
});

describe('readiness with a deny-all identity port', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp({ providerIdentity: new DenyAllIdentityPort() });
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health/ready stays public', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ status: 'ok' });
  });
});

describe('readiness with SQS unreachable', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const sqsClient = buildSqsClient({ ...loadEnv(), AWS_ENDPOINT_URL: 'http://127.0.0.1:1' });
    app = await createTestApp({ sqsClient });
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health/ready responds 503 with sqs down and no error details', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: { status: 'up' }, sqs: { status: 'down', reason: 'error' } },
    });
  });

  it('GET /health/live stays 200 and never runs the readiness probe', async () => {
    const run = spyOn(app.get(ReadinessProbe), 'run');
    try {
      const res = await fetch(`${baseUrl}/health/live`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });
});

describe('readiness with SQS hanging', () => {
  let app: INestApplication;
  let baseUrl: string;
  let hangingServer: Bun.TCPSocketListener;

  beforeAll(async () => {
    hangingServer = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const sqsClient = buildSqsClient({
      ...loadEnv(),
      AWS_ENDPOINT_URL: `http://127.0.0.1:${hangingServer.port}`,
    });
    app = await createTestApp({ sqsClient });
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    hangingServer?.stop(true);
  });

  it('GET /health/ready answers 503 with reason timeout within the timeout budget', async () => {
    const timeoutMs = loadEnv().HEALTH_CHECK_TIMEOUT_MS;
    const startedAt = performance.now();

    const res = await fetch(`${baseUrl}/health/ready`);
    const elapsedMs = performance.now() - startedAt;

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: { status: 'up' }, sqs: { status: 'down', reason: 'timeout' } },
    });
    expect(elapsedMs).toBeLessThan(timeoutMs + 1500);
  });
});
