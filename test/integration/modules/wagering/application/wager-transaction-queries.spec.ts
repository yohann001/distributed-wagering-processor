import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { defaultIdempotencyKey } from '../../../../../src/modules/wagering/application/payload-hash';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../../../src/modules/wagering/application/submit-wager-transaction';
import { WagerTransactionQueries } from '../../../../../src/modules/wagering/application/wager-transaction-queries';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../../../src/modules/wagering/domain/wager-transaction';
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

describe('WagerTransactionQueries (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let queries: WagerTransactionQueries;
  let submitWager: SubmitWagerTransaction;

  beforeAll(async () => {
    app = await createTestApp();
    orm = app.get(MikroORM);
    queries = app.get(WagerTransactionQueries);
    submitWager = app.get(SubmitWagerTransaction);
  });

  afterAll(async () => {
    await app?.close();
  });

  const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
  const money = (amount: string) => ({ amount, currency: 'BRL' });

  async function openScenario(amount: string): Promise<Scenario> {
    const { wallet } = await openWalletWithBalance(app, { amount });
    return { walletId: wallet.id, playerId: wallet.playerId, providerId: newProviderId() };
  }

  function command(
    scenario: Scenario,
    overrides: Partial<SubmitWagerTransactionCommand> & Pick<SubmitWagerTransactionCommand, 'kind'>,
  ): SubmitWagerTransactionCommand {
    const externalTransactionId = overrides.externalTransactionId ?? `ext-${Bun.randomUUIDv7()}`;
    return {
      idempotencyKey: defaultIdempotencyKey(scenario.providerId, externalTransactionId),
      providerId: scenario.providerId,
      externalTransactionId,
      walletId: scenario.walletId,
      playerId: scenario.playerId,
      roundId: `round-${Bun.randomUUIDv7()}`,
      gameId: 'game-1',
      money: brl('10.00'),
      correlationId: Bun.randomUUIDv7(),
      ...overrides,
    };
  }

  const bet = (scenario: Scenario, amount: string) =>
    command(scenario, { kind: WagerTransactionKind.Bet, money: brl(amount) });

  const byId = (id: string) => inFreshContext(orm, () => queries.getById(id));
  const byExternalId = (providerId: string, externalTransactionId: string) =>
    inFreshContext(orm, () => queries.getByExternalId(providerId, externalTransactionId));

  it('returns a PROCESSED BET by internal id and by (providerId, externalTransactionId)', async () => {
    const scenario = await openScenario('100.00');
    const placed = bet(scenario, '25.00');
    const { transaction } = await submitWager.execute(placed);

    const found = present(await byId(transaction.id), 'transaction by id');
    const foundByExternal = present(
      await byExternalId(scenario.providerId, placed.externalTransactionId),
      'transaction by external id',
    );

    for (const result of [found, foundByExternal]) {
      expect(result.id).toBe(transaction.id);
      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.kind).toBe(WagerTransactionKind.Bet);
      expect(result.walletId).toBe(scenario.walletId);
      expect(result.money.toJSON()).toEqual(money('25.00'));
      expect(result.balanceAfter?.toJSON()).toEqual(money('75.00'));
      expect(result.failureCode).toBeUndefined();
    }
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('returns a REJECTED BET with its failureCode and the balance observed at decision time', async () => {
    const scenario = await openScenario('100.00');
    const placed = bet(scenario, '150.00');
    const { transaction } = await submitWager.execute(placed);

    const found = present(await byExternalId(scenario.providerId, placed.externalTransactionId), 'transaction');

    expect(found.id).toBe(transaction.id);
    expect(found.status).toBe(WagerTransactionStatus.Rejected);
    expect(found.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(found.balanceAfter?.toJSON()).toEqual(money('100.00'));
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('returns a REFUND with the reference transaction resolved to the internal id', async () => {
    const scenario = await openScenario('100.00');
    const placed = bet(scenario, '25.00');
    const betResult = await submitWager.execute(placed);
    const refund = command(scenario, {
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      roundId: placed.roundId,
      referenceExternalTransactionId: placed.externalTransactionId,
    });
    const refundResult = await submitWager.execute(refund);

    const found = present(await byId(refundResult.transaction.id), 'refund');

    expect(found.status).toBe(WagerTransactionStatus.Processed);
    expect(found.referenceTransactionId).toBe(betResult.transaction.id);
    expect(found.referenceExternalTransactionId).toBe(placed.externalTransactionId);
    expect(found.balanceAfter?.toJSON()).toEqual(money('100.00'));
    await assertWalletConsistent(orm, scenario.walletId);
  });

  it('returns null for an unknown internal id', async () => {
    expect(await byId(Bun.randomUUIDv7())).toBeNull();
  });

  it('scopes the external id by provider: the same id under another provider is not found', async () => {
    const scenario = await openScenario('100.00');
    const placed = bet(scenario, '10.00');
    await submitWager.execute(placed);

    expect(await byExternalId(newProviderId(), placed.externalTransactionId)).toBeNull();
    expect(await byExternalId(scenario.providerId, `ext-${Bun.randomUUIDv7()}`)).toBeNull();
    expect(await byExternalId(scenario.providerId, placed.externalTransactionId)).not.toBeNull();
    await assertWalletConsistent(orm, scenario.walletId);
  });
});
