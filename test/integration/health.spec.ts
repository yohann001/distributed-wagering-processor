import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { createTestApp } from '../support/create-test-app';

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
});
