import type { WalletReconciliation } from './reconcile-wallet';

/**
 * Porta que torna visível uma divergência da reconciliação (§9): log e métrica.
 * A implementação não pode logar valores financeiros (§12); eles seguem só na resposta.
 */
export abstract class ReconciliationMonitor {
  abstract divergenceDetected(reconciliation: WalletReconciliation): void;
}
