import { z } from 'zod';

import { idText } from '../../../../infrastructure/http/request-schemas';
import { DomainError } from '../../../../shared/domain/domain-error';
import { FailureCode } from '../../../../shared/domain/failure-code';
import { defaultIdempotencyKey } from '../../../wagering/application/payload-hash';
import {
  idempotencyKeyText,
  toSubmitCommandFields,
  wagerTransactionPayloadSchema,
  type SubmitCommandFields,
} from '../../../wagering/presentation/wager-transaction-http.schemas';

export interface EnvelopeIssue {
  path: string;
  message: string;
}

/** Envelope ilegível ou fora do contrato. Permanente: reenviar a mesma mensagem não adianta, vai para a DLQ. */
export class InvalidEnvelopeError extends DomainError {
  readonly code = FailureCode.InvalidPayload;

  /** A mensagem lista só os caminhos: o valor recebido nunca entra no erro nem no log (§12). */
  constructor(readonly issues: EnvelopeIssue[]) {
    super(`Invalid WagerTransactionRequested envelope: ${issues.map((issue) => issue.path).join(', ')}`);
  }
}

const envelopeSchema = z.object({
  messageId: idText,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.unknown(),
});

/**
 * `idempotencyKey` fica fora do `wagerTransactionPayloadSchema` (que é o corpo do HTTP e não o tem). Esse schema
 * tem um `.refine` e no zod 4 não pode ser estendido, então o `data` é lido duas vezes.
 */
const dataExtrasSchema = z.object({ idempotencyKey: idempotencyKeyText.optional() });

export interface ParsedWagerEnvelope {
  messageId: string;
  occurredAt: Date;
  idempotencyKey: string;
  fields: SubmitCommandFields;
}

function issuesOf(error: z.ZodError, prefix: string[]): EnvelopeIssue[] {
  return error.issues.map((issue) => ({
    path: [...prefix, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

/**
 * Lê o corpo de uma mensagem `WagerTransactionRequested`. Os campos de negócio passam pelo mesmo
 * `wagerTransactionPayloadSchema` do HTTP (T19), então ids UUID vão para minúsculas e `providerId` com `:` é
 * recusado do mesmo jeito. `messageId`, `type` e `occurredAt` são do envelope e não entram no `payloadHash`
 * (`payload-hash.ts`); `idempotencyKey` é opcional e, sem ela, vale `providerId:externalTransactionId`.
 *
 * `INVALID_PAYLOAD` vem do envelope (`InvalidEnvelopeError`); kind `OPENING` e dinheiro inválido lançam
 * `KindNotAllowedError` e `InvalidMoneyError`, com seus próprios códigos.
 */
export function parseWagerTransactionEnvelope(body: string | undefined): ParsedWagerEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new InvalidEnvelopeError([{ path: 'body', message: 'must be a JSON object' }]);
  }

  const envelope = envelopeSchema.safeParse(json);
  // Sem `data` o próprio envelope já acusa a chave ausente; ler o `data` de novo repetiria o problema.
  const data = typeof json === 'object' && json !== null && 'data' in json ? json.data : undefined;
  const payload = data === undefined ? undefined : wagerTransactionPayloadSchema.safeParse(data);
  // Só com o `data` válido: um `data` que não é objeto já foi acusado uma vez pelo schema do payload.
  const extras = payload?.success ? dataExtrasSchema.safeParse(data) : undefined;

  if (!envelope.success || !payload?.success || !extras?.success) {
    throw new InvalidEnvelopeError([
      ...(envelope.success ? [] : issuesOf(envelope.error, [])),
      ...(payload?.success === false ? issuesOf(payload.error, ['data']) : []),
      ...(extras?.success === false ? issuesOf(extras.error, ['data']) : []),
    ]);
  }

  const fields = toSubmitCommandFields(payload.data);
  return {
    messageId: envelope.data.messageId,
    occurredAt: new Date(envelope.data.occurredAt),
    idempotencyKey:
      extras.data.idempotencyKey ?? defaultIdempotencyKey(fields.providerId, fields.externalTransactionId),
    fields,
  };
}
