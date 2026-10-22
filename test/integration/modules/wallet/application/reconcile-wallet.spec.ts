import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Registry } from 'prom-client';

import { defaultIdempotencyKey } from '../../../../../src/modules/wagering/application/payload-hash';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../../../src/modules/wagering/application/submit-wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
import {
  ReconcileWallet,
  type WalletReconciliation,
} from '../../../../../src/modules/wallet/application/reconcile-wallet';
import { Money } from '../../../../../src/shared/domain/money';
import { createTestApp } from '../../../../support/create-test-app';
import { newProviderId, openWalletWithBalance } from '../../../../support/fixtures';
import { createLogCapture, type LogLine } from '../../../../support/log-capture';
import { inFreshContext, present } from '../../../../support/orm-context';
import { assertWalletConsistent } from '../../../../support/wallet-consistency';

const DIVERGENCE_MESSAGE = 'wallet reconciliation divergence';
const WARN_LEVEL = 40;

interface Scenario {
  walletId: string;
  playerId: string;
  providerId: string;
}

interface WalletRow {
  balance: string;
  version: number;
  updated_at: string;
}

describe('ReconcileWallet (Postgres real)', () => {
  const capture = createLogCapture();
  let app: INestApplication;
  let orm: MikroORM;
  let reconcileWallet: ReconcileWallet;
  let submitWager: SubmitWagerTransaction;
  let registry: Registry;

  beforeAll(async () => {
    app = await createTestApp({ logDestination: capture.stream });
    orm = app.get(MikroORM);
    reconcileWallet = app.get(ReconcileWallet);
    submitWager = app.get(SubmitWagerTransaction);
    registry = app.get(Registry);
  });

  afterAll(async () => {
    await app?.close();
  });

  const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

  async function openScenario(amount: string): Promise<Scenario> {
    const { wallet } = await openWalletWithBalance(app, { amount });
    return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
  }

  /** Submete uma transação de `amount` do `kind` dado e confere que ela foi processada. */
  async function submit(scenario: Scenario, kind: WagerTransactionKind, amount: string): Promise<void> {
    const externalTransactionId = `ext-${Bun.randomUUIDv7()}`;
    const command: SubmitWagerTransactionCommand = {
      idempotencyKey: defaultIdempotencyKey(scenario.providerId, externalTransactionId),
      providerId: scenario.providerId,
      externalTransactionId,
      walletId: scenario.walletId,
      playerId: scenario.playerId,
      roundId: `round-${Bun.randomUUIDv7()}`,
      gameId: 'game-1',
      kind,
      money: brl(amount),
      correlationId: Bun.randomUUIDv7(),
    };
    const result = await submitWager.execute(command);
    expect(result.transaction.status).toBe(WagerTransactionStatus.Processed);
  }

  const placeBet = (scenario: Scenario, amount = '1.00') => submit(scenario, WagerTransactionKind.Bet, amount);
  const placeWin = (scenario: Scenario, amount: string) => submit(scenario, WagerTransactionKind.Win, amount);

  const reconcile = (walletId: string) => inFreshContext(orm, () => reconcileWallet.execute(walletId));

  async function reconciliationOf(walletId: string): Promise<WalletReconciliation> {
    return present(await reconcile(walletId), 'reconciliation');
  }

  /** Soma das amostras do contador de divergências na moeda BRL; 0 enquanto nenhuma amostra existe. */
  async function divergenceCount(): Promise<number> {
    const metric = present(
      registry.getSingleMetric('wallet_reconciliation_divergences_total'),
      'wallet_reconciliation_divergences_total',
    );
    return (await metric.get()).values
      .filter((sample) => sample.labels.currency === 'BRL')
      .reduce((sum, sample) => sum + sample.value, 0);
  }

  /** Linha da wallet por SQL; `updated_at` formatado no banco porque o `execute` cru não devolve `Date`. */
  async function walletRowBySql(walletId: string): Promise<WalletRow> {
    const rows = await orm.em.fork().execute<WalletRow[]>(
      `select balance::text as balance, version,
              to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at
         from wallets where id = ?`,
      [walletId],
    );
    return present(rows[0], 'wallet row');
  }

  async function ledgerCount(walletId: string): Promise<number> {
    const rows = await orm.em
      .fork()
      .execute<{ total: number }[]>('select count(*)::int as total from wallet_ledger_entries where wallet_id = ?', [
        walletId,
      ]);
    return present(rows[0], 'ledger count').total;
  }

  /** Mexe no saldo materializado por SQL, sem lançamento nem `version`: a divergência forçada dos testes. */
  async function shiftBalance(walletId: string, delta: string): Promise<void> {
    await orm.em.fork().execute('update wallets set balance = balance + ?::numeric where id = ?', [delta, walletId]);
  }

  const divergenceLogs = (walletId: string): LogLine[] =>
    capture.lines().filter((line) => line.msg === DIVERGENCE_MESSAGE && line.walletId === walletId);

  it('reports a consistent wallet: stored balance equals the ledger sum and nothing is signalled', async () => {
    const scenario = await openScenario('100.00');
    await placeBet(scenario, '30.00');
    await placeWin(scenario, '5.00');
    const divergencesBefore = await divergenceCount();

    const result = await reconciliationOf(scenario.walletId);

    expect(result.walletId).toBe(scenario.walletId);
    expect(result.storedBalance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(result.calculatedBalance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(result.difference.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(3);
    expect((await divergenceCount()) - divergencesBefore).toBe(0);
    expect(divergenceLogs(scenario.walletId)).toHaveLength(0);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('reports a wallet opened with 0.00 and no ledger rows as consistent', async () => {
    const scenario = await openScenario('0.00');

    const result = await reconciliationOf(scenario.walletId);

    expect(result.storedBalance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.calculatedBalance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.difference.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(0);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('flags a divergence forced by SQL, counts and logs it without values, and corrects nothing', async () => {
    const scenario = await openScenario('100.00');
    await placeBet(scenario, '20.00');
    await shiftBalance(scenario.walletId, '10.00');
    const rowBaseline = await walletRowBySql(scenario.walletId);
    const ledgerBaseline = await ledgerCount(scenario.walletId);
    const divergencesBefore = await divergenceCount();

    const result = await reconciliationOf(scenario.walletId);

    expect(result.storedBalance.toJSON()).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(result.calculatedBalance.toJSON()).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(result.difference.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(2);
    expect((await divergenceCount()) - divergencesBefore).toBe(1);

    const logs = divergenceLogs(scenario.walletId);
    expect(logs).toHaveLength(1);
    const line = present(logs[0], 'divergence log');
    expect(line.level).toBe(WARN_LEVEL);
    expect(line.currency).toBe('BRL');
    expect(line.checkedEntries).toBe(2);
    expect(line).not.toHaveProperty('storedBalance');
    expect(line).not.toHaveProperty('calculatedBalance');
    expect(line).not.toHaveProperty('difference');

    expect(await walletRowBySql(scenario.walletId)).toEqual(rowBaseline);
    expect(await ledgerCount(scenario.walletId)).toBe(ledgerBaseline);

    const again = await reconciliationOf(scenario.walletId);

    expect(again.consistent).toBe(false);
    expect(again.difference.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(again.storedBalance.toJSON()).toEqual({ amount: '90.00', currency: 'BRL' });
    expect((await divergenceCount()) - divergencesBefore).toBe(2);
    expect(await walletRowBySql(scenario.walletId)).toEqual(rowBaseline);

    await shiftBalance(scenario.walletId, '-10.00');
    expect((await reconciliationOf(scenario.walletId)).consistent).toBe(true);
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('reports a negative difference when the stored balance is below the ledger sum', async () => {
    const scenario = await openScenario('50.00');
    await shiftBalance(scenario.walletId, '-5.00');
    const divergencesBefore = await divergenceCount();

    const result = await reconciliationOf(scenario.walletId);

    expect(result.storedBalance.toJSON()).toEqual({ amount: '45.00', currency: 'BRL' });
    expect(result.calculatedBalance.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(result.difference.toJSON()).toEqual({ amount: '-5.00', currency: 'BRL' });
    expect(result.consistent).toBe(false);
    expect((await divergenceCount()) - divergencesBefore).toBe(1);

    await shiftBalance(scenario.walletId, '5.00');
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('returns null for an unknown wallet and does not touch the divergence counter', async () => {
    const divergencesBefore = await divergenceCount();

    expect(await reconcile(Bun.randomUUIDv7())).toBeNull();

    expect((await divergenceCount()) - divergencesBefore).toBe(0);
  });

  it('never reports a false divergence while bets commit on the same wallet', async () => {
    const scenario = await openScenario('1000.00');
    const divergencesBefore = await divergenceCount();

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        index % 2 === 0
          ? placeBet(scenario).then(() => null)
          : reconciliationOf(scenario.walletId),
      ),
    );

    const reconciliations = results.filter((result) => result !== null);
    expect(reconciliations).toHaveLength(20);
    expect(reconciliations.every((result) => result.consistent)).toBe(true);
    expect((await divergenceCount()) - divergencesBefore).toBe(0);
    expect(divergenceLogs(scenario.walletId)).toHaveLength(0);

    const final = await reconciliationOf(scenario.walletId);
    expect(final.storedBalance.toJSON()).toEqual({ amount: '980.00', currency: 'BRL' });
    expect(final.consistent).toBe(true);
    expect(final.checkedEntries).toBe(21);
    await assertWalletConsistent(orm, scenario.walletId);
  });
});
