import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import type { HttpErrorBody } from '../../../../../src/infrastructure/http/http-error-mapping';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import type {
  SubmitResponse,
  TransactionResponse,
} from '../../../../../src/modules/wagering/presentation/wager-transaction-http.schemas';
import type { WalletResponse } from '../../../../../src/modules/wallet/presentation/wallet-http.schemas';
import { FailureAction, FailureCode } from '../../../../../src/shared/domain/failure-code';
import { createTestApp } from '../../../../support/create-test-app';
import { newProviderId } from '../../../../support/fixtures';
import { expectMoney, getJson, postJson, postRaw, type HttpResult } from '../../../../support/http';
import { createLogCapture } from '../../../../support/log-capture';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

const WARN_LEVEL = 40;

function brl(amount: string) {
  return { amount, currency: 'BRL' };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Scenario {
  providerId: string;
  playerId: string;
  walletId: string;
}

type Payload = Record<string, unknown>;

function betPayload(scenario: Scenario, externalTransactionId: string, overrides: Payload = {}): Payload {
  return {
    providerId: scenario.providerId,
    externalTransactionId,
    playerId: scenario.playerId,
    walletId: scenario.walletId,
    roundId: `round-${externalTransactionId}`,
    gameId: 'game-1',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
}

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

describe('wagering HTTP API (app real + Postgres real)', () => {
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

  async function openScenario(amount = '1000.00'): Promise<Scenario> {
    const playerId = Bun.randomUUIDv7();
    const wallet = await postJson<WalletResponse>(baseUrl, '/wallets', {
      playerId,
      initialBalance: brl(amount),
    });
    expect(wallet.status).toBe(201);
    return { providerId: newProviderId(), playerId, walletId: wallet.body.id };
  }

  function submit<T = SubmitResponse>(payload: Payload, key: string): Promise<HttpResult<T>> {
    return postJson<T>(baseUrl, '/wagering/transactions', payload, { 'Idempotency-Key': key });
  }

  async function balanceOf(walletId: string): Promise<string> {
    const wallet = await getJson<WalletResponse>(baseUrl, `/wallets/${walletId}`);
    return wallet.body.balance.amount;
  }

  async function storedTransactionCount(externalTransactionId: string): Promise<number> {
    const rows = await orm.em
      .fork()
      .execute<{ total: string }[]>(
        'select count(*)::text as total from wager_transactions where lower(external_transaction_id) = lower(?)',
        [externalTransactionId],
      );
    return Number(rows[0]?.total);
  }

  describe('POST /wagering/transactions', () => {
    it('answers 200 PROCESSED and replays the same status and body with idempotentReplay', async () => {
      const scenario = await openScenario();
      const payload = betPayload(scenario, 'bet-1');
      const key = `${scenario.providerId}:bet-1`;

      const first = await submit(payload, key);

      expect(first.status).toBe(200);
      expect(first.body.status).toBe(WagerTransactionStatus.Processed);
      expect(first.body.failureCode).toBeNull();
      expect(first.body.idempotentReplay).toBe(false);
      expect(typeof first.body.transactionId).toBe('string');
      expectMoney(first.body.balance, '975.00');

      const second = await submit(payload, key);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ ...first.body, idempotentReplay: true });

      // O replay devolve o saldo da época, mesmo depois de o saldo mudar (§7 regra 7).
      const next = await submit(betPayload(scenario, 'bet-2'), `${scenario.providerId}:bet-2`);
      expectMoney(next.body.balance, '950.00');
      const replayAfterChange = await submit(payload, key);
      expect(replayAfterChange.body).toEqual({ ...first.body, idempotentReplay: true });

      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('answers 409 IDEMPOTENCY_CONFLICT for the same key with another payload and changes nothing', async () => {
      const scenario = await openScenario();
      const key = `${scenario.providerId}:secret-key-marker`;
      const original = await submit(betPayload(scenario, 'bet-1'), key);
      expect(original.status).toBe(200);

      const conflict = await submit<HttpErrorBody>(betPayload(scenario, 'bet-1', { money: brl('30.00') }), key);

      const error = expectErrorBody(conflict, 409, FailureCode.IdempotencyConflict);
      expect(error.action).toBe(FailureAction.FixPayload);
      expect(error.message).not.toContain('secret-key-marker');
      expect(await balanceOf(scenario.walletId)).toBe('975.00');
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('answers 422 REJECTED for insufficient funds, with the observed balance, also on replay', async () => {
      const scenario = await openScenario('100.00');
      const payload = betPayload(scenario, 'big-bet', { money: brl('200.00') });
      const key = `${scenario.providerId}:big-bet`;

      const first = await submit(payload, key);

      expect(first.status).toBe(422);
      expect(first.body.status).toBe(WagerTransactionStatus.Rejected);
      expect(first.body.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(first.body.idempotentReplay).toBe(false);
      expectMoney(first.body.balance, '100.00');

      const replay = await submit(payload, key);
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(await balanceOf(scenario.walletId)).toBe('100.00');
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('answers 422 REJECTED WALLET_NOT_FOUND without a balance for an unknown wallet', async () => {
      const scenario = await openScenario();
      const payload = betPayload(scenario, 'ghost-bet', { walletId: Bun.randomUUIDv7() });

      const response = await submit(payload, `${scenario.providerId}:ghost-bet`);

      expect(response.status).toBe(422);
      expect(response.body.status).toBe(WagerTransactionStatus.Rejected);
      expect(response.body.failureCode).toBe(FailureCode.WalletNotFound);
      expect(response.body.balance).toBeNull();
    });

    it('answers 202 PENDING_REFERENCE without a balance when the reference never arrived', async () => {
      const scenario = await openScenario();
      const payload = betPayload(scenario, 'refund-1', {
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-that-never-came',
      });
      const key = `${scenario.providerId}:refund-1`;

      const first = await submit(payload, key);

      expect(first.status).toBe(202);
      expect(first.body.status).toBe(WagerTransactionStatus.PendingReference);
      expect(first.body.balance).toBeNull();
      expect(first.body.failureCode).toBeNull();

      const replay = await submit(payload, key);
      expect(replay.status).toBe(202);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('lowercases UUID fields before the hash, so lowercase after uppercase is a replay and not a conflict', async () => {
      const scenario = await openScenario();
      const externalTransactionId = Bun.randomUUIDv7();
      const key = `${scenario.providerId}:normalization`;
      const uppercase = betPayload(scenario, externalTransactionId.toUpperCase(), {
        playerId: scenario.playerId.toUpperCase(),
        walletId: scenario.walletId.toUpperCase(),
      });

      const first = await submit(uppercase, key);
      expect(first.status).toBe(200);
      expect(first.body.idempotentReplay).toBe(false);

      const stored = await getJson<TransactionResponse>(baseUrl, `/wagering/transactions/${first.body.transactionId}`);
      expect(stored.body.walletId).toBe(scenario.walletId);
      expect(stored.body.playerId).toBe(scenario.playerId);
      expect(stored.body.externalTransactionId).toBe(externalTransactionId);

      const lowercase = await submit(
        betPayload(scenario, externalTransactionId, {
          roundId: uppercase.roundId,
        }),
        key,
      );
      expect(lowercase.status).toBe(200);
      expect(lowercase.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(await balanceOf(scenario.walletId)).toBe('975.00');
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('answers 400 INVALID_PAYLOAD with the header path when Idempotency-Key is missing, and stores nothing', async () => {
      const scenario = await openScenario();

      const response = await postJson<HttpErrorBody>(baseUrl, '/wagering/transactions', betPayload(scenario, 'no-key'));

      const error = expectErrorBody(response, 400, FailureCode.InvalidPayload);
      expect(error.issues?.map((issue) => issue.path)).toEqual(['headers.idempotency-key']);
      expect(await storedTransactionCount('no-key')).toBe(0);
    });

    it.each([
      ['an OPENING kind', { kind: 'OPENING' }, FailureCode.KindNotAllowed],
      ['an unknown kind', { kind: 'FOO' }, FailureCode.InvalidPayload],
      ["a ':' in providerId", { providerId: 'a:b' }, FailureCode.InvalidPayload],
      ['a walletId that is not a UUID', { walletId: 'abc' }, FailureCode.InvalidPayload],
      ['a blank roundId', { roundId: '   ' }, FailureCode.InvalidPayload],
      ['a numeric amount', { money: { amount: 25, currency: 'BRL' } }, FailureCode.InvalidMoney],
      ['a REFUND without a reference', { kind: 'REFUND' }, FailureCode.ReferenceRequired],
    ])('answers 400 for %s and stores nothing', async (_name, overrides, failureCode) => {
      const scenario = await openScenario();
      const externalTransactionId = `invalid-${Bun.randomUUIDv7()}`;

      const response = await submit<HttpErrorBody>(
        betPayload(scenario, externalTransactionId, overrides),
        `${scenario.providerId}:${externalTransactionId}`,
      );

      expectErrorBody(response, 400, failureCode);
      const lookup = await getJson<HttpErrorBody>(
        baseUrl,
        `/providers/${scenario.providerId}/wagering/transactions/${externalTransactionId}`,
      );
      expectErrorBody(lookup, 404, FailureCode.TransactionNotFound);
      expect(await storedTransactionCount(externalTransactionId)).toBe(0);
      expect(await balanceOf(scenario.walletId)).toBe('1000.00');
    });

    it('answers 400 INVALID_PAYLOAD for malformed JSON without echoing the input', async () => {
      const response = await postRaw<HttpErrorBody>(baseUrl, '/wagering/transactions', '{"providerId": "leak-marker-xyz", ', {
        'Idempotency-Key': 'key-1',
        'X-Correlation-Id': 'corr-malformed-1',
      });

      const error = expectErrorBody(response, 400, FailureCode.InvalidPayload);
      expect(error.message).not.toContain('leak-marker-xyz');
      expect(response.headers.get('x-correlation-id')).toBe('corr-malformed-1');
    });

    it('answers 400 for a reversal that references itself instead of parking it in PENDING_REFERENCE', async () => {
      const scenario = await openScenario();
      const externalTransactionId = `self-${Bun.randomUUIDv7()}`;

      const response = await submit<HttpErrorBody>(
        betPayload(scenario, externalTransactionId, {
          kind: 'REFUND',
          referenceExternalTransactionId: externalTransactionId,
        }),
        `${scenario.providerId}:${externalTransactionId}`,
      );

      const error = expectErrorBody(response, 400, FailureCode.InvalidPayload);
      expect(error.issues?.map((issue) => issue.path)).toEqual(['body.referenceExternalTransactionId']);
      expect(await storedTransactionCount(externalTransactionId)).toBe(0);
    });

    it('does not advertise the internal OPENING kind when the kind is unknown', async () => {
      const scenario = await openScenario();

      const response = await submit<HttpErrorBody>(
        betPayload(scenario, 'unknown-kind', { kind: 'FOO' }),
        `${scenario.providerId}:unknown-kind`,
      );

      const error = expectErrorBody(response, 400, FailureCode.InvalidPayload);
      expect(error.issues?.[0]?.path).toBe('body.kind');
      expect(error.issues?.[0]?.message).not.toContain('OPENING');
    });

    it('replays a resend that sends the reference as null after omitting it, instead of a 409', async () => {
      const scenario = await openScenario();
      const key = `${scenario.providerId}:null-ref`;
      const first = await submit(betPayload(scenario, 'null-ref'), key);
      expect(first.status).toBe(200);

      const again = await submit(betPayload(scenario, 'null-ref', { referenceExternalTransactionId: null }), key);

      expect(again.status).toBe(200);
      expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
      await assertWalletConsistent(orm, scenario.walletId);
    });
  });

  describe('GET /wagering/transactions/:transactionId', () => {
    it('returns the full view with money as strings and without the payload hash', async () => {
      const scenario = await openScenario();
      const key = `${scenario.providerId}:bet-1`;
      const created = await submit(betPayload(scenario, 'bet-1'), key);

      const response = await getJson<TransactionResponse>(
        baseUrl,
        `/wagering/transactions/${created.body.transactionId}`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: created.body.transactionId,
        providerId: scenario.providerId,
        externalTransactionId: 'bet-1',
        idempotencyKey: key,
        walletId: scenario.walletId,
        playerId: scenario.playerId,
        roundId: 'round-bet-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: brl('25.00'),
        status: WagerTransactionStatus.Processed,
        failureCode: null,
        referenceExternalTransactionId: null,
        referenceTransactionId: null,
        balanceAfter: brl('975.00'),
        createdAt: expect.any(String),
        processedAt: expect.any(String),
      });
      expect(response.body).not.toHaveProperty('payloadHash');
      await assertWalletConsistent(orm, scenario.walletId);
    });

    it('accepts an uppercase transaction id', async () => {
      const scenario = await openScenario();
      const created = await submit(betPayload(scenario, 'bet-1'), `${scenario.providerId}:bet-1`);

      const response = await getJson<TransactionResponse>(
        baseUrl,
        `/wagering/transactions/${created.body.transactionId.toUpperCase()}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.transactionId);
    });

    it('answers 200 for a rejected transaction, because a GET is a read', async () => {
      const scenario = await openScenario('10.00');
      const rejected = await submit(betPayload(scenario, 'big-bet'), `${scenario.providerId}:big-bet`);
      expect(rejected.status).toBe(422);

      const response = await getJson<TransactionResponse>(
        baseUrl,
        `/wagering/transactions/${rejected.body.transactionId}`,
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(WagerTransactionStatus.Rejected);
      expect(response.body.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    it('answers 404 TRANSACTION_NOT_FOUND for an unknown transaction', async () => {
      const response = await getJson<HttpErrorBody>(baseUrl, `/wagering/transactions/${Bun.randomUUIDv7()}`);

      const error = expectErrorBody(response, 404, FailureCode.TransactionNotFound);
      expect(error.action).toBe(FailureAction.FixPayload);
    });

    it('answers 400 for a transaction id that is not a UUID', async () => {
      const response = await getJson<HttpErrorBody>(baseUrl, '/wagering/transactions/not-a-uuid');

      const error = expectErrorBody(response, 400, FailureCode.InvalidPayload);
      expect(error.issues?.map((issue) => issue.path)).toEqual(['params.transactionId']);
    });
  });

  describe('GET /providers/:providerId/wagering/transactions/:externalTransactionId', () => {
    it('finds the transaction by provider and external id', async () => {
      const scenario = await openScenario();
      const created = await submit(betPayload(scenario, 'bet-1'), `${scenario.providerId}:bet-1`);

      const response = await getJson<TransactionResponse>(
        baseUrl,
        `/providers/${scenario.providerId}/wagering/transactions/bet-1`,
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.transactionId);
      expectMoney(response.body.money, '25.00');
    });

    it('answers 404 TRANSACTION_NOT_FOUND for an unknown external id and for another provider', async () => {
      const scenario = await openScenario();
      await submit(betPayload(scenario, 'bet-1'), `${scenario.providerId}:bet-1`);

      const unknown = await getJson<HttpErrorBody>(
        baseUrl,
        `/providers/${scenario.providerId}/wagering/transactions/unknown`,
      );
      const otherProvider = await getJson<HttpErrorBody>(
        baseUrl,
        `/providers/${newProviderId()}/wagering/transactions/bet-1`,
      );

      expectErrorBody(unknown, 404, FailureCode.TransactionNotFound);
      expectErrorBody(otherProvider, 404, FailureCode.TransactionNotFound);
    });

    it("answers 400 for a providerId with ':'", async () => {
      const response = await getJson<HttpErrorBody>(baseUrl, '/providers/a%3Ab/wagering/transactions/bet-1');

      const error = expectErrorBody(response, 400, FailureCode.InvalidPayload);
      expect(error.issues?.map((issue) => issue.path)).toEqual(['params.providerId']);
    });
  });
});

describe('wagering HTTP API: transient infrastructure failure (app real + Postgres real)', () => {
  const capture = createLogCapture();
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    // As factories leem o ambiente ao compilar o módulo: o valor só precisa valer durante o createTestApp.
    const previous = {
      lockTimeout: process.env.DB_LOCK_TIMEOUT_MS,
      maxAttempts: process.env.DB_TRANSACTION_MAX_ATTEMPTS,
    };
    process.env.DB_LOCK_TIMEOUT_MS = '200';
    process.env.DB_TRANSACTION_MAX_ATTEMPTS = '1';
    try {
      app = await createTestApp({ logDestination: capture.stream });
    } finally {
      restoreEnv('DB_LOCK_TIMEOUT_MS', previous.lockTimeout);
      restoreEnv('DB_TRANSACTION_MAX_ATTEMPTS', previous.maxAttempts);
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

  it('answers 503 with Retry-After while the wallet is locked, stores nothing, and succeeds on resend', async () => {
    const playerId = Bun.randomUUIDv7();
    const wallet = await postJson<WalletResponse>(baseUrl, '/wallets', { playerId, initialBalance: brl('100.00') });
    const scenario: Scenario = { providerId: newProviderId(), playerId, walletId: wallet.body.id };
    const payload = betPayload(scenario, 'bet-1');
    const key = `${scenario.providerId}:bet-1`;

    const locked = deferred();
    const release = deferred();
    const owner = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [scenario.walletId]);
      locked.resolve();
      await release.promise;
    });
    await Promise.race([locked.promise, owner]);

    let blocked: HttpResult<HttpErrorBody>;
    try {
      blocked = await postJson<HttpErrorBody>(baseUrl, '/wagering/transactions', payload, {
        'Idempotency-Key': key,
      });
    } finally {
      release.resolve();
      await owner;
    }

    const error = expectErrorBody(blocked, 503, FailureCode.TransientFailure);
    expect(error.action).toBe(FailureAction.Retry);
    expect(blocked.headers.get('retry-after')).toBe('1');

    const logged = await capture.waitFor((line) => line.msg === 'request failed' && line.statusCode === 503);
    expect(logged.level).toBe(WARN_LEVEL);
    expect(logged.failureCode).toBe(FailureCode.TransientFailure);

    const lookup = await getJson<HttpErrorBody>(
      baseUrl,
      `/providers/${scenario.providerId}/wagering/transactions/bet-1`,
    );
    expectErrorBody(lookup, 404, FailureCode.TransactionNotFound);

    const resent = await postJson<SubmitResponse>(baseUrl, '/wagering/transactions', payload, {
      'Idempotency-Key': key,
    });
    expect(resent.status).toBe(200);
    expect(resent.body.status).toBe(WagerTransactionStatus.Processed);
    expect(resent.body.idempotentReplay).toBe(false);
    expectMoney(resent.body.balance, '75.00');
    await assertWalletConsistent(orm, scenario.walletId);
  });
});
