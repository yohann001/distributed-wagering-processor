import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { defaultIdempotencyKey } from '../../../../../../src/modules/wagering/application/payload-hash';
import { SubmitWagerTransaction } from '../../../../../../src/modules/wagering/application/submit-wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../../../src/modules/wagering/domain/wager-transaction';
import { Money } from '../../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../../support/create-test-app';
import { resetDatabase } from '../../../../../support/database';
import { newProviderId, openWalletWithBalance } from '../../../../../support/fixtures';
import {
  countingSqsClient,
  createTestSqsClient,
  purgeQueue,
  receiveAll,
  testQueueUrls,
  waitFor,
} from '../../../../../support/sqs';
import { assertWalletConsistent } from '../../../../../support/wallet-consistency';

const POLL_INTERVAL_MS = 20;
const BATCH_SIZE = 5;
// Sem o atraso, um worker pode drenar tudo sozinho entre dois polls do outro e o teste passaria sem disputa.
const SEND_DELAY_MS = 30;
const WALLETS = 10;
const BETS_PER_WALLET = 4;
/** Cada BET processada gera `WagerTransactionProcessed` e `WalletBalanceChanged`. */
const EVENTS_PER_BET = 2;

describe('Concurrent outbox publishers (two apps with workers, Postgres e LocalStack reais)', () => {
  const sqs = createTestSqsClient();
  const urls = testQueueUrls();
  const first = countingSqsClient({ sendDelayMs: SEND_DELAY_MS });
  const second = countingSqsClient({ sendDelayMs: SEND_DELAY_MS });
  let appA: INestApplication;
  let appB: INestApplication;
  let orm: MikroORM;

  beforeAll(async () => {
    // Linhas pendentes de outras suítes seriam publicadas assim que os workers subissem: o banco é limpo antes disso.
    const cleaner = await createTestApp();
    await resetDatabase(cleaner.get(MikroORM));
    await cleaner.close();
    await purgeQueue(sqs, urls.events);

    appA = await createTestApp({
      sqsClient: first.client,
      outboxPublisher: { pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE },
    });
    appB = await createTestApp({
      sqsClient: second.client,
      outboxPublisher: { pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE },
    });
    orm = appA.get(MikroORM);
  });

  afterAll(async () => {
    await resetDatabase(orm);
    await appA?.close();
    await appB?.close();
    sqs.destroy();
  });

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const [row] = await orm.em.fork().execute<{ total: number }[]>(`select count(*)::int as total ${sql}`, params);
    return row?.total ?? 0;
  }

  const pendingCount = () => count('from outbox_messages where published_at is null');
  const totalCount = () => count('from outbox_messages');
  const debitCount = (walletId: string) =>
    count("from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]);

  async function outboxIds(): Promise<string[]> {
    const rows = await orm.em.fork().execute<{ id: string }[]>('select id from outbox_messages order by id');
    return rows.map((row) => row.id);
  }

  async function balanceOf(walletId: string): Promise<string | undefined> {
    const [row] = await orm.em
      .fork()
      .execute<{ balance: string }[]>('select balance::text as balance from wallets where id = ?', [walletId]);
    return row?.balance;
  }

  it('publishes every event exactly once while two workers drain the outbox and transactions keep arriving', async () => {
    const wallets: { walletId: string; playerId: string; providerId: string }[] = [];
    for (let index = 0; index < WALLETS; index += 1) {
      const { wallet } = await openWalletWithBalance(appA, { amount: '100.00' });
      wallets.push({ walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() });
    }

    const submit = appA.get(SubmitWagerTransaction);
    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: BETS_PER_WALLET }, async () => {
          const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
          const { transaction } = await submit.execute({
            idempotencyKey: defaultIdempotencyKey(wallet.providerId, externalTransactionId),
            providerId: wallet.providerId,
            externalTransactionId,
            walletId: wallet.walletId,
            playerId: wallet.playerId,
            roundId: `round-${Bun.randomUUIDv7()}`,
            gameId: 'game-1',
            kind: WagerTransactionKind.Bet,
            money: Money.from({ amount: '10.00', currency: 'BRL' }),
            correlationId: Bun.randomUUIDv7(),
          });
          return transaction.status;
        }),
      ),
    );
    expect(results).toHaveLength(WALLETS * BETS_PER_WALLET);
    expect(results.every((status) => status === WagerTransactionStatus.Processed)).toBe(true);

    const total = WALLETS * BETS_PER_WALLET * EVENTS_PER_BET;
    await waitFor(async () => ((await pendingCount()) === 0 && (await totalCount()) === total ? true : null), 20000);

    const ids = await outboxIds();
    expect(ids).toHaveLength(total);
    const sent = [...first.sentEventIds, ...second.sentEventIds];
    expect(new Set(sent).size).toBe(sent.length);
    expect([...sent].sort()).toEqual([...ids].sort());
    expect(first.sentEventIds.length).toBeGreaterThan(0);
    expect(second.sentEventIds.length).toBeGreaterThan(0);
    expect(await count('from outbox_messages where published_at is not null')).toBe(total);

    const received = await receiveAll(sqs, urls.events, { expected: total, timeoutMs: 20000 });
    const receivedIds = received.map((message) => message.Attributes?.['MessageDeduplicationId']);
    expect(receivedIds).toHaveLength(total);
    expect([...receivedIds].sort()).toEqual([...ids].sort());

    for (const { walletId } of wallets) {
      expect(await balanceOf(walletId)).toBe('60.00');
      expect(await debitCount(walletId)).toBe(BETS_PER_WALLET);
      await assertWalletConsistent(orm, walletId);
    }
  }, 60_000);
});
