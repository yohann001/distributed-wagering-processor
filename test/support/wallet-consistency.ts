import type { MikroORM } from '@mikro-orm/postgresql';

import { Money } from '../../src/shared/domain/money';

interface WalletRow {
  balance: string;
  currency: string;
  version: number;
}

interface LedgerRow {
  direction: string;
  amount: string;
  balance_before: string;
  balance_after: string;
}

/**
 * §13: o saldo da wallet é o saldo reconstruído pelo ledger. Lê a wallet e o ledger por `seq` e falha,
 * com a verificação que quebrou na mensagem, se o saldo diverge da soma, se a cadeia
 * `balanceBefore/After` (a partir de 0.00) não é contínua ou se `version` não bate com os lançamentos (§6.2).
 */
export async function assertWalletConsistent(orm: MikroORM, walletId: string): Promise<void> {
  const em = orm.em.fork();

  const wallets = await em.execute<WalletRow[]>(
    'select balance::text as balance, currency, version from wallets where id = ?',
    [walletId],
  );
  const walletRow = wallets[0];
  if (walletRow === undefined) {
    throw new Error(`wallet ${walletId} not found`);
  }
  const { currency } = walletRow;
  const walletBalance = Money.from({ amount: walletRow.balance, currency });

  const entries = await em.execute<LedgerRow[]>(
    `select direction, amount::text as amount, balance_before::text as balance_before,
            balance_after::text as balance_after
       from wallet_ledger_entries where wallet_id = ? order by seq`,
    [walletId],
  );

  let expected = Money.zero(currency);
  entries.forEach((entry, index) => {
    const amount = Money.from({ amount: entry.amount, currency });
    const balanceBefore = Money.from({ amount: entry.balance_before, currency });
    const balanceAfter = Money.from({ amount: entry.balance_after, currency });

    if (!balanceBefore.equals(expected)) {
      throw new Error(`ledger chain broken at entry #${index} of wallet ${walletId}`);
    }
    const recomputed = entry.direction === 'CREDIT' ? balanceBefore.add(amount) : balanceBefore.subtract(amount);
    if (!recomputed.equals(balanceAfter)) {
      throw new Error(`ledger entry #${index} of wallet ${walletId} is unbalanced`);
    }
    expected = balanceAfter;
  });

  const sums = await em.execute<{ total: string }[]>(
    `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(18,2)::text as total
       from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  const ledgerSum = Money.from({ amount: sums[0]?.total ?? '0.00', currency });
  if (!ledgerSum.equals(walletBalance)) {
    throw new Error(`wallet ${walletId} balance differs from ledger sum`);
  }
  if (!expected.equals(walletBalance)) {
    throw new Error(`wallet ${walletId} balance differs from last ledger balance_after`);
  }

  if (walletRow.version !== Math.max(1, entries.length)) {
    throw new Error(
      `wallet ${walletId} version ${walletRow.version} does not match ${entries.length} ledger entries`,
    );
  }
}
