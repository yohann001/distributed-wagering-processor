import type { EntityManager } from '@mikro-orm/postgresql';

/** Tabelas da aplicação (a `mikro_orm_migrations` do Migrator fica de fora). */
export const APP_TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'inbox_messages',
  'outbox_messages',
] as const;

/** Toda constraint nomeada das migrations. Constraint nova ou removida sem querer quebra o teste de catálogo. */
export const EXPECTED_CONSTRAINTS: readonly string[] = [
  'inbox_messages_pkey',
  'outbox_messages_attempts_non_negative',
  'outbox_messages_pkey',
  'wager_transactions_amount_valid',
  'wager_transactions_balance_after_non_negative',
  'wager_transactions_currency_iso',
  'wager_transactions_failed_permanent',
  'wager_transactions_failure_code_by_status',
  'wager_transactions_id_wallet_currency_uq',
  'wager_transactions_kind_valid',
  'wager_transactions_opening_processed',
  'wager_transactions_pending_reference_has_reference',
  'wager_transactions_pending_reference_scheduled',
  'wager_transactions_pkey',
  'wager_transactions_processed_complete',
  'wager_transactions_processed_reversal_resolved',
  'wager_transactions_provider_external_uq',
  'wager_transactions_provider_idempotency_uq',
  'wager_transactions_reference_attempts_non_negative',
  'wager_transactions_reference_fk',
  'wager_transactions_reference_not_self',
  'wager_transactions_reversal_requires_reference',
  'wager_transactions_status_valid',
  'wallet_ledger_entries_amount_positive',
  'wallet_ledger_entries_balanced',
  'wallet_ledger_entries_balances_non_negative',
  'wallet_ledger_entries_direction_valid',
  'wallet_ledger_entries_pkey',
  'wallet_ledger_entries_transaction_fk',
  'wallet_ledger_entries_transaction_wallet_uq',
  'wallet_ledger_entries_wallet_fk',
  'wallet_ledger_entries_wallet_seq_uq',
  'wallets_balance_non_negative',
  'wallets_currency_iso',
  'wallets_id_currency_uq',
  'wallets_pkey',
  'wallets_player_currency_uq',
  'wallets_version_positive',
];

/** Índices explícitos; os que sustentam PK/UNIQUE já aparecem em `EXPECTED_CONSTRAINTS`. */
export const EXPECTED_INDEXES: readonly string[] = [
  'wager_transactions_single_reversal_uq',
  'wager_transactions_pending_reference_due_idx',
  'wager_transactions_reference_lookup_idx',
  'outbox_messages_pending_idx',
];

export const EXPECTED_TRIGGERS: readonly string[] = [
  'wallet_ledger_entries_append_only',
  'wallet_ledger_entries_no_truncate',
  'wallet_ledger_entries_transaction_processed',
  'wager_transactions_guard',
  'wager_transactions_no_truncate',
];

export const EXPECTED_FUNCTIONS: readonly string[] = [
  'wallet_ledger_entries_check_transaction',
  'wallet_ledger_entries_reject_change',
  'wager_transactions_guard_change',
];

export interface SchemaObjects {
  tables: string[];
  constraints: string[];
  indexes: string[];
  triggers: string[];
  functions: string[];
}

/** O schema esperado depois do `up`, com cada lista ordenada como `readSchemaObjects` devolve. */
export const EXPECTED_SCHEMA_OBJECTS: SchemaObjects = {
  tables: [...APP_TABLES].sort(),
  constraints: [...EXPECTED_CONSTRAINTS].sort(),
  indexes: [...EXPECTED_INDEXES].sort(),
  triggers: [...EXPECTED_TRIGGERS].sort(),
  functions: [...EXPECTED_FUNCTIONS].sort(),
};

/** O schema esperado depois do `down`: nada da aplicação. */
export const EMPTY_SCHEMA_OBJECTS: SchemaObjects = {
  tables: [],
  constraints: [],
  indexes: [],
  triggers: [],
  functions: [],
};

async function names(em: EntityManager, sql: string): Promise<string[]> {
  const rows = await em.execute<{ name: string }[]>(sql);
  return rows.map((row) => row.name).sort();
}

/** Lê do catálogo do Postgres os objetos nomeados do schema `public`, sem a tabela do Migrator. */
export async function readSchemaObjects(em: EntityManager): Promise<SchemaObjects> {
  return {
    tables: await names(
      em,
      `select tablename as name from pg_tables
        where schemaname = 'public' and tablename <> 'mikro_orm_migrations'`,
    ),
    // contype 'n' (NOT NULL) é listado pelo PG 17 e não é uma constraint nomeada da migration.
    constraints: await names(
      em,
      `select c.conname as name
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public' and t.relname <> 'mikro_orm_migrations'
          and c.contype in ('p', 'u', 'c', 'f')`,
    ),
    indexes: await names(
      em,
      `select i.indexname as name
         from pg_indexes i
        where i.schemaname = 'public' and i.tablename <> 'mikro_orm_migrations'
          and not exists (select 1 from pg_constraint c where c.conname = i.indexname)`,
    ),
    triggers: await names(
      em,
      `select t.tgname as name
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal`,
    ),
    functions: await names(
      em,
      `select p.proname as name
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    ),
  };
}
