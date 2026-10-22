import type { Money } from '../../../shared/domain/money';
import type { ReconciliationMonitor } from './reconciliation-monitor';
import type { WalletLedgerRepository } from './wallet-ledger-repository';

export interface WalletReconciliation {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** storedBalance − calculatedBalance; negativo quando o saldo materializado está abaixo do ledger. */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Reconciliação de uma wallet (§9): recalcula o saldo pelo ledger e compara com o saldo materializado.
 * Lê fora do `UnitOfWork`, num único statement e sem lock, então não bloqueia apostas. Nunca corrige:
 * divergência é sinalizada na resposta e entregue ao `ReconciliationMonitor` (log e métrica).
 * `null` significa "não encontrada"; quem decide o que isso vira (404) é a borda.
 */
export class ReconcileWallet {
  constructor(
    private readonly ledger: WalletLedgerRepository,
    private readonly monitor: ReconciliationMonitor,
  ) {}

  async execute(walletId: string): Promise<WalletReconciliation | null> {
    const snapshot = await this.ledger.balanceSnapshot(walletId);
    if (snapshot === null) {
      return null;
    }

    const difference = snapshot.storedBalance.subtract(snapshot.ledgerBalance);
    const reconciliation: WalletReconciliation = {
      walletId,
      storedBalance: snapshot.storedBalance,
      calculatedBalance: snapshot.ledgerBalance,
      difference,
      consistent: difference.isZero(),
      checkedEntries: snapshot.entryCount,
    };
    if (!reconciliation.consistent) {
      this.monitor.divergenceDetected(reconciliation);
    }
    return reconciliation;
  }
}
