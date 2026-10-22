import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { defaultIdempotencyKey } from '../../../../../../src/modules/wagering/application/payload-hash';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../../../../src/modules/wagering/application/submit-wager-transaction';
import { WagerTransactionKind } from '../../../../../../src/modules/wagering/domain/wager-transaction';
import { Money } from '../../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../../support/create-test-app';
import { resetDatabase } from '../../../../../support/database';
import { newProviderId, openWalletWithBalance } from '../../../../../support/fixtures';
import { waitFor } from '../../../../../support/sqs';
import { assertWalletConsistent } from '../../../../../support/wallet-consistency';

const POLL_INTERVAL_MS = 100;

describe('PendingReferenceWorker (app, Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    // Pendentes de outras suítes seriam reavaliadas assim que o worker subisse: o banco é limpo antes disso.
    const cleaner = await createTestApp();
    await resetDatabase(cleaner.get(MikroORM));
    await cleaner.close();
    app = await createTestApp({
      pendingReferenceWorker: { pollIntervalMs: POLL_INTERVAL_MS, retryBaseDelayMs: 50, retryMaxDelayMs: 100 },
    });
    orm = app.get(MikroORM);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await resetDatabase(orm);
    await app?.close();
  });

  beforeEach(() => resetDatabase(orm));

  async function statusOf(transactionId: string): Promise<string | undefined> {
    const [row] = await orm.em
      .fork()
      .execute<{ status: string }[]>('select status from wager_transactions where id = ?', [transactionId]);
    return row?.status;
  }

  it('resolves a REFUND that arrived before its BET on its own and exposes the metric', async () => {
    const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });
    const providerId = newProviderId();
    const submit = app.get(SubmitWagerTransaction);
    const base = {
      providerId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: `round-${Bun.randomUUIDv7()}`,
      gameId: 'game-1',
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      correlationId: Bun.randomUUIDv7(),
    };
    const betExternalId = `ext-${Bun.randomUUIDv7()}`;
    const refundExternalId = `ext-${Bun.randomUUIDv7()}`;
    const refundCommand: SubmitWagerTransactionCommand = {
      ...base,
      idempotencyKey: defaultIdempotencyKey(providerId, refundExternalId),
      externalTransactionId: refundExternalId,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: betExternalId,
    };

    const pending = (await submit.execute(refundCommand)).transaction;
    await submit.execute({
      ...base,
      idempotencyKey: defaultIdempotencyKey(providerId, betExternalId),
      externalTransactionId: betExternalId,
      kind: WagerTransactionKind.Bet,
    });

    await waitFor(async () => ((await statusOf(pending.id)) === 'PROCESSED' ? true : null));

    const text = await (await fetch(`${baseUrl}/metrics`)).text();
    const processed = /^pending_reference_reprocessed_total\{[^}]*outcome="processed"[^}]*\} (\d+)$/m.exec(text);
    expect(Number(processed?.[1])).toBeGreaterThanOrEqual(1);
    await assertWalletConsistent(orm, wallet.id);
  });

  it('stops promptly on app.close() even while it waits for the next cycle', async () => {
    const idle = await createTestApp({ pendingReferenceWorker: { pollIntervalMs: 60_000 } });

    const startedAt = performance.now();
    await idle.close();

    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});
