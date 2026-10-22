import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { defaultIdempotencyKey } from '../../../../../src/modules/wagering/application/payload-hash';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../../../src/modules/wagering/application/submit-wager-transaction';
import { WagerTransactionKind } from '../../../../../src/modules/wagering/domain/wager-transaction';
import {
  LEDGER_PAGE_DEFAULT_LIMIT,
  LEDGER_PAGE_MAX_LIMIT,
  WalletQueries,
  type LedgerPageResult,
} from '../../../../../src/modules/wallet/application/wallet-queries';
import { LedgerDirection } from '../../../../../src/modules/wallet/domain/wallet-ledger-entry';
import { InvalidQueryError } from '../../../../../src/shared/application/invalid-query-error';
import { FailureCode } from '../../../../../src/shared/domain/failure-code';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { newProviderId, openWalletWithBalance } from '../../../../support/fixtures';
import { inFreshContext, present } from '../../../../support/orm-context';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

interface Scenario {
  walletId: string;
  playerId: string;
  providerId: string;
}

describe('WalletQueries (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let queries: WalletQueries;
  let submitWager: SubmitWagerTransaction;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    queries = app.get(WalletQueries);
    submitWager = app.get(SubmitWagerTransaction);
  });

  afterAll(async () => {
    await app?.close();
  });

  const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

  async function openScenario(amount: string): Promise<Scenario> {
    const { wallet } = await openWalletWithBalance(app, { amount });
    return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
  }

  /** Aposta de `amount`; devolve o id da transação criada. */
  async function placeBet(scenario: Scenario, amount = '1.00'): Promise<string> {
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
    const command: SubmitWagerTransactionCommand = {
      idempotencyKey: defaultIdempotencyKey(scenario.providerId, externalTransactionId),
      providerId: scenario.providerId,
      externalTransactionId,
      walletId: scenario.walletId,
      playerId: scenario.playerId,
      roundId: `round-${Bun.randomUUIDv7()}`,
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl(amount),
      correlationId: Bun.randomUUIDv7(),
    };
    const result = await submitWager.execute(command);
    return result.transaction.id;
  }

  /** Ids do ledger da wallet por SQL, do mais recente para o mais antigo: a verdade contra a qual a paginação é conferida. */
  async function ledgerIdsBySql(walletId: string): Promise<string[]> {
    const rows = await orm.em
      .fork()
      .execute<{ id: string }[]>('select id from wallet_ledger_entries where wallet_id = ? order by seq desc', [
        walletId,
      ]);
    return rows.map((row) => row.id);
  }

  async function ledgerIdOf(transactionId: string): Promise<string> {
    const rows = await orm.em
      .fork()
      .execute<{ id: string }[]>('select id from wallet_ledger_entries where transaction_id = ?', [transactionId]);
    return present(rows[0], 'ledger entry').id;
  }

  const listLedger = (walletId: string, options: { cursor?: string; limit?: number } = {}) =>
    inFreshContext(orm, () => queries.listLedger({ walletId, ...options }));

  /** Percorre todas as páginas; `afterPage` roda depois de cada página lida (1, 2, ...). */
  async function walkLedger(
    walletId: string,
    limit: number,
    afterPage: (pageNumber: number) => Promise<void> = async () => {},
  ): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const result: LedgerPageResult = present(
        await listLedger(walletId, cursor === null ? { limit } : { limit, cursor }),
        'ledger page',
      );
      pages.push(result.entries.map((entry) => entry.id));
      cursor = result.nextCursor;
      await afterPage(pages.length);
    } while (cursor !== null);
    return pages;
  }

  async function rejection(promise: Promise<unknown>): Promise<InvalidQueryError> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidQueryError);
    return caught as InvalidQueryError;
  }

  describe('getWallet', () => {
    it('returns the persisted wallet with balance, currency and version', async () => {
      const scenario = await openScenario('100.00');

      const wallet = present(await inFreshContext(orm, () => queries.getWallet(scenario.walletId)), 'wallet');

      expect(wallet.id).toBe(scenario.walletId);
      expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(wallet.currency).toBe('BRL');
      expect(wallet.version).toBe(1);
    });

    it('returns null for an unknown wallet', async () => {
      expect(await inFreshContext(orm, () => queries.getWallet(Bun.randomUUIDv7()))).toBeNull();
    });
  });

  describe('listLedger', () => {
    it('pages one wallet newest first, never leaking entries of other wallets interleaved in seq', async () => {
      const scenario = await openScenario('100.00');
      const other = await openScenario('100.00');
      await placeBet(scenario);
      await placeBet(other);
      await placeBet(scenario);
      await placeBet(other);
      await placeBet(scenario);
      const latestBetId = await placeBet(scenario);
      const latestEntryId = await ledgerIdOf(latestBetId);

      const pages = await walkLedger(scenario.walletId, 2);

      expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
      expect(present(pages[0], 'first page')[0]).toBe(latestEntryId);
      expect(pages.flat()).toEqual(await ledgerIdsBySql(scenario.walletId));
      const otherIds = new Set(await ledgerIdsBySql(other.walletId));
      expect(pages.flat().some((id) => otherIds.has(id))).toBe(false);
      const exactFit = await listLedger(scenario.walletId, { limit: 5 });
      expect(present(exactFit, 'page').nextCursor).toBeNull();
      await assertWalletConsistent(orm, scenario.walletId);
      await assertWalletConsistent(orm, other.walletId);
    });

    it('returns null for an unknown wallet', async () => {
      expect(await listLedger(Bun.randomUUIDv7())).toBeNull();
    });

    it('returns an empty page for a wallet opened with 0.00', async () => {
      const scenario = await openScenario('0.00');

      expect(await listLedger(scenario.walletId)).toEqual({ entries: [], nextCursor: null });
    });

    it('returns the entries as ledger entries with their persisted money', async () => {
      const scenario = await openScenario('100.00');
      await placeBet(scenario, '25.50');

      const page = present(await listLedger(scenario.walletId), 'page');

      const [newest, opening] = page.entries;
      expect(present(newest, 'newest').direction).toBe(LedgerDirection.Debit);
      expect(present(newest, 'newest').money.toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
      expect(present(newest, 'newest').balanceAfter.toJSON()).toEqual({ amount: '74.50', currency: 'BRL' });
      expect(present(opening, 'opening').direction).toBe(LedgerDirection.Credit);
      expect(present(opening, 'opening').balanceAfter.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
      await assertWalletConsistent(orm, scenario.walletId);
    });
  });

  describe('stable pagination while new entries arrive', () => {
    it('yields exactly the entries that existed when the walk started, even as BETs are appended between pages', async () => {
      const scenario = await openScenario('100.00');
      const other = await openScenario('100.00');
      for (let index = 0; index < 5; index += 1) {
        await placeBet(scenario);
      }
      const snapshot = await ledgerIdsBySql(scenario.walletId);
      const createdTransactionIds: string[] = [];

      const pages = await walkLedger(scenario.walletId, 2, async () => {
        createdTransactionIds.push(await placeBet(scenario));
        await placeBet(other);
      });

      const walked = pages.flat();
      expect(walked).toEqual(snapshot);
      expect(new Set(walked).size).toBe(walked.length);
      const createdEntryIds = await Promise.all(createdTransactionIds.map(ledgerIdOf));
      expect(createdEntryIds).toHaveLength(pages.length);
      expect(walked.some((id) => createdEntryIds.includes(id))).toBe(false);

      const restarted = (await walkLedger(scenario.walletId, 2)).flat();
      expect(restarted).toEqual([...createdEntryIds].reverse().concat(snapshot));
      expect(restarted).toEqual(await ledgerIdsBySql(scenario.walletId));
      await assertWalletConsistent(orm, scenario.walletId);
      await assertWalletConsistent(orm, other.walletId);
    });

    it('never skips or repeats entries when BETs are submitted in parallel with the walk', async () => {
      const scenario = await openScenario('100.00');
      for (let index = 0; index < 5; index += 1) {
        await placeBet(scenario);
      }

      const [pages] = await Promise.all([
        walkLedger(scenario.walletId, 3),
        Promise.all(Array.from({ length: 10 }, () => placeBet(scenario))),
      ]);

      const walked = pages.flat();
      const all = await ledgerIdsBySql(scenario.walletId);
      expect(all).toHaveLength(16);
      expect(new Set(walked).size).toBe(walked.length);
      expect(walked).toEqual(all.slice(all.length - walked.length));
      expect(walked.at(-1)).toBe(all.at(-1));
      await assertWalletConsistent(orm, scenario.walletId);
    });
  });

  describe('invalid cursor', () => {
    it('rejects a garbage cursor as INVALID_PAYLOAD', async () => {
      const scenario = await openScenario('100.00');

      const error = await rejection(listLedger(scenario.walletId, { cursor: 'not-a-cursor!' }));

      expect(error.code).toBe(FailureCode.InvalidPayload);
      expect(error.field).toBe('cursor');
    });

    it('rejects a well-formed cursor that belongs to another wallet', async () => {
      const walletA = await openScenario('100.00');
      const walletB = await openScenario('100.00');
      await placeBet(walletA);
      const first = present(await listLedger(walletA.walletId, { limit: 1 }), 'page');
      const cursorOfA = present(first.nextCursor, 'cursor');

      const error = await rejection(listLedger(walletB.walletId, { cursor: cursorOfA }));

      expect(error.code).toBe(FailureCode.InvalidPayload);
      expect(error.field).toBe('cursor');
      await assertWalletConsistent(orm, walletA.walletId);
    });

    it('validates the cursor before looking the wallet up', async () => {
      await rejection(listLedger(Bun.randomUUIDv7(), { cursor: 'garbage' }));
    });
  });

  describe('limit', () => {
    it('defaults to 50 and returns a cursor for the rest', async () => {
      const scenario = await openScenario('100.00');
      for (let index = 0; index < 54; index += 1) {
        await placeBet(scenario);
      }
      expect(LEDGER_PAGE_DEFAULT_LIMIT).toBe(50);

      const first = present(await listLedger(scenario.walletId), 'page');
      expect(first.entries).toHaveLength(50);
      const second = present(
        await listLedger(scenario.walletId, { cursor: present(first.nextCursor, 'cursor') }),
        'page',
      );
      expect(second.entries).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      expect([...first.entries, ...second.entries].map((entry) => entry.id)).toEqual(
        await ledgerIdsBySql(scenario.walletId),
      );

      const max = present(await listLedger(scenario.walletId, { limit: LEDGER_PAGE_MAX_LIMIT }), 'page');
      expect(LEDGER_PAGE_MAX_LIMIT).toBe(100);
      expect(max.entries).toHaveLength(55);
      expect(max.nextCursor).toBeNull();
      await assertWalletConsistent(orm, scenario.walletId);
    });

    for (const limit of [0, -1, 1.5, 101, Number.NaN]) {
      it(`rejects limit ${String(limit)} as INVALID_PAYLOAD`, async () => {
        const scenario = await openScenario('100.00');

        const error = await rejection(listLedger(scenario.walletId, { limit }));

        expect(error.code).toBe(FailureCode.InvalidPayload);
        expect(error.field).toBe('limit');
      });
    }

    it('accepts limit 1', async () => {
      const scenario = await openScenario('100.00');
      await placeBet(scenario);

      const page = present(await listLedger(scenario.walletId, { limit: 1 }), 'page');

      expect(page.entries).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      await assertWalletConsistent(orm, scenario.walletId);
    });
  });
});
