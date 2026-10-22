import { Counter, type Registry } from 'prom-client';

import type { ConcurrencyConflictReason } from '../../shared/application/unit-of-work';

export type ConflictOutcome = 'retried' | 'exhausted';

/** Uma instância por app: o contador é registrado no `Registry` do app (T13), nunca no global. */
export class ConcurrencyMetrics {
  private readonly conflicts: Counter<'reason' | 'outcome'>;

  constructor(registry: Registry) {
    this.conflicts = new Counter({
      name: 'lock_conflicts_total',
      help: 'Conflitos de concorrência no banco (deadlock, serialization failure, lock timeout, version da wallet), por desfecho',
      labelNames: ['reason', 'outcome'],
      registers: [registry],
    });
  }

  recordConflict(reason: ConcurrencyConflictReason, outcome: ConflictOutcome): void {
    this.conflicts.inc({ reason: reason.toLowerCase(), outcome });
  }
}
