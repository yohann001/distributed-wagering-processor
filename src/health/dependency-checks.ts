import type { EntityManager } from '@mikro-orm/postgresql';

import type { MessageQueue } from '../modules/messaging/application/message-queue';
import type { DependencyCheck } from './readiness';

export function postgresCheck(em: EntityManager): DependencyCheck {
  return {
    name: 'postgres',
    check: async () => {
      await em.getConnection().execute('select 1');
    },
  };
}

export function sqsCheck(queue: MessageQueue): DependencyCheck {
  return { name: 'sqs', check: (signal) => queue.ping(signal) };
}
