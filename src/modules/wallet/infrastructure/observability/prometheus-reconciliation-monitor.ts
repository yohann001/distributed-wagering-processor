import { Counter, type Registry } from 'prom-client';

import type { LogContext } from '../../../../infrastructure/observability/log-context';
import { ReconciliationMonitor } from '../../application/reconciliation-monitor';
import type { WalletReconciliation } from '../../application/reconcile-wallet';

/** Uma instância por app: o contador é registrado no `Registry` do app (T13), nunca no global. */
export class PrometheusReconciliationMonitor extends ReconciliationMonitor {
  private readonly divergences: Counter<'currency'>;

  constructor(
    registry: Registry,
    private readonly logContext: LogContext,
  ) {
    super();
    // Sem label de walletId: cardinalidade ilimitada.
    this.divergences = new Counter({
      name: 'wallet_reconciliation_divergences_total',
      help: 'Reconciliações em que o saldo materializado diverge do saldo reconstruído pelo ledger',
      labelNames: ['currency'],
      registers: [registry],
    });
  }

  divergenceDetected(reconciliation: WalletReconciliation): void {
    const { currency } = reconciliation.storedBalance;
    this.divergences.inc({ currency });
    // Os valores ficam fora do log (§12); a resposta da reconciliação os carrega.
    this.logContext
      .current()
      .warn(
        { walletId: reconciliation.walletId, currency, checkedEntries: reconciliation.checkedEntries },
        'wallet reconciliation divergence',
      );
  }
}
