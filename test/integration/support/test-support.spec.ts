import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { WagerTransactionRepository } from '../../../src/modules/wagering/application/wager-transaction-repository';
import { WalletLedgerRepository } from '../../../src/modules/wallet/application/wallet-ledger-repository';
import { WalletRepository } from '../../../src/modules/wallet/application/wallet-repository';
import { createTestApp } from '../../support/create-test-app';
import { resetDatabase } from '../../support/database';
import { FIXTURE_OPENED_AT, newProviderId, openWalletWithBalance } from '../../support/fixtures';
import { inFreshContext, present } from '../../support/orm-context';
import { APP_TABLES } from '../../support/schema-objects';
import { createTestSqsClient, purgeQueue, receiveAll, testQueueUrls } from '../../support/sqs';
import { assertWalletConsistent } from '../../support/wallet-consistency';

interface RawMovement {
  kind: 'OPENING' | 'BET' | 'WIN';
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  /** Saldo e version gravados na wallet junto com o lançamento. */
  walletBalance: string;
  walletVersion: number;
}

describe('test support (Postgres e LocalStack reais)', () => {
  let app: INestApplication;
  let orm: MikroORM;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Grava, por SQL direto e numa só transação, uma transação PROCESSED, o lançamento e o novo saldo da wallet. */
  async function appendRawMovement(
    wallet: { id: string; playerId: string; currency: string },
    movement: RawMovement,
  ): Promise<void> {
    const transactionId = Bun.randomUUIDv7();
    await orm.em.fork().transactional(async (em) => {
      await em.execute(
        `insert into wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, status, balance_after, processed_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSED', ?, ?, ?)`,
        [
          transactionId,
          newProviderId(),
          `ext-${transactionId}`,
          `idem-${transactionId}`,
          `hash-${transactionId}`,
          wallet.id,
          wallet.playerId,
          `round-${transactionId}`,
          'game-1',
          movement.kind,
          movement.amount,
          wallet.currency,
          movement.balanceAfter,
          FIXTURE_OPENED_AT,
          FIXTURE_OPENED_AT,
        ],
      );
      await em.execute(
        `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Bun.randomUUIDv7(),
          wallet.id,
          transactionId,
          movement.direction,
          movement.amount,
          wallet.currency,
          movement.balanceBefore,
          movement.balanceAfter,
          FIXTURE_OPENED_AT,
        ],
      );
      await em.execute('update wallets set balance = ?, version = ? where id = ?', [
        movement.walletBalance,
        movement.walletVersion,
        wallet.id,
      ]);
    });
  }

  async function countRows(table: string): Promise<number> {
    const rows = await orm.em.fork().execute<{ total: number }[]>(`select count(*)::int as total from ${table}`);
    return present(rows[0], `count of ${table}`).total;
  }

  describe('resetDatabase', () => {
    beforeEach(() => resetDatabase(orm));

    it('empties the 5 tables, including the ones guarded by triggers', async () => {
      await openWalletWithBalance(app, { amount: '100.00' });
      await orm.em.fork().transactional(async (em) => {
        await em.execute(
          'insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, ?)',
          ['consumer', 'message-1', 'hash', FIXTURE_OPENED_AT],
        );
        await em.execute(
          `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
           values (?, ?, ?, ?, ?, ?)`,
          [Bun.randomUUIDv7(), Bun.randomUUIDv7(), 'wallet.opened', '{}', FIXTURE_OPENED_AT, FIXTURE_OPENED_AT],
        );
      });
      for (const table of APP_TABLES) {
        expect(await countRows(table)).toBeGreaterThan(0);
      }

      await resetDatabase(orm);

      for (const table of APP_TABLES) {
        expect(await countRows(table)).toBe(0);
      }
    });

    it('refuses to run when NODE_ENV is production', async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await expect(resetDatabase(orm)).rejects.toThrow('must never run in production');
      } finally {
        if (previous === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = previous;
        }
      }
    });
  });

  describe('fixtures', () => {
    beforeEach(() => resetDatabase(orm));

    it('persists a wallet with its OPENING transaction and opening ledger entry', async () => {
      const { wallet, openingTransaction, openingEntry } = await openWalletWithBalance(app, { amount: '100.00' });

      const readWallet = present(
        await inFreshContext(orm, () => app.get(WalletRepository).findById(wallet.id)),
        'wallet',
      );
      const readTransaction = present(
        await inFreshContext(orm, () =>
          app.get(WagerTransactionRepository).findById(present(openingTransaction, 'opening transaction').id),
        ),
        'opening transaction',
      );
      const readEntry = present(
        await inFreshContext(orm, () =>
          app.get(WalletLedgerRepository).findById(present(openingEntry, 'opening entry').id),
        ),
        'opening entry',
      );

      expect(readWallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(readWallet.version).toBe(1);
      expect(readTransaction.walletId).toBe(wallet.id);
      expect(readEntry.transactionId).toBe(readTransaction.id);
      expect(readEntry.walletId).toBe(wallet.id);
    });

    it('persists only the wallet when the amount is zero, and honours the currency', async () => {
      const { wallet, openingTransaction, openingEntry } = await openWalletWithBalance(app, {
        amount: '0.00',
        currency: 'USD',
      });

      const readWallet = present(
        await inFreshContext(orm, () => app.get(WalletRepository).findById(wallet.id)),
        'wallet',
      );

      expect(readWallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
      expect(openingTransaction).toBeUndefined();
      expect(openingEntry).toBeUndefined();
      expect(await countRows('wager_transactions')).toBe(0);
      expect(await countRows('wallet_ledger_entries')).toBe(0);
    });

    it('returns a distinct provider id on every call', () => {
      expect(newProviderId()).not.toBe(newProviderId());
    });
  });

  describe('assertWalletConsistent', () => {
    beforeEach(() => resetDatabase(orm));

    it('passes for a wallet with a zero balance', async () => {
      const { wallet } = await openWalletWithBalance(app, { amount: '0.00' });

      await assertWalletConsistent(orm, wallet.id);
    });

    it('passes for a wallet opened with a balance', async () => {
      const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });

      await assertWalletConsistent(orm, wallet.id);
    });

    it('passes for a wallet opened with a balance and followed by a debit', async () => {
      const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });
      await appendRawMovement(wallet, {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '80.00',
        balanceBefore: '100.00',
        balanceAfter: '20.00',
        walletBalance: '20.00',
        walletVersion: 2,
      });

      await assertWalletConsistent(orm, wallet.id);
    });

    it('passes for a wallet opened with a zero balance and followed by a credit (version 2, one entry)', async () => {
      const { wallet } = await openWalletWithBalance(app, { amount: '0.00' });
      await appendRawMovement(wallet, {
        kind: 'WIN',
        direction: 'CREDIT',
        amount: '50.00',
        balanceBefore: '0.00',
        balanceAfter: '50.00',
        walletBalance: '50.00',
        walletVersion: 2,
      });

      await assertWalletConsistent(orm, wallet.id);
    });

    it('fails when a wallet opened with a zero balance keeps version 1 after a credit', async () => {
      const { wallet } = await openWalletWithBalance(app, { amount: '0.00' });
      await appendRawMovement(wallet, {
        kind: 'WIN',
        direction: 'CREDIT',
        amount: '50.00',
        balanceBefore: '0.00',
        balanceAfter: '50.00',
        walletBalance: '50.00',
        walletVersion: 1,
      });

      await expect(assertWalletConsistent(orm, wallet.id)).rejects.toThrow('version 1 does not match');
    });

    it('fails when the wallet balance differs from the ledger sum', async () => {
      const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });
      await orm.em.fork().execute("update wallets set balance = '99.00' where id = ?", [wallet.id]);

      await expect(assertWalletConsistent(orm, wallet.id)).rejects.toThrow('differs from ledger sum');
    });

    it('fails when the version does not match the number of ledger entries', async () => {
      const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });
      await orm.em.fork().execute('update wallets set version = 2 where id = ?', [wallet.id]);

      await expect(assertWalletConsistent(orm, wallet.id)).rejects.toThrow('version 2 does not match 1 ledger entries');
    });

    it('fails when the balance chain is broken between two entries', async () => {
      const { wallet } = await openWalletWithBalance(app, { amount: '100.00' });
      await appendRawMovement(wallet, {
        kind: 'BET',
        direction: 'DEBIT',
        amount: '10.00',
        balanceBefore: '50.00',
        balanceAfter: '40.00',
        walletBalance: '40.00',
        walletVersion: 2,
      });

      await expect(assertWalletConsistent(orm, wallet.id)).rejects.toThrow('ledger chain broken at entry #1');
    });

    it('fails when the first entry does not start from a zero balance', async () => {
      const { wallet } = await openWalletWithBalance(app, { amount: '0.00' });
      await appendRawMovement(wallet, {
        kind: 'OPENING',
        direction: 'CREDIT',
        amount: '10.00',
        balanceBefore: '10.00',
        balanceAfter: '20.00',
        walletBalance: '20.00',
        walletVersion: 1,
      });

      await expect(assertWalletConsistent(orm, wallet.id)).rejects.toThrow('ledger chain broken at entry #0');
    });

    it('fails when the wallet does not exist', async () => {
      const walletId = Bun.randomUUIDv7();

      await expect(assertWalletConsistent(orm, walletId)).rejects.toThrow(`wallet ${walletId} not found`);
    });
  });

  describe('SQS helpers', () => {
    let client: SQSClient;
    const { dlq } = testQueueUrls();

    beforeAll(() => {
      client = createTestSqsClient();
    });

    afterAll(() => {
      client?.destroy();
    });

    function send(n: number): Promise<unknown> {
      return client.send(
        new SendMessageCommand({
          QueueUrl: dlq,
          MessageBody: JSON.stringify({ n }),
          MessageGroupId: `group-${n}`,
          MessageDeduplicationId: Bun.randomUUIDv7(),
        }),
      );
    }

    it('reads back every message sent to the DLQ, and purge leaves the queue empty', async () => {
      await purgeQueue(client, dlq);
      await Promise.all([send(0), send(1), send(2)]);

      const messages = await receiveAll(client, dlq, { expected: 3 });

      const bodies = messages.map((message) => JSON.parse(present(message.Body, 'message body')) as { n: number });
      expect(bodies.map((body) => body.n).sort()).toEqual([0, 1, 2]);

      await send(3);
      await purgeQueue(client, dlq);

      expect(await receiveAll(client, dlq)).toEqual([]);
    });
  });
});
