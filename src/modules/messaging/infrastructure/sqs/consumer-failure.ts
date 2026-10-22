import { isTransientDatabaseFailure } from '../../../../infrastructure/database/mikro-orm-unit-of-work';
import { DomainError } from '../../../../shared/domain/domain-error';
import { FailureAction, FailureCode } from '../../../../shared/domain/failure-code';

export type ConsumerFailure =
  | { disposition: 'retry'; failureCode: FailureCode.TransientFailure }
  | { disposition: 'dead-letter'; failureCode: FailureCode };

/**
 * O que fazer com a mensagem quando o caso de uso (ou o parse do envelope) lança. Rejeição de negócio nunca
 * chega aqui: volta como `REJECTED` de `execute` e a mensagem é confirmada.
 *
 * - `retry`: falha transitória; a mensagem volta à fila com backoff até o limite de recebimentos.
 * - `dead-letter`: reenviar a mesma mensagem não adianta (envelope inválido, kind ou dinheiro inválido, conflito
 *   de inbox ou de idempotência, violação de invariante); vai para a DLQ com o `failureCode`.
 */
export function classifyConsumerFailure(error: unknown): ConsumerFailure {
  if (isTransientDatabaseFailure(error)) {
    return { disposition: 'retry', failureCode: FailureCode.TransientFailure };
  }
  if (error instanceof DomainError) {
    return error.action === FailureAction.Retry
      ? { disposition: 'retry', failureCode: FailureCode.TransientFailure }
      : { disposition: 'dead-letter', failureCode: error.code };
  }
  // Erro desconhecido (rede, SDK, bug): não vai para a DLQ na primeira falha, porque pode ser passageiro. O limite de
  // recebimentos o leva para a DLQ com TRANSIENT_FAILURE se persistir.
  return { disposition: 'retry', failureCode: FailureCode.TransientFailure };
}
