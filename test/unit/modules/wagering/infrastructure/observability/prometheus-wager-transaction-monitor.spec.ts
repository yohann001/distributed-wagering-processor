import { beforeEach, describe, expect, it } from 'bun:test';

import { Registry, register as globalRegistry } from 'prom-client';

import {
  DuplicateDetection,
  type SubmitWagerTransactionResult,
} from '../../../../../../src/modules/wagering/application/submit-wager-transaction';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../../../../src/modules/wagering/domain/wager-transaction';
import { PrometheusWagerTransactionMonitor } from '../../../../../../src/modules/wagering/infrastructure/observability/prometheus-wager-transaction-monitor';
import { FailureCode } from '../../../../../../src/shared/domain/failure-code';
import { Money } from '../../../../../../src/shared/domain/money';
import { sampleValue } from '../../../../../support/metrics';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-10-22T12:00:00.000Z');

function pending(kind: WagerTransactionKind): WagerTransaction {
  return WagerTransaction.create({
    id: `tx-${kind.toLowerCase()}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind.toLowerCase()}`,
    idempotencyKey: `provider-a:ext-${kind.toLowerCase()}`,
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('10.00'),
    ...(kind === WagerTransactionKind.Refund ? { referenceExternalTransactionId: 'ext-ref' } : {}),
    createdAt: AT,
  });
}

function processedBet(): WagerTransaction {
  const transaction = pending(WagerTransactionKind.Bet);
  transaction.markProcessed({ at: AT, balanceAfter: brl('90.00') });
  return transaction;
}

function rejectedBet(): WagerTransaction {
  const transaction = pending(WagerTransactionKind.Bet);
  transaction.reject(FailureCode.InsufficientFunds, brl('5.00'));
  return transaction;
}

function pendingRefund(): WagerTransaction {
  const transaction = pending(WagerTransactionKind.Refund);
  transaction.markPendingReference();
  return transaction;
}

function decided(transaction: WagerTransaction): SubmitWagerTransactionResult {
  return { transaction, idempotentReplay: false, duplicateDetectedBy: null };
}

function replayed(transaction: WagerTransaction, by: DuplicateDetection): SubmitWagerTransactionResult {
  return { transaction, idempotentReplay: true, duplicateDetectedBy: by };
}

describe('PrometheusWagerTransactionMonitor', () => {
  let registry: Registry;
  let monitor: PrometheusWagerTransactionMonitor;

  beforeEach(() => {
    registry = new Registry();
    monitor = new PrometheusWagerTransactionMonitor(registry);
  });

  /** Lê a amostra pelo texto de exposição: o mesmo caminho que o Prometheus enxerga em `GET /metrics`. */
  async function valueOf(metricName: string, labels: Record<string, string>): Promise<number> {
    return sampleValue(await registry.metrics(), metricName, labels);
  }

  const processingCount = (labels: Record<string, string>) =>
    valueOf('wager_transaction_processing_seconds_count', labels);

  it('counts a new decision by status, kind and channel and observes the latency with the lowercase status', async () => {
    monitor.submissionStarted('http').succeeded(decided(processedBet()));
    monitor.submissionStarted('sqs').succeeded(decided(rejectedBet()));
    monitor.submissionStarted('http').succeeded(decided(pendingRefund()));

    expect(await valueOf('wager_transactions_total', { status: 'PROCESSED', kind: 'BET', source: 'http' })).toBe(1);
    expect(await valueOf('wager_transactions_total', { status: 'REJECTED', kind: 'BET', source: 'sqs' })).toBe(1);
    expect(
      await valueOf('wager_transactions_total', { status: 'PENDING_REFERENCE', kind: 'REFUND', source: 'http' }),
    ).toBe(1);
    expect(await processingCount({ channel: 'http', outcome: 'processed' })).toBe(1);
    expect(await processingCount({ channel: 'sqs', outcome: 'rejected' })).toBe(1);
    expect(await processingCount({ channel: 'http', outcome: 'pending_reference' })).toBe(1);
    expect(await valueOf('wager_transaction_duplicates_total', {})).toBe(0);
  });

  it('counts a replay as a duplicate by detection mechanism, not as a decision', async () => {
    monitor.submissionStarted('sqs').succeeded(replayed(processedBet(), DuplicateDetection.Inbox));
    monitor.submissionStarted('sqs').succeeded(replayed(processedBet(), DuplicateDetection.IdempotencyKey));
    monitor.submissionStarted('http').succeeded(replayed(rejectedBet(), DuplicateDetection.IdempotencyKey));

    expect(await valueOf('wager_transaction_duplicates_total', { channel: 'sqs', detected_by: 'inbox' })).toBe(1);
    expect(
      await valueOf('wager_transaction_duplicates_total', { channel: 'sqs', detected_by: 'idempotency_key' }),
    ).toBe(1);
    expect(
      await valueOf('wager_transaction_duplicates_total', { channel: 'http', detected_by: 'idempotency_key' }),
    ).toBe(1);
    expect(await processingCount({ outcome: 'replayed' })).toBe(3);
    expect(await valueOf('wager_transactions_total', {})).toBe(0);
  });

  it('observes outcome failed on an exception without counting a decision or a duplicate', async () => {
    monitor.submissionStarted('http').failed();

    expect(await processingCount({ channel: 'http', outcome: 'failed' })).toBe(1);
    expect(await valueOf('wager_transactions_total', {})).toBe(0);
    expect(await valueOf('wager_transaction_duplicates_total', {})).toBe(0);
  });

  it('counts a decision of the PENDING_REFERENCE worker with its own source', async () => {
    const refund = pendingRefund();
    refund.markProcessed({ at: AT, balanceAfter: brl('100.00'), referenceTransactionId: 'tx-ref' });

    monitor.pendingReferenceDecided(refund);

    expect(
      await valueOf('wager_transactions_total', {
        status: 'PROCESSED',
        kind: 'REFUND',
        source: 'pending_reference_worker',
      }),
    ).toBe(1);
    expect(await processingCount({})).toBe(0);
  });

  it('registers the three metric families in the given registry and never in the global one', () => {
    for (const name of [
      'wager_transactions_total',
      'wager_transaction_duplicates_total',
      'wager_transaction_processing_seconds',
    ]) {
      expect(registry.getSingleMetric(name)).toBeDefined();
      expect(globalRegistry.getSingleMetric(name)).toBeUndefined();
    }
  });
});
