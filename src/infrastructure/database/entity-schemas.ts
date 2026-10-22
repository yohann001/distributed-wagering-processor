import { InboxMessageSchema } from '../../modules/messaging/infrastructure/persistence/inbox-message.persistence';
import { OutboxMessageSchema } from '../../modules/messaging/infrastructure/persistence/outbox-message.persistence';
import { WagerTransactionSchema } from '../../modules/wagering/infrastructure/persistence/wager-transaction.persistence';
import { WalletLedgerEntrySchema } from '../../modules/wallet/infrastructure/persistence/wallet-ledger-entry.persistence';
import { WalletSchema } from '../../modules/wallet/infrastructure/persistence/wallet.persistence';

/** Lista única de schemas, usada pelo app e pela CLI (`buildMikroOrmConfig`). */
export const ENTITY_SCHEMAS = [
  WalletSchema,
  WalletLedgerEntrySchema,
  WagerTransactionSchema,
  InboxMessageSchema,
  OutboxMessageSchema,
] as const;
