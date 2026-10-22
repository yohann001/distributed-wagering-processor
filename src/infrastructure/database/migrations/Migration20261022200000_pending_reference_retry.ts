import { Migration } from '@mikro-orm/migrations';

// Estado de retry do worker de PENDING_REFERENCE (T24, §7.1): quantas reavaliações já erraram a referência e quando
// vence a próxima. As colunas ficam fora da lista de colunas imutáveis do trigger `wager_transactions_guard`, então
// o worker as atualiza enquanto a linha não é terminal. O índice parcial passa a ordenar pelo vencimento, que é o
// que o claim com `FOR UPDATE SKIP LOCKED` lê. Ver ARCHITECTURE.md.
export class Migration20261022200000_pending_reference_retry extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column reference_attempts integer not null default 0,
        add column next_reference_attempt_at timestamptz null
    `);
    this.addSql(`
      update wager_transactions set next_reference_attempt_at = created_at where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_transactions_reference_attempts_non_negative check (reference_attempts >= 0),
        add constraint wager_transactions_pending_reference_scheduled check (status <> 'PENDING_REFERENCE' or next_reference_attempt_at is not null)
    `);
    this.addSql(`drop index wager_transactions_pending_reference_idx`);
    this.addSql(`
      create index wager_transactions_pending_reference_due_idx
        on wager_transactions (next_reference_attempt_at, id)
        where status = 'PENDING_REFERENCE'
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index wager_transactions_pending_reference_due_idx`);
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (created_at, id)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_pending_reference_scheduled,
        drop constraint wager_transactions_reference_attempts_non_negative
    `);
    this.addSql(`
      alter table wager_transactions
        drop column next_reference_attempt_at,
        drop column reference_attempts
    `);
  }

}
