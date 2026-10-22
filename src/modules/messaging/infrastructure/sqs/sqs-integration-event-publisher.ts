import { SendMessageBatchCommand, type SendMessageBatchRequestEntry, type SQSClient } from '@aws-sdk/client-sqs';

import {
  IntegrationEventPublisher,
  type PublishFailure,
  type PublishReport,
} from '../../application/integration-event-publisher';
import type { OutboxMessage } from '../../domain/outbox-message';

const SEND_FAILED = 'SendFailed';
const NOT_ACKNOWLEDGED = 'NotAcknowledged';

/**
 * Entradas do `SendMessageBatch`. O corpo é o envelope exatamente como gravado na outbox, o grupo é o agregado (a
 * ordem entre agregados é livre) e a deduplicação do FIFO é pelo `eventId`. `Id` é o índice na mensagem de entrada.
 */
export function toSendMessageBatchEntries(messages: readonly OutboxMessage[]): SendMessageBatchRequestEntry[] {
  return messages.map((message, index) => {
    const correlationId = message.payload['correlationId'];
    return {
      Id: String(index),
      MessageBody: JSON.stringify(message.payload),
      MessageGroupId: message.aggregateId,
      MessageDeduplicationId: message.id,
      MessageAttributes: {
        eventType: { DataType: 'String', StringValue: message.eventType },
        ...(typeof correlationId === 'string' && {
          correlationId: { DataType: 'String', StringValue: correlationId },
        }),
      },
    };
  });
}

/** Adapter SQS da porta `IntegrationEventPublisher`: um `SendMessageBatch` por chamada, com teto de tempo. */
export class SqsIntegrationEventPublisher extends IntegrationEventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly timeoutMs: number,
  ) {
    super();
  }

  async publish(messages: readonly OutboxMessage[]): Promise<PublishReport> {
    if (messages.length === 0) {
      return { publishedIds: new Set(), failures: [] };
    }

    try {
      const { Successful = [], Failed = [] } = await this.client.send(
        new SendMessageBatchCommand({ QueueUrl: this.queueUrl, Entries: toSendMessageBatchEntries(messages) }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );

      const publishedIds = new Set<string>();
      const failures = new Map<string, PublishFailure>();
      for (const entry of Successful) {
        const message = messageOf(messages, entry.Id);
        if (message !== undefined) {
          publishedIds.add(message.id);
        }
      }
      for (const entry of Failed) {
        const message = messageOf(messages, entry.Id);
        if (message !== undefined) {
          failures.set(message.id, { id: message.id, reason: entry.Code ?? SEND_FAILED });
        }
      }
      // Sem resposta para a entrada: não conta como publicada, e a outbox tenta de novo.
      for (const message of messages) {
        if (!publishedIds.has(message.id) && !failures.has(message.id)) {
          failures.set(message.id, { id: message.id, reason: NOT_ACKNOWLEDGED });
        }
      }
      return { publishedIds, failures: [...failures.values()] };
    } catch (error) {
      // Só o nome do erro: a mensagem do SDK pode trazer endpoint e URL da fila.
      const reason = error instanceof Error ? error.name : 'UnknownError';
      return { publishedIds: new Set(), failures: messages.map((message) => ({ id: message.id, reason })) };
    }
  }
}

function messageOf(messages: readonly OutboxMessage[], entryId: string | undefined): OutboxMessage | undefined {
  return entryId === undefined ? undefined : messages[Number(entryId)];
}
