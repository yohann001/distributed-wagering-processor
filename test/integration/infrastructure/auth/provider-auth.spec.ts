import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import type { HttpErrorBody } from '../../../../src/infrastructure/http/http-error-mapping';
import {
  ProviderIdentityPort,
  type ProviderCredentials,
  type ProviderIdentity,
} from '../../../../src/shared/application/provider-identity';
import { FailureAction, FailureCode } from '../../../../src/shared/domain/failure-code';
import { createTestApp } from '../../../support/create-test-app';
import { newProviderId } from '../../../support/fixtures';
import { getJson, postJson, type HttpResult } from '../../../support/http';

/** Porta de teste: devolve sempre o mesmo resultado e guarda as credenciais que recebeu. */
class RecordingIdentityPort extends ProviderIdentityPort {
  readonly calls: ProviderCredentials[] = [];

  constructor(private readonly result: ProviderIdentity | null) {
    super();
  }

  async authenticate(credentials: ProviderCredentials): Promise<ProviderIdentity | null> {
    this.calls.push(credentials);
    return this.result;
  }
}

function brl(amount: string) {
  return { amount, currency: 'BRL' };
}

function expectUnauthenticated(response: HttpResult<HttpErrorBody>): void {
  expect(response.status).toBe(401);
  expect(response.body.failureCode).toBe(FailureCode.Unauthenticated);
  expect(response.body.action).toBe(FailureAction.FixPayload);
  expect(typeof response.body.message).toBe('string');
  expect(response.headers.get('x-correlation-id')).not.toBeNull();
}

async function countRows(orm: MikroORM, sql: string, value: string): Promise<number> {
  const rows = await orm.em.getConnection().execute<{ total: string }[]>(sql, [value]);
  return Number(rows[0]?.total);
}

type BusinessRoute = readonly [label: string, send: (baseUrl: string) => Promise<HttpResult<HttpErrorBody>>];

function validBetPayload(providerId: string, playerId: string) {
  return {
    providerId,
    externalTransactionId: 'bet-1',
    playerId,
    walletId: Bun.randomUUIDv7(),
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('25.00'),
  };
}

const BUSINESS_ROUTES: readonly BusinessRoute[] = [
  [
    'POST /wallets',
    (baseUrl) =>
      postJson<HttpErrorBody>(baseUrl, '/wallets', {
        playerId: Bun.randomUUIDv7(),
        initialBalance: brl('100.00'),
      }),
  ],
  ['GET /wallets/:walletId', (baseUrl) => getJson<HttpErrorBody>(baseUrl, `/wallets/${Bun.randomUUIDv7()}`)],
  [
    'GET /wallets/:walletId/ledger',
    (baseUrl) => getJson<HttpErrorBody>(baseUrl, `/wallets/${Bun.randomUUIDv7()}/ledger`),
  ],
  [
    'POST /wallets/:walletId/reconciliation',
    (baseUrl) => postJson<HttpErrorBody>(baseUrl, `/wallets/${Bun.randomUUIDv7()}/reconciliation`, {}),
  ],
  [
    'POST /wagering/transactions',
    (baseUrl) => {
      const providerId = newProviderId();
      return postJson<HttpErrorBody>(
        baseUrl,
        '/wagering/transactions',
        validBetPayload(providerId, Bun.randomUUIDv7()),
        { 'Idempotency-Key': `${providerId}:bet-1` },
      );
    },
  ],
  [
    'GET /wagering/transactions/:transactionId',
    (baseUrl) => getJson<HttpErrorBody>(baseUrl, `/wagering/transactions/${Bun.randomUUIDv7()}`),
  ],
  [
    'GET /providers/:providerId/wagering/transactions/:externalTransactionId',
    (baseUrl) =>
      getJson<HttpErrorBody>(baseUrl, `/providers/${newProviderId()}/wagering/transactions/ext-1`),
  ],
];

describe('provider authentication extension point (app real + Postgres real)', () => {
  describe('deny-all identity port', () => {
    const denyAll = new RecordingIdentityPort(null);
    let app: INestApplication;
    let orm: MikroORM;
    let baseUrl: string;

    beforeAll(async () => {
      app = await createTestApp({ providerIdentity: denyAll });
      orm = app.get(MikroORM);
      baseUrl = await app.getUrl();
    });

    afterAll(async () => {
      await app?.close();
    });

    it.each(BUSINESS_ROUTES)('%s answers 401 UNAUTHENTICATED with a correlation id', async (_label, send) => {
      expectUnauthenticated(await send(baseUrl));
    });

    it('stores nothing when a valid write is denied', async () => {
      const playerId = Bun.randomUUIDv7();
      const providerId = newProviderId();
      const idempotencyKey = `${providerId}:bet-denied`;

      const wallet = await postJson<HttpErrorBody>(baseUrl, '/wallets', {
        playerId,
        initialBalance: brl('100.00'),
      });
      const bet = await postJson<HttpErrorBody>(
        baseUrl,
        '/wagering/transactions',
        validBetPayload(providerId, playerId),
        { 'Idempotency-Key': idempotencyKey },
      );

      expectUnauthenticated(wallet);
      expectUnauthenticated(bet);
      expect(await countRows(orm, 'select count(*)::text as total from wallets where player_id = ?', playerId)).toBe(0);
      expect(
        await countRows(orm, 'select count(*)::text as total from wager_transactions where provider_id = ?', providerId),
      ).toBe(0);
      expect(
        await countRows(orm, 'select count(*)::text as total from inbox_messages where message_id = ?', idempotencyKey),
      ).toBe(0);
    });

    it('keeps /health/live and /metrics open without consulting the port', async () => {
      const callsBefore = denyAll.calls.length;

      const health = await fetch(`${baseUrl}/health/live`);
      const metrics = await fetch(`${baseUrl}/metrics`);
      await metrics.text();

      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });
      expect(metrics.status).toBe(200);
      expect(denyAll.calls.length).toBe(callsBefore);
    });

    it('answers 404 for an unknown route without consulting the port', async () => {
      const callsBefore = denyAll.calls.length;

      const response = await getJson<HttpErrorBody>(baseUrl, '/nope');

      expect(response.status).toBe(404);
      expect(denyAll.calls.length).toBe(callsBefore);
    });
  });

  describe('allowing identity port', () => {
    const allowing = new RecordingIdentityPort({ kind: 'provider', providerId: 'provider-a' });
    let app: INestApplication;
    let baseUrl: string;

    beforeAll(async () => {
      app = await createTestApp({ providerIdentity: allowing });
      baseUrl = await app.getUrl();
    });

    afterAll(async () => {
      await app?.close();
    });

    it('hands the Authorization header to the port as given and lets the request reach the handler', async () => {
      const walletUrl = `${baseUrl}/wallets/${Bun.randomUUIDv7()}`;

      const withHeader = await fetch(walletUrl, { headers: { Authorization: 'Bearer test-token' } });
      const withHeaderBody = (await withHeader.json()) as HttpErrorBody;

      expect(withHeader.status).toBe(404);
      expect(withHeaderBody.failureCode).toBe(FailureCode.WalletNotFound);
      expect(allowing.calls.at(-1)).toStrictEqual({ authorization: 'Bearer test-token' });

      const withoutHeader = await fetch(walletUrl);
      const withoutHeaderBody = (await withoutHeader.json()) as HttpErrorBody;

      expect(withoutHeader.status).toBe(404);
      expect(withoutHeaderBody.failureCode).toBe(FailureCode.WalletNotFound);
      expect(allowing.calls.at(-1)).toStrictEqual({ authorization: undefined });
    });
  });
});
