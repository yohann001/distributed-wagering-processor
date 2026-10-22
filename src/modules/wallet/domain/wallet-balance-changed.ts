import {
  IntegrationEvent,
  InvalidIntegrationEventError,
  type EventContext,
  type IntegrationEventProps,
} from '../../../shared/domain/integration-event';
import type { Money, MoneyProps } from '../../../shared/domain/money';
import type { Wallet } from './wallet';
import type { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  /** Lançamento que originou a mudança, para rastreio de auditoria. */
  ledgerEntryId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Cópia em objeto literal: o evento nunca guarda a instância de Money. */
function moneyProps(money: Money): MoneyProps {
  const { amount, currency } = money.toJSON();
  return { amount, currency };
}

/** Somente quando o saldo muda: um evento por lançamento do ledger. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  /** Montado logo após a movimentação: `entry` precisa ser o último lançamento aplicado à instância `wallet`. */
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError(
        `ledger entry ${entry.id} belongs to wallet ${entry.walletId}, not to wallet ${wallet.id}`,
      );
    }
    if (wallet.lastLedgerEntryId !== entry.id) {
      throw new InvalidIntegrationEventError(
        `ledger entry ${entry.id} is not the latest movement of wallet ${wallet.id}`,
      );
    }
    const data: WalletBalanceChangedData = {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      ledgerEntryId: entry.id,
      direction: entry.direction,
      money: moneyProps(entry.money),
      balanceBefore: moneyProps(entry.balanceBefore),
      balanceAfter: moneyProps(entry.balanceAfter),
      walletVersion: wallet.version,
    };
    return new WalletBalanceChanged({ ...ctx, aggregateId: wallet.id, data });
  }
}
