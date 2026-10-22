import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { createTestApp } from '../../../support/create-test-app';
import { expectDbError, resetDatabase, withRollback } from '../../../support/database';
import { newProviderId } from '../../../support/fixtures';
import { present } from '../../../support/orm-context';
import { EXPECTED_SCHEMA_OBJECTS, readSchemaObjects } from '../../../support/schema-objects';
import { assertWalletConsistent } from '../../../support/wallet-consistency';

const NOW = new Date('2026-10-22T10:00:00.000Z');

interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface TransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceAfter: string | null;
  processedAt: Date | null;
  createdAt: Date;
}

interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

interface InboxRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

interface OutboxRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: string;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Colunas e tabelas vêm só dos literais deste arquivo; os valores sempre vão como parâmetros. */
async function insertInto(em: EntityManager, table: string, row: object): Promise<void> {
  const entries = Object.entries(row);
  const columns = entries.map(([key]) => snakeCase(key));
  await em.execute(
    `insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    entries.map(([, value]) => value),
  );
}

async function insertWallet(em: EntityManager, overrides: Partial<WalletRow> = {}): Promise<WalletRow> {
  const row: WalletRow = {
    id: Bun.randomUUIDv7(),
    playerId: `player-${Bun.randomUUIDv7()}`,
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  await insertInto(em, 'wallets', row);
  return row;
}

/** Defaults: uma `BET` `PENDING` de 10.00, válida para todas as constraints. */
async function insertTransaction(
  em: EntityManager,
  overrides: Partial<TransactionRow> = {},
): Promise<TransactionRow> {
  const id = overrides.id ?? Bun.randomUUIDv7();
  const row: TransactionRow = {
    id,
    providerId: newProviderId(),
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `idem-${id}`,
    payloadHash: `hash-${id}`,
    walletId: Bun.randomUUIDv7(),
    playerId: `player-${Bun.randomUUIDv7()}`,
    roundId: `round-${id}`,
    gameId: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    status: 'PENDING',
    failureCode: null,
    balanceAfter: null,
    processedAt: null,
    createdAt: NOW,
    ...overrides,
  };
  await insertInto(em, 'wager_transactions', row);
  return row;
}

/** Overrides de uma `BET` `PROCESSED` da wallet, completa o bastante para todas as constraints. */
function processedBetFor(wallet: WalletRow, overrides: Partial<TransactionRow> = {}): Partial<TransactionRow> {
  return {
    walletId: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    kind: 'BET',
    amount: '10.00',
    status: 'PROCESSED',
    balanceAfter: '90.00',
    processedAt: NOW,
    ...overrides,
  };
}

/** Defaults: `DEBIT` de 10.00 de 100.00 para 90.00. */
async function insertLedgerEntry(
  em: EntityManager,
  overrides: Partial<LedgerRow> & Pick<LedgerRow, 'walletId' | 'transactionId'>,
): Promise<LedgerRow> {
  const row: LedgerRow = {
    id: Bun.randomUUIDv7(),
    direction: 'DEBIT',
    amount: '10.00',
    currency: 'BRL',
    balanceBefore: '100.00',
    balanceAfter: '90.00',
    createdAt: NOW,
    ...overrides,
  };
  await insertInto(em, 'wallet_ledger_entries', row);
  return row;
}

async function insertInbox(em: EntityManager, overrides: Partial<InboxRow> = {}): Promise<InboxRow> {
  const row: InboxRow = {
    consumerName: 'wager-consumer',
    messageId: `message-${Bun.randomUUIDv7()}`,
    payloadHash: 'hash',
    receivedAt: NOW,
    processedAt: null,
    ...overrides,
  };
  await insertInto(em, 'inbox_messages', row);
  return row;
}

async function insertOutbox(em: EntityManager, overrides: Partial<OutboxRow> = {}): Promise<OutboxRow> {
  const row: OutboxRow = {
    id: Bun.randomUUIDv7(),
    aggregateId: Bun.randomUUIDv7(),
    eventType: 'wallet.opened',
    payload: '{}',
    occurredAt: NOW,
    attempts: 0,
    nextAttemptAt: NOW,
    publishedAt: null,
    ...overrides,
  };
  await insertInto(em, 'outbox_messages', row);
  return row;
}

describe('schema constraints and triggers (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => resetDatabase(orm));

  /** Commit real: as FKs são `DEFERRABLE INITIALLY DEFERRED` e só são verificadas aqui. */
  function commit<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return orm.em.fork().transactional(fn);
  }

  function run(sql: string, params: unknown[] = []): Promise<unknown> {
    return orm.em.fork().execute(sql, params);
  }

  /** Wallet 20.00 (version 2) com a abertura de 100.00 e uma `BET` `PROCESSED` de 80.00 (100.00 para 20.00). */
  async function seedWalletWithBet(): Promise<{ wallet: WalletRow; bet: TransactionRow }> {
    return commit(async (em) => {
      const wallet = await insertWallet(em, { balance: '20.00', version: 2 });
      const opening = await insertTransaction(
        em,
        processedBetFor(wallet, {
          providerId: 'wallet-opening',
          kind: 'OPENING',
          amount: '100.00',
          balanceAfter: '100.00',
        }),
      );
      const bet = await insertTransaction(em, processedBetFor(wallet, { amount: '80.00', balanceAfter: '20.00' }));
      await insertLedgerEntry(em, {
        walletId: wallet.id,
        transactionId: opening.id,
        direction: 'CREDIT',
        amount: '100.00',
        balanceBefore: '0.00',
        balanceAfter: '100.00',
      });
      await insertLedgerEntry(em, {
        walletId: wallet.id,
        transactionId: bet.id,
        amount: '80.00',
        balanceBefore: '100.00',
        balanceAfter: '20.00',
      });
      return { wallet, bet };
    });
  }

  async function constraintExists(name: string): Promise<boolean> {
    const rows = await orm.em
      .fork()
      .execute<{ total: number }[]>('select count(*)::int as total from pg_constraint where conname = ?', [name]);
    return present(rows[0], 'constraint count').total === 1;
  }

  it('accepts the baseline rows built by the helpers, and the wallet is consistent with its ledger', async () => {
    const { wallet } = await seedWalletWithBet();

    await assertWalletConsistent(orm, wallet.id);
  });

  describe('wallets', () => {
    it('rejects a duplicated primary key', async () => {
      const id = Bun.randomUUIDv7();

      await expectDbError(
        commit(async (em) => {
          await insertWallet(em, { id });
          await insertWallet(em, { id });
        }),
        { code: '23505', constraint: 'wallets_pkey' },
      );
    });

    it('rejects a negative balance, on insert and on update', async () => {
      await expectDbError(
        commit((em) => insertWallet(em, { balance: '-0.01' })),
        { code: '23514', constraint: 'wallets_balance_non_negative' },
      );

      const { wallet } = await seedWalletWithBet();
      await expectDbError(
        run('update wallets set balance = balance - ? where id = ?', ['20.01', wallet.id]),
        { code: '23514', constraint: 'wallets_balance_non_negative' },
      );
    });

    it('rejects a version below 1', async () => {
      await expectDbError(
        commit((em) => insertWallet(em, { version: 0 })),
        { code: '23514', constraint: 'wallets_version_positive' },
      );
    });

    it('rejects a currency that is not three uppercase letters', async () => {
      await expectDbError(
        commit((em) => insertWallet(em, { currency: 'brl' })),
        { code: '23514', constraint: 'wallets_currency_iso' },
      );
    });

    it('rejects a second wallet for the same player and currency, but accepts another currency', async () => {
      const playerId = `player-${Bun.randomUUIDv7()}`;

      await expectDbError(
        commit(async (em) => {
          await insertWallet(em, { playerId });
          await insertWallet(em, { playerId });
        }),
        { code: '23505', constraint: 'wallets_player_currency_uq' },
      );

      await commit(async (em) => {
        await insertWallet(em, { playerId, currency: 'BRL' });
        await insertWallet(em, { playerId, currency: 'USD' });
      });
    });

    // wallets_id_currency_uq (id, currency) não é violável sem violar antes wallets_pkey (id): o teste de
    // catálogo abaixo garante que ela existe.
  });

  describe('wager_transactions', () => {
    it('rejects a duplicated primary key', async () => {
      const id = Bun.randomUUIDv7();

      await expectDbError(
        commit(async (em) => {
          await insertTransaction(em, { id, idempotencyKey: 'idem-a', externalTransactionId: 'ext-a' });
          await insertTransaction(em, { id, idempotencyKey: 'idem-b', externalTransactionId: 'ext-b' });
        }),
        { code: '23505', constraint: 'wager_transactions_pkey' },
      );
    });

    it('rejects the same external transaction id for the same provider, but accepts it for another provider', async () => {
      const providerId = newProviderId();

      await expectDbError(
        commit(async (em) => {
          await insertTransaction(em, { providerId, externalTransactionId: 'ext-1' });
          await insertTransaction(em, { providerId, externalTransactionId: 'ext-1' });
        }),
        { code: '23505', constraint: 'wager_transactions_provider_external_uq' },
      );

      await commit(async (em) => {
        await insertTransaction(em, { providerId: newProviderId(), externalTransactionId: 'ext-1' });
        await insertTransaction(em, { providerId: newProviderId(), externalTransactionId: 'ext-1' });
      });
    });

    it('rejects the same idempotency key for the same provider, but accepts it for another provider', async () => {
      const providerId = newProviderId();

      await expectDbError(
        commit(async (em) => {
          await insertTransaction(em, { providerId, idempotencyKey: 'idem-1' });
          await insertTransaction(em, { providerId, idempotencyKey: 'idem-1' });
        }),
        { code: '23505', constraint: 'wager_transactions_provider_idempotency_uq' },
      );

      await commit(async (em) => {
        await insertTransaction(em, { providerId: newProviderId(), idempotencyKey: 'idem-1' });
        await insertTransaction(em, { providerId: newProviderId(), idempotencyKey: 'idem-1' });
      });
    });

    it('rejects an unknown kind', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { kind: 'JACKPOT' })),
        { code: '23514', constraint: 'wager_transactions_kind_valid' },
      );
    });

    it('rejects an unknown status', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { status: 'DONE' })),
        { code: '23514', constraint: 'wager_transactions_status_valid' },
      );
    });

    it('rejects an OPENING transaction that is not PROCESSED', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { kind: 'OPENING', status: 'PENDING' })),
        { code: '23514', constraint: 'wager_transactions_opening_processed' },
      );
    });

    it('rejects a currency that is not three uppercase letters', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { currency: 'brl' })),
        { code: '23514', constraint: 'wager_transactions_currency_iso' },
      );
    });

    it('rejects a zero amount, except for LOSS', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { kind: 'BET', amount: '0.00' })),
        { code: '23514', constraint: 'wager_transactions_amount_valid' },
      );

      await commit((em) => insertTransaction(em, { kind: 'LOSS', amount: '0.00' }));
    });

    it('rejects a negative balance_after', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { balanceAfter: '-0.01' })),
        { code: '23514', constraint: 'wager_transactions_balance_after_non_negative' },
      );
    });

    it('rejects a REFUND without a reference', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { kind: 'REFUND', referenceExternalTransactionId: null })),
        { code: '23514', constraint: 'wager_transactions_reversal_requires_reference' },
      );
    });

    it('rejects PENDING_REFERENCE without a reference', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { status: 'PENDING_REFERENCE', referenceExternalTransactionId: null })),
        { code: '23514', constraint: 'wager_transactions_pending_reference_has_reference' },
      );
    });

    it('rejects PROCESSED without processed_at or without balance_after', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { status: 'PROCESSED', balanceAfter: '20.00', processedAt: null })),
        { code: '23514', constraint: 'wager_transactions_processed_complete' },
      );
      await expectDbError(
        commit((em) => insertTransaction(em, { status: 'PROCESSED', balanceAfter: null, processedAt: NOW })),
        { code: '23514', constraint: 'wager_transactions_processed_complete' },
      );
    });

    it('rejects a PROCESSED reversal whose reference was not resolved', async () => {
      await expectDbError(
        commit((em) =>
          insertTransaction(em, {
            kind: 'REFUND',
            status: 'PROCESSED',
            balanceAfter: '20.00',
            processedAt: NOW,
            referenceExternalTransactionId: 'ext-bet',
            referenceTransactionId: null,
          }),
        ),
        { code: '23514', constraint: 'wager_transactions_processed_reversal_resolved' },
      );
    });

    it('requires failure_code exactly on REJECTED and FAILED', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { status: 'REJECTED', failureCode: null })),
        { code: '23514', constraint: 'wager_transactions_failure_code_by_status' },
      );
      await expectDbError(
        commit((em) => insertTransaction(em, { status: 'PENDING', failureCode: 'INSUFFICIENT_FUNDS' })),
        { code: '23514', constraint: 'wager_transactions_failure_code_by_status' },
      );
    });

    it('accepts only PERMANENT_FAILURE as the failure_code of FAILED', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { status: 'FAILED', failureCode: 'INSUFFICIENT_FUNDS' })),
        { code: '23514', constraint: 'wager_transactions_failed_permanent' },
      );

      await commit((em) => insertTransaction(em, { status: 'FAILED', failureCode: 'PERMANENT_FAILURE' }));
    });

    it('rejects a transaction that references itself', async () => {
      const id = Bun.randomUUIDv7();

      await expectDbError(
        commit((em) => insertTransaction(em, { id, referenceTransactionId: id })),
        { code: '23514', constraint: 'wager_transactions_reference_not_self' },
      );
    });

    it('rejects a reference to a transaction that does not exist, when the transaction commits', async () => {
      await expectDbError(
        commit((em) => insertTransaction(em, { referenceTransactionId: Bun.randomUUIDv7() })),
        { code: '23503', constraint: 'wager_transactions_reference_fk' },
      );
    });

    describe('single reversal per reference', () => {
      function reversalOf(
        wallet: WalletRow,
        bet: TransactionRow,
        kind: 'REFUND' | 'ROLLBACK',
        overrides: Partial<TransactionRow> = {},
      ): Partial<TransactionRow> {
        return processedBetFor(wallet, {
          kind,
          amount: bet.amount,
          referenceExternalTransactionId: bet.externalTransactionId,
          referenceTransactionId: bet.id,
          providerId: bet.providerId,
          ...overrides,
        });
      }

      it('rejects two PROCESSED REFUNDs of the same BET', async () => {
        const { wallet, bet } = await seedWalletWithBet();

        await expectDbError(
          commit(async (em) => {
            await insertTransaction(em, reversalOf(wallet, bet, 'REFUND'));
            await insertTransaction(em, reversalOf(wallet, bet, 'REFUND'));
          }),
          { code: '23505', constraint: 'wager_transactions_single_reversal_uq' },
        );
      });

      it('rejects a REFUND and a ROLLBACK of the same BET', async () => {
        const { wallet, bet } = await seedWalletWithBet();

        await expectDbError(
          commit(async (em) => {
            await insertTransaction(em, reversalOf(wallet, bet, 'REFUND'));
            await insertTransaction(em, reversalOf(wallet, bet, 'ROLLBACK'));
          }),
          { code: '23505', constraint: 'wager_transactions_single_reversal_uq' },
        );
      });

      it('accepts a REJECTED REFUND next to the PROCESSED one', async () => {
        const { wallet, bet } = await seedWalletWithBet();

        await commit(async (em) => {
          await insertTransaction(em, reversalOf(wallet, bet, 'REFUND'));
          await insertTransaction(
            em,
            reversalOf(wallet, bet, 'REFUND', {
              status: 'REJECTED',
              failureCode: 'ALREADY_REVERSED',
              balanceAfter: null,
              processedAt: null,
            }),
          );
        });
      });
    });

    describe('trigger wager_transactions_guard', () => {
      it('rejects changing a PROCESSED transaction', async () => {
        const { bet } = await seedWalletWithBet();

        await expectDbError(
          run("update wager_transactions set status = 'PENDING' where id = ?", [bet.id]),
          { code: '23001', message: 'is terminal' },
        );
      });

      it('rejects changing an immutable column of a PENDING transaction', async () => {
        const pending = await commit((em) => insertTransaction(em));

        await expectDbError(
          run("update wager_transactions set amount = '99.00' where id = ?", [pending.id]),
          { code: '23001', message: 'immutable column changed' },
        );
      });

      it('accepts moving a PENDING transaction to PROCESSED', async () => {
        const pending = await commit((em) => insertTransaction(em));

        await run(
          "update wager_transactions set status = 'PROCESSED', balance_after = ?, processed_at = ? where id = ?",
          ['20.00', NOW, pending.id],
        );
      });

      it('rejects deleting a transaction', async () => {
        const pending = await commit((em) => insertTransaction(em));

        await expectDbError(run('delete from wager_transactions where id = ?', [pending.id]), {
          code: '23001',
          message: 'never deleted',
        });
      });

      it('blocks TRUNCATE through the ledger FK, and through the trigger once the FK is out of the way', async () => {
        await seedWalletWithBet();

        await expectDbError(run('truncate wager_transactions'), { code: '0A000' });

        await withRollback(orm, async (em) => {
          await em.execute('alter table wallet_ledger_entries drop constraint wallet_ledger_entries_transaction_fk');
          await expectDbError(em.execute('truncate wager_transactions'), {
            code: '23001',
            message: 'never deleted',
          });
        });
        expect(await constraintExists('wallet_ledger_entries_transaction_fk')).toBe(true);
      });
    });
  });

  describe('wallet_ledger_entries', () => {
    /** Wallet BRL de 100.00 e uma `BET` `PROCESSED` dela, para o lançamento ter a quem se ligar. */
    async function insertLedgerContext(em: EntityManager): Promise<{ wallet: WalletRow; transaction: TransactionRow }> {
      const wallet = await insertWallet(em, { balance: '100.00' });
      const transaction = await insertTransaction(em, processedBetFor(wallet));
      return { wallet, transaction };
    }

    it('rejects a duplicated primary key', async () => {
      const id = Bun.randomUUIDv7();

      await expectDbError(
        commit(async (em) => {
          const { wallet, transaction } = await insertLedgerContext(em);
          const other = await insertTransaction(em, processedBetFor(wallet));
          await insertLedgerEntry(em, { id, walletId: wallet.id, transactionId: transaction.id });
          await insertLedgerEntry(em, { id, walletId: wallet.id, transactionId: other.id });
        }),
        { code: '23505', constraint: 'wallet_ledger_entries_pkey' },
      );
    });

    it('rejects a second entry for the same transaction and wallet (duplicated debit)', async () => {
      await expectDbError(
        commit(async (em) => {
          const { wallet, transaction } = await insertLedgerContext(em);
          await insertLedgerEntry(em, { walletId: wallet.id, transactionId: transaction.id });
          await insertLedgerEntry(em, { walletId: wallet.id, transactionId: transaction.id });
        }),
        { code: '23505', constraint: 'wallet_ledger_entries_transaction_wallet_uq' },
      );
    });

    // wallet_ledger_entries_wallet_seq_uq (wallet_id, seq) não é violável: `seq` é `generated always as identity`
    // e o Postgres recusa qualquer valor explícito antes de a UNIQUE entrar em jogo.
    it('refuses an explicit seq, which keeps (wallet_id, seq) unique', async () => {
      await expectDbError(
        commit(async (em) => {
          const { wallet, transaction } = await insertLedgerContext(em);
          await em.execute(
            `insert into wallet_ledger_entries
               (id, seq, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             values (?, 1, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '90.00', ?)`,
            [Bun.randomUUIDv7(), wallet.id, transaction.id, NOW],
          );
        }),
        { code: '428C9' },
      );
    });

    // Um direction fora de DEBIT/CREDIT também falha a `balanced`, que o Postgres confere antes (ordem de nome).
    // Para provar a `direction_valid` sozinha, a `balanced` sai de cena numa transação revertida.
    it('rejects an unknown direction', async () => {
      await expectDbError(
        commit(async (em) => {
          const { wallet, transaction } = await insertLedgerContext(em);
          await insertLedgerEntry(em, { walletId: wallet.id, transactionId: transaction.id, direction: 'REFUND' });
        }),
        { code: '23514', constraint: 'wallet_ledger_entries_balanced' },
      );

      await withRollback(orm, async (em) => {
        await em.execute('alter table wallet_ledger_entries drop constraint wallet_ledger_entries_balanced');
        const { wallet, transaction } = await insertLedgerContext(em);
        await expectDbError(
          insertLedgerEntry(em, { walletId: wallet.id, transactionId: transaction.id, direction: 'REFUND' }),
          { code: '23514', constraint: 'wallet_ledger_entries_direction_valid' },
        );
      });
      expect(await constraintExists('wallet_ledger_entries_balanced')).toBe(true);
    });

    it('rejects a zero amount', async () => {
      await expectDbError(
        commit(async (em) => {
          const { wallet, transaction } = await insertLedgerContext(em);
          await insertLedgerEntry(em, {
            walletId: wallet.id,
            transactionId: transaction.id,
            amount: '0.00',
            balanceBefore: '100.00',
            balanceAfter: '100.00',
          });
        }),
        { code: '23514', constraint: 'wallet_ledger_entries_amount_positive' },
      );
    });

    it('rejects a balance that goes negative, even when the arithmetic is right', async () => {
      await expectDbError(
        commit(async (em) => {
          const { wallet, transaction } = await insertLedgerContext(em);
          await insertLedgerEntry(em, {
            walletId: wallet.id,
            transactionId: transaction.id,
            amount: '30.00',
            balanceBefore: '20.00',
            balanceAfter: '-10.00',
          });
        }),
        { code: '23514', constraint: 'wallet_ledger_entries_balances_non_negative' },
      );
    });

    it('rejects an unbalanced entry, debit or credit', async () => {
      await expectDbError(
        commit(async (em) => {
          const { wallet, transaction } = await insertLedgerContext(em);
          await insertLedgerEntry(em, {
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: 'DEBIT',
            amount: '10.00',
            balanceBefore: '100.00',
            balanceAfter: '95.00',
          });
        }),
        { code: '23514', constraint: 'wallet_ledger_entries_balanced' },
      );

      await expectDbError(
        commit(async (em) => {
          const { wallet, transaction } = await insertLedgerContext(em);
          await insertLedgerEntry(em, {
            walletId: wallet.id,
            transactionId: transaction.id,
            direction: 'CREDIT',
            amount: '10.00',
            balanceBefore: '100.00',
            balanceAfter: '95.00',
          });
        }),
        { code: '23514', constraint: 'wallet_ledger_entries_balanced' },
      );
    });

    it('rejects an entry whose currency differs from the wallet currency, when the transaction commits', async () => {
      await expectDbError(
        commit(async (em) => {
          const wallet = await insertWallet(em, { currency: 'BRL', balance: '100.00' });
          const usdTransaction = await insertTransaction(em, processedBetFor(wallet, { currency: 'USD' }));
          await insertLedgerEntry(em, { walletId: wallet.id, transactionId: usdTransaction.id, currency: 'USD' });
        }),
        { code: '23503', constraint: 'wallet_ledger_entries_wallet_fk' },
      );
    });

    it('rejects an entry whose transaction does not exist or belongs to another wallet, when the transaction commits', async () => {
      await expectDbError(
        commit(async (em) => {
          const wallet = await insertWallet(em, { balance: '100.00' });
          await insertLedgerEntry(em, { walletId: wallet.id, transactionId: Bun.randomUUIDv7() });
        }),
        { code: '23503', constraint: 'wallet_ledger_entries_transaction_fk' },
      );

      await expectDbError(
        commit(async (em) => {
          const wallet = await insertWallet(em, { balance: '100.00' });
          const otherWalletTransaction = await insertTransaction(em, { status: 'PROCESSED', balanceAfter: '90.00', processedAt: NOW });
          await insertLedgerEntry(em, { walletId: wallet.id, transactionId: otherWalletTransaction.id });
        }),
        { code: '23503', constraint: 'wallet_ledger_entries_transaction_fk' },
      );
    });

    // Constraint trigger deferred: o status da transação é conferido no COMMIT, não no INSERT do lançamento.
    describe('trigger wallet_ledger_entries_transaction_processed', () => {
      const expected = { code: '23514', constraint: 'wallet_ledger_entries_transaction_processed' };

      it('rejects an entry for a REJECTED transaction, when the transaction commits', async () => {
        await expectDbError(
          commit(async (em) => {
            const wallet = await insertWallet(em, { balance: '100.00' });
            const rejected = await insertTransaction(em, {
              walletId: wallet.id,
              playerId: wallet.playerId,
              status: 'REJECTED',
              failureCode: 'INSUFFICIENT_FUNDS',
            });
            await insertLedgerEntry(em, { walletId: wallet.id, transactionId: rejected.id });
          }),
          expected,
        );
      });

      it('rejects an entry for a transaction that is still PENDING at commit', async () => {
        await expectDbError(
          commit(async (em) => {
            const wallet = await insertWallet(em, { balance: '100.00' });
            const pending = await insertTransaction(em, { walletId: wallet.id, playerId: wallet.playerId });
            await insertLedgerEntry(em, { walletId: wallet.id, transactionId: pending.id });
          }),
          expected,
        );
      });

      it('rejects an entry for a PROCESSED LOSS', async () => {
        await expectDbError(
          commit(async (em) => {
            const wallet = await insertWallet(em, { balance: '100.00' });
            const loss = await insertTransaction(em, processedBetFor(wallet, { kind: 'LOSS' }));
            await insertLedgerEntry(em, { walletId: wallet.id, transactionId: loss.id });
          }),
          expected,
        );
      });

      it('accepts an entry inserted while the transaction is PENDING, once it becomes PROCESSED before commit', async () => {
        const entry = await commit(async (em) => {
          const wallet = await insertWallet(em, { balance: '90.00', version: 2 });
          const pending = await insertTransaction(em, { walletId: wallet.id, playerId: wallet.playerId });
          const inserted = await insertLedgerEntry(em, { walletId: wallet.id, transactionId: pending.id });
          await em.execute(
            "update wager_transactions set status = 'PROCESSED', balance_after = '90.00', processed_at = ? where id = ?",
            [NOW, pending.id],
          );
          return inserted;
        });

        const rows = await run('select id from wallet_ledger_entries where id = ?', [entry.id]);
        expect(rows).toHaveLength(1);
      });
    });

    describe('trigger wallet_ledger_entries_append_only', () => {
      it('rejects UPDATE', async () => {
        const { wallet } = await seedWalletWithBet();

        await expectDbError(run("update wallet_ledger_entries set amount = '1.00' where wallet_id = ?", [wallet.id]), {
          code: '23001',
          message: 'append-only',
        });
      });

      it('rejects DELETE', async () => {
        const { wallet } = await seedWalletWithBet();

        await expectDbError(run('delete from wallet_ledger_entries where wallet_id = ?', [wallet.id]), {
          code: '23001',
          message: 'append-only',
        });
      });

      it('rejects TRUNCATE', async () => {
        await seedWalletWithBet();

        await expectDbError(run('truncate wallet_ledger_entries'), { code: '23001', message: 'append-only' });
      });
    });
  });

  describe('inbox_messages', () => {
    it('rejects the same message for the same consumer, but accepts it for another consumer', async () => {
      const messageId = `message-${Bun.randomUUIDv7()}`;

      await expectDbError(
        commit(async (em) => {
          await insertInbox(em, { consumerName: 'wager-consumer', messageId });
          await insertInbox(em, { consumerName: 'wager-consumer', messageId });
        }),
        { code: '23505', constraint: 'inbox_messages_pkey' },
      );

      await commit(async (em) => {
        await insertInbox(em, { consumerName: 'wager-consumer', messageId });
        await insertInbox(em, { consumerName: 'another-consumer', messageId });
      });
    });
  });

  describe('outbox_messages', () => {
    it('rejects a duplicated primary key', async () => {
      const id = Bun.randomUUIDv7();

      await expectDbError(
        commit(async (em) => {
          await insertOutbox(em, { id });
          await insertOutbox(em, { id });
        }),
        { code: '23505', constraint: 'outbox_messages_pkey' },
      );
    });

    it('rejects a negative attempts counter', async () => {
      await expectDbError(
        commit((em) => insertOutbox(em, { attempts: -1 })),
        { code: '23514', constraint: 'outbox_messages_attempts_non_negative' },
      );
    });
  });

  describe('catalog', () => {
    it('has exactly the named tables, constraints, indexes, triggers and functions of the migration', async () => {
      const actual = await readSchemaObjects(orm.em.fork());

      expect(actual.tables).toEqual(EXPECTED_SCHEMA_OBJECTS.tables);
      expect(actual.constraints).toEqual(EXPECTED_SCHEMA_OBJECTS.constraints);
      expect(actual.indexes).toEqual(EXPECTED_SCHEMA_OBJECTS.indexes);
      expect(actual.triggers).toEqual(EXPECTED_SCHEMA_OBJECTS.triggers);
      expect(actual.functions).toEqual(EXPECTED_SCHEMA_OBJECTS.functions);
    });
  });
});
