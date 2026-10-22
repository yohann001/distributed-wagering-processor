import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import type { HttpErrorBody } from '../../../../../src/infrastructure/http/http-error-mapping';
import type { SubmitResponse } from '../../../../../src/modules/wagering/presentation/wager-transaction-http.schemas';
import { LedgerDirection } from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import type {
  LedgerPageResponse,
  ReconciliationResponse,
  WalletResponse,
} from '../../../../../src/modules/wallet/presentation/wallet-http.schemas';
import { FailureAction, FailureCode } from '../../../../../src/shared/domain/failure-code';
import { createTestApp } from '../../../../support/create-test-app';
import { newProviderId } from '../../../../support/fixtures';
import { expectMoney, getJson, postJson, postRaw, type HttpResult } from '../../../../support/http';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

function brl(amount: string) {
  return { amount, currency: 'BRL' };
}

/** Todo erro tem o mesmo corpo `{ failureCode, action, message }`. */
function expectErrorBody(
  response: HttpResult<HttpErrorBody>,
  status: number,
  failureCode: FailureCode,
): HttpErrorBody {
  expect(response.status).toBe(status);
  expect(response.body.failureCode).toBe(failureCode);
  expect(typeof response.body.action).toBe('string');
  expect(typeof response.body.message).toBe('string');
  return response.body;
}

/** O corpo comum mais o `X-Correlation-Id` que o pino-http devolve em toda resposta. */
function expectError(
  response: HttpResult<HttpErrorBody>,
  status: number,
  failureCode: FailureCode,
): HttpErrorBody {
  const body = expectErrorBody(response, status, failureCode);
  expect(response.headers.get('x-correlation-id')).not.toBeNull();
  return body;
}

describe('wallet HTTP API (app real + Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function openWallet(amount: string, playerId = Bun.randomUUIDv7()): Promise<WalletResponse> {
    const response = await postJson<WalletResponse>(baseUrl, '/wallets', {
      playerId,
      initialBalance: brl(amount),
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  describe('POST /wallets and GET /wallets/:walletId', () => {
    it('opens a wallet with 201 and reads it back with the same body', async () => {
      const playerId = Bun.randomUUIDv7();

      const created = await postJson<WalletResponse>(baseUrl, '/wallets', {
        playerId,
        initialBalance: brl('1000.00'),
      });

      expect(created.status).toBe(201);
      expect(created.body.playerId).toBe(playerId);
      expect(created.body.version).toBe(1);
      expectMoney(created.body.balance, '1000.00');

      const read = await getJson<WalletResponse>(baseUrl, `/wallets/${created.body.id}`);

      expect(read.status).toBe(200);
      expect(read.body).toEqual(created.body);
      await assertWalletConsistent(orm, created.body.id);
    });

    it('opens a wallet with a zero balance and an empty ledger', async () => {
      const wallet = await openWallet('0.00');

      expectMoney(wallet.balance, '0.00');
      const ledger = await getJson<LedgerPageResponse>(baseUrl, `/wallets/${wallet.id}/ledger`);

      expect(ledger.status).toBe(200);
      expect(ledger.body).toEqual({ items: [], nextCursor: null });
      await assertWalletConsistent(orm, wallet.id);
    });

    it('lowercases an uppercase UUID playerId and then refuses the duplicate with 409', async () => {
      const playerId = Bun.randomUUIDv7();

      const first = await postJson<WalletResponse>(baseUrl, '/wallets', {
        playerId: playerId.toUpperCase(),
        initialBalance: brl('10.00'),
      });
      const duplicate = await postJson<HttpErrorBody>(baseUrl, '/wallets', {
        playerId,
        initialBalance: brl('10.00'),
      });

      expect(first.status).toBe(201);
      expect(first.body.playerId).toBe(playerId);
      const error = expectError(duplicate, 409, FailureCode.WalletAlreadyExists);
      expect(error.action).toBe(FailureAction.GiveUp);
    });

    it('answers 400 INVALID_PAYLOAD with the issue path when playerId is missing', async () => {
      const response = await postJson<HttpErrorBody>(baseUrl, '/wallets', { initialBalance: brl('10.00') });

      const error = expectError(response, 400, FailureCode.InvalidPayload);
      expect(error.action).toBe(FailureAction.FixPayload);
      expect(error.issues?.map((issue) => issue.path)).toEqual(['body.playerId']);
    });

    it.each([
      ['a numeric amount', { amount: 1000, currency: 'BRL' }],
      ['an amount without 2 decimal places', { amount: '10.5', currency: 'BRL' }],
      ['a negative amount', { amount: '-1.00', currency: 'BRL' }],
      ['a null initialBalance', null],
    ])('answers 400 INVALID_MONEY for %s', async (_name, initialBalance) => {
      const response = await postJson<HttpErrorBody>(baseUrl, '/wallets', {
        playerId: Bun.randomUUIDv7(),
        initialBalance,
      });

      expectError(response, 400, FailureCode.InvalidMoney);
    });

    it('answers 400 INVALID_PAYLOAD when initialBalance is absent', async () => {
      const response = await postJson<HttpErrorBody>(baseUrl, '/wallets', { playerId: Bun.randomUUIDv7() });

      const error = expectError(response, 400, FailureCode.InvalidPayload);
      expect(error.issues?.map((issue) => issue.path)).toEqual(['body.initialBalance']);
    });

    it('answers 400 INVALID_PAYLOAD for malformed JSON without echoing the input', async () => {
      const response = await postRaw<HttpErrorBody>(baseUrl, '/wallets', '{"playerId": "leak-marker-xyz", ');

      const error = expectError(response, 400, FailureCode.InvalidPayload);
      expect(error.message).not.toContain('leak-marker-xyz');
      expect(response.headers.get('x-correlation-id')).toBeTruthy();
    });

    it('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
      const response = await getJson<HttpErrorBody>(baseUrl, `/wallets/${Bun.randomUUIDv7()}`);

      const error = expectError(response, 404, FailureCode.WalletNotFound);
      expect(error.action).toBe(FailureAction.FixPayload);
    });

    it('answers 400 for a walletId that is not a UUID', async () => {
      const response = await getJson<HttpErrorBody>(baseUrl, '/wallets/not-a-uuid');

      const error = expectError(response, 400, FailureCode.InvalidPayload);
      expect(error.issues?.map((issue) => issue.path)).toEqual(['params.walletId']);
    });

    it('accepts an uppercase wallet id', async () => {
      const wallet = await openWallet('5.00');

      const response = await getJson<WalletResponse>(baseUrl, `/wallets/${wallet.id.toUpperCase()}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(wallet.id);
    });
  });

  describe('GET /wallets/:walletId/ledger', () => {
    it('pages the ledger newest first with money as strings', async () => {
      const wallet = await openWallet('100.00');
      const providerId = newProviderId();
      for (const [index, amount] of ['20.00', '15.00'].entries()) {
        const bet = await postJson<SubmitResponse>(
          baseUrl,
          '/wagering/transactions',
          {
            providerId,
            externalTransactionId: `bet-${index}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `round-${index}`,
            gameId: 'game-1',
            kind: 'BET',
            money: brl(amount),
          },
          { 'Idempotency-Key': `${providerId}:bet-${index}` },
        );
        expect(bet.status).toBe(200);
      }

      const pages: LedgerPageResponse[] = [];
      let path = `/wallets/${wallet.id}/ledger?limit=1`;
      for (;;) {
        const page = await getJson<LedgerPageResponse>(baseUrl, path);
        expect(page.status).toBe(200);
        expect(page.body.items).toHaveLength(1);
        pages.push(page.body);
        if (page.body.nextCursor === null) {
          break;
        }
        path = `/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`;
      }

      const entries = pages.flatMap((page) => page.items);
      expect(entries.map((entry) => entry.direction)).toEqual([LedgerDirection.Debit, LedgerDirection.Debit, LedgerDirection.Credit]);
      expectMoney(entries[0]?.money, '15.00');
      expectMoney(entries[0]?.balanceBefore, '80.00');
      expectMoney(entries[0]?.balanceAfter, '65.00');
      expectMoney(entries[1]?.balanceAfter, '80.00');
      expectMoney(entries[2]?.balanceAfter, '100.00');
      expect(typeof entries[0]?.createdAt).toBe('string');
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(3);

      const whole = await getJson<LedgerPageResponse>(baseUrl, `/wallets/${wallet.id}/ledger`);
      expect(whole.body.items.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
      expect(whole.body.nextCursor).toBeNull();
      await assertWalletConsistent(orm, wallet.id);
    });

    it.each([
      ['a non-numeric limit', 'limit=abc'],
      ['a zero limit', 'limit=0'],
      ['a limit above 100', 'limit=101'],
      ['a malformed cursor', 'cursor=%%%'],
      ['a repeated limit', 'limit=1&limit=2'],
    ])('answers 400 INVALID_PAYLOAD for %s', async (_name, query) => {
      const wallet = await openWallet('1.00');

      const response = await getJson<HttpErrorBody>(baseUrl, `/wallets/${wallet.id}/ledger?${query}`);

      expectError(response, 400, FailureCode.InvalidPayload);
    });

    it.each([
      ['a zero limit', 'limit=0', 'query.limit'],
      ['a limit above 100', 'limit=101', 'query.limit'],
      ['a limit with five digits', 'limit=10000', 'query.limit'],
      ['a cursor that does not decode', 'cursor=abc', 'query.cursor'],
    ])('reports %s in issues, like every other invalid parameter', async (_name, query, path) => {
      const wallet = await openWallet('1.00');

      const response = await getJson<HttpErrorBody>(baseUrl, `/wallets/${wallet.id}/ledger?${query}`);

      const error = expectError(response, 400, FailureCode.InvalidPayload);
      expect(error.issues?.map((issue) => issue.path)).toEqual([path]);
      if (path === 'query.limit') {
        expect(error.issues?.[0]?.message).toBe('must be an integer between 1 and 100');
      }
    });

    it('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
      const response = await getJson<HttpErrorBody>(baseUrl, `/wallets/${Bun.randomUUIDv7()}/ledger`);

      expectError(response, 404, FailureCode.WalletNotFound);
    });
  });

  describe('request bodies the API does not accept', () => {
    async function walletCountOf(playerId: string): Promise<number> {
      const rows = await orm.em
        .fork()
        .execute<{ total: string }[]>('select count(*)::text as total from wallets where player_id = ?', [playerId]);
      return Number(rows[0]?.total);
    }

    it('answers 413 INVALID_PAYLOAD for a body over the JSON limit and writes nothing', async () => {
      const playerId = Bun.randomUUIDv7();
      const body = JSON.stringify({ playerId, initialBalance: brl('1.00'), padding: 'a'.repeat(200_000) });

      const response = await postRaw<HttpErrorBody>(baseUrl, '/wallets', body);

      const error = expectError(response, 413, FailureCode.InvalidPayload);
      expect(error.action).toBe(FailureAction.FixPayload);
      expect(await walletCountOf(playerId)).toBe(0);
    });

    it('answers 415 INVALID_PAYLOAD for an unsupported charset', async () => {
      const response = await postRaw<HttpErrorBody>(baseUrl, '/wallets', '{}', {
        'Content-Type': 'application/json; charset=latin9',
      });

      expectError(response, 415, FailureCode.InvalidPayload);
    });

    it('does not parse form-urlencoded bodies, so a cross-site form cannot open a funded wallet', async () => {
      const playerId = Bun.randomUUIDv7();
      const form = `playerId=${playerId}&initialBalance[amount]=1.00&initialBalance[currency]=BRL`;

      const response = await postRaw<HttpErrorBody>(baseUrl, '/wallets', form, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expectError(response, 400, FailureCode.InvalidPayload);
      expect(await walletCountOf(playerId)).toBe(0);
    });
  });

  describe('POST /wallets/:walletId/reconciliation', () => {
    it('reports a consistent wallet', async () => {
      const wallet = await openWallet('1000.00');

      const response = await postJson<ReconciliationResponse>(
        baseUrl,
        `/wallets/${wallet.id}/reconciliation`,
        {},
      );

      expect(response.status).toBe(200);
      expect(response.body.walletId).toBe(wallet.id);
      expectMoney(response.body.storedBalance, '1000.00');
      expectMoney(response.body.calculatedBalance, '1000.00');
      expectMoney(response.body.difference, '0.00');
      expect(response.body.consistent).toBe(true);
      expect(response.body.checkedEntries).toBe(1);
      await assertWalletConsistent(orm, wallet.id);
    });

    it('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
      const response = await postJson<HttpErrorBody>(
        baseUrl,
        `/wallets/${Bun.randomUUIDv7()}/reconciliation`,
        {},
      );

      expectError(response, 404, FailureCode.WalletNotFound);
    });

    it('answers 400 for a walletId that is not a UUID', async () => {
      const response = await postJson<HttpErrorBody>(baseUrl, '/wallets/not-a-uuid/reconciliation', {});

      expectError(response, 400, FailureCode.InvalidPayload);
    });
  });

  describe('unknown routes', () => {
    it('answers 404 with the common error body and INVALID_PAYLOAD', async () => {
      const response = await getJson<HttpErrorBody>(baseUrl, '/nope');

      const error = expectError(response, 404, FailureCode.InvalidPayload);
      expect(error.message).toBe('Route not found');
    });
  });
});

describe('wallet HTTP API: connection pool exhausted (app real + Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    // As factories leem o ambiente ao compilar o módulo: o valor só precisa valer durante o createTestApp.
    const previous = {
      poolMax: process.env.DATABASE_POOL_MAX,
      acquireTimeout: process.env.DB_POOL_ACQUIRE_TIMEOUT_MS,
    };
    process.env.DATABASE_POOL_MAX = '1';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '300';
    try {
      app = await createTestApp();
    } finally {
      restoreEnv('DATABASE_POOL_MAX', previous.poolMax);
      restoreEnv('DB_POOL_ACQUIRE_TIMEOUT_MS', previous.acquireTimeout);
    }
    orm = app.get(MikroORM);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  it('answers a read with 503 TRANSIENT_FAILURE and Retry-After when no connection frees up in time', async () => {
    const client = orm.em.getConnection().getKnex().client;
    const held: unknown = await client.acquireConnection();

    let response: HttpResult<HttpErrorBody>;
    const startedAt = performance.now();
    try {
      response = await getJson<HttpErrorBody>(baseUrl, `/wallets/${Bun.randomUUIDv7()}`);
    } finally {
      await client.releaseConnection(held);
    }

    const error = expectError(response, 503, FailureCode.TransientFailure);
    expect(error.action).toBe(FailureAction.Retry);
    expect(response.headers.get('retry-after')).toBe('1');
    // Falha pelo acquire timeout de 300 ms, não pelo padrão de 60 s do knex.
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});
