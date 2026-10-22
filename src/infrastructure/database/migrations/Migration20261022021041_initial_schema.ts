import { Migration } from '@mikro-orm/migrations';

// Schema inicial (T10). Cada garantia de §5.9 tem nome explícito; ver ARCHITECTURE.md.
export class Migration20261022021041_initial_schema extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid not null,
        player_id text not null,
        currency text not null,
        balance numeric(18,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_pkey primary key (id),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_id_currency_uq unique (id, currency)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid not null,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null,
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(18,2) not null,
        currency text not null,
        reference_external_transaction_id text null,
        reference_transaction_id uuid null,
        status text not null,
        failure_code text null,
        balance_after numeric(18,2) null,
        processed_at timestamptz null,
        created_at timestamptz not null,
        constraint wager_transactions_pkey primary key (id),
        constraint wager_transactions_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_transactions_provider_idempotency_uq unique (provider_id, idempotency_key),
        constraint wager_transactions_id_wallet_currency_uq unique (id, wallet_id, currency),
        constraint wager_transactions_kind_valid check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_valid check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_opening_processed check (kind <> 'OPENING' or status = 'PROCESSED'),
        constraint wager_transactions_currency_iso check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_amount_valid check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_transactions_balance_after_non_negative check (balance_after is null or balance_after >= 0),
        constraint wager_transactions_reversal_requires_reference check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_pending_reference_has_reference check (status <> 'PENDING_REFERENCE' or reference_external_transaction_id is not null),
        constraint wager_transactions_processed_complete check (status <> 'PROCESSED' or (processed_at is not null and balance_after is not null)),
        constraint wager_transactions_processed_reversal_resolved check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null),
        constraint wager_transactions_failure_code_by_status check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_failed_permanent check (status <> 'FAILED' or failure_code = 'PERMANENT_FAILURE'),
        constraint wager_transactions_reference_not_self check (reference_transaction_id is null or reference_transaction_id <> id),
        constraint wager_transactions_reference_fk foreign key (reference_transaction_id) references wager_transactions (id) deferrable initially deferred
      )
    `);

    this.addSql(`
      create unique index wager_transactions_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (created_at, id)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      create index wager_transactions_reference_lookup_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where reference_external_transaction_id is not null
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid not null,
        seq bigint generated always as identity not null,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(18,2) not null,
        currency text not null,
        balance_before numeric(18,2) not null,
        balance_after numeric(18,2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_pkey primary key (id),
        constraint wallet_ledger_entries_transaction_wallet_uq unique (transaction_id, wallet_id),
        constraint wallet_ledger_entries_wallet_seq_uq unique (wallet_id, seq),
        constraint wallet_ledger_entries_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_balanced check (
          (direction = 'DEBIT' and balance_after = balance_before - amount)
          or (direction = 'CREDIT' and balance_after = balance_before + amount)
        ),
        constraint wallet_ledger_entries_wallet_fk foreign key (wallet_id, currency) references wallets (id, currency) deferrable initially deferred,
        constraint wallet_ledger_entries_transaction_fk foreign key (transaction_id, wallet_id, currency) references wager_transactions (id, wallet_id, currency) deferrable initially deferred
      )
    `);

    this.addSql(`
      create function wallet_ledger_entries_reject_change() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% blocked)', tg_op using errcode = 'restrict_violation';
      end;
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_reject_change()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_reject_change()
    `);

    this.addSql(`
      create function wager_transactions_guard_change() returns trigger language plpgsql as $$
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception 'wager_transactions rows are never deleted' using errcode = 'restrict_violation';
        end if;

        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transaction % is terminal (%)', old.id, old.status using errcode = 'restrict_violation';
        end if;

        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
          is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'transaction % immutable column changed', old.id using errcode = 'restrict_violation';
        end if;

        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard_change()
    `);
    this.addSql(`
      create trigger wager_transactions_no_truncate
        before truncate on wager_transactions
        for each statement execute function wager_transactions_guard_change()
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz null,
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid not null,
        aggregate_id uuid not null,
        event_type text not null,
        payload json not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz null,
        constraint outbox_messages_pkey primary key (id),
        constraint outbox_messages_attempts_non_negative check (attempts >= 0)
      )
    `);
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at)
        where published_at is null
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table outbox_messages`);
    this.addSql(`drop table inbox_messages`);
    this.addSql(`drop table wallet_ledger_entries`);
    this.addSql(`drop function wallet_ledger_entries_reject_change()`);
    this.addSql(`drop table wager_transactions`);
    this.addSql(`drop function wager_transactions_guard_change()`);
    this.addSql(`drop table wallets`);
  }

}
