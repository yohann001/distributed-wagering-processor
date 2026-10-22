import { Migration } from '@mikro-orm/migrations';

// Lançamento de ledger só para transação PROCESSED que não seja LOSS (§6.4: LOSS e REJECTED não geram
// lançamento). Constraint trigger deferred: a transação pode ser inserida PENDING e virar PROCESSED na
// mesma transação SQL, então o status é conferido no COMMIT. Ver ARCHITECTURE.md.
export class Migration20261022120924_ledger_entry_processed_transaction extends Migration {

  override async up(): Promise<void> {
    this.addSql(`
      create function wallet_ledger_entries_check_transaction() returns trigger language plpgsql as $$
      declare
        tx_kind text;
        tx_status text;
      begin
        select kind, status into tx_kind, tx_status from wager_transactions where id = new.transaction_id;
        -- Transação inexistente é reportada pela FK wallet_ledger_entries_transaction_fk.
        if found and (tx_status <> 'PROCESSED' or tx_kind = 'LOSS') then
          raise exception 'ledger entry % requires a PROCESSED non-LOSS transaction (% %)', new.id, tx_kind, tx_status
            using errcode = 'check_violation', constraint = 'wallet_ledger_entries_transaction_processed';
        end if;
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_transaction_processed
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_check_transaction()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger wallet_ledger_entries_transaction_processed on wallet_ledger_entries`);
    this.addSql(`drop function wallet_ledger_entries_check_transaction()`);
  }

}
