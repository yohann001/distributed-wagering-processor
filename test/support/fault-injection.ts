import type { MikroORM } from '@mikro-orm/postgresql';

// Injeção de falha só para testes (T26). Nada aqui substitui o Postgres: `failingAt` embrulha o adapter
// real, que continua executando o SQL de verdade dentro da transação, e `installCommitFault` cria um
// trigger real no banco. A falha é o único acréscimo.

/** Erro lançado pelo `failingAt`; os testes o distinguem de qualquer erro real da aplicação ou do banco. */
export class InjectedFault extends Error {
  constructor(readonly point: string) {
    super(`injected fault at ${point}`);
    this.name = 'InjectedFault';
  }
}

export interface FaultPoint {
  /** `before` lança sem chamar o método real; `after` chama o real (o SQL roda) e só então lança. */
  when: 'before' | 'after';
  /** Qual chamada de `method` falha, contando de 1. Padrão: a primeira. */
  call?: number;
}

/**
 * Proxy sobre a porta real: `method` falha na chamada escolhida e toda outra chamada, e toda outra
 * propriedade, vai para o adapter real. Cada `failingAt` tem o próprio contador de chamadas.
 */
export function failingAt<T extends object>(target: T, method: keyof T & string, fault: FaultPoint): T {
  const failingCall = fault.call ?? 1;
  let calls = 0;

  return new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== 'function') {
        return value;
      }
      const real: (...args: unknown[]) => unknown = value.bind(object);
      if (property !== method) {
        return real;
      }
      return async (...args: unknown[]) => {
        calls += 1;
        const fails = calls === failingCall;
        const point = `${fault.when} ${method} #${failingCall}`;
        if (fails && fault.when === 'before') {
          throw new InjectedFault(point);
        }
        const result = await real(...args);
        if (fails && fault.when === 'after') {
          throw new InjectedFault(point);
        }
        return result;
      };
    },
  });
}

/** Prefixo do trigger e da função de `installCommitFault`; os testes o usam para achar o trigger no catálogo. */
export const COMMIT_FAULT_PREFIX = 'test_commit_fault_';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Faz o próprio COMMIT falhar no Postgres: constraint trigger `deferrable initially deferred` em
 * `outbox_messages`, filtrado pela wallet do cenário, que lança no commit (o mesmo mecanismo de
 * `wallet_ledger_entries_transaction_processed`). Devolve a função que remove trigger e função;
 * quem instala deve chamá-la num `finally`.
 */
export async function installCommitFault(orm: MikroORM, walletId: string): Promise<() => Promise<void>> {
  if (!UUID.test(walletId)) {
    throw new Error('installCommitFault expects a lowercase UUID walletId: it is interpolated into DDL');
  }
  const name = `${COMMIT_FAULT_PREFIX}${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const em = orm.em.fork();

  await em.execute(`
    create function ${name}() returns trigger language plpgsql as $$
    begin
      if new.payload->'data'->>'walletId' = tg_argv[0] then
        raise exception 'injected commit fault' using errcode = 'P0001';
      end if;
      return null;
    end;
    $$
  `);
  await em.execute(`
    create constraint trigger ${name}
      after insert on outbox_messages
      deferrable initially deferred
      for each row execute function ${name}('${walletId}')
  `);

  return async () => {
    const cleanup = orm.em.fork();
    await cleanup.execute(`drop trigger if exists ${name} on outbox_messages`);
    await cleanup.execute(`drop function if exists ${name}()`);
  };
}
