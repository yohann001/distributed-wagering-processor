import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  QueueDoesNotExist,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SendMessageBatchCommandInput,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { loadEnv } from '../../src/config/env';
import { buildSqsClient } from '../../src/modules/messaging/infrastructure/sqs/sqs-client';
import { InjectedFault } from './fault-injection';

/** Cliente SQS apontado para o LocalStack, com a configuração do `.env` (a mesma factory da aplicação). */
export function createTestSqsClient(): SQSClient {
  return buildSqsClient(loadEnv());
}

/** URLs das filas de teste, lidas do `.env`. */
export function testQueueUrls(): { wager: string; dlq: string; events: string } {
  const env = loadEnv();
  return { wager: env.SQS_WAGER_QUEUE_URL, dlq: env.SQS_WAGER_DLQ_URL, events: env.SQS_EVENTS_QUEUE_URL };
}

/**
 * Cliente SQS real que registra o `MessageDeduplicationId` (o `eventId`) de cada entrada de `SendMessageBatch`.
 * Só observa o cliente real, não o substitui: o envio segue para o LocalStack.
 */
export function countingSqsClient(): { client: SQSClient; sentEventIds: string[] } {
  const client = createTestSqsClient();
  const sentEventIds: string[] = [];
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === 'SendMessageBatchCommand') {
        const { Entries = [] } = args.input as SendMessageBatchCommandInput;
        for (const entry of Entries) {
          if (entry.MessageDeduplicationId !== undefined) {
            sentEventIds.push(entry.MessageDeduplicationId);
          }
        }
      }
      return next(args);
    },
    { step: 'initialize', name: 'countOutboxSends' },
  );
  return { client, sentEventIds };
}

/**
 * Cliente SQS real em que a próxima chamada do comando armado falha uma vez com `InjectedFault`, antes de sair
 * para o LocalStack. Só acrescenta um ponto de falha: toda outra chamada, e as seguintes do mesmo comando,
 * vão para o LocalStack.
 */
export function faultySqsClient(): { client: SQSClient; failNext(commandName: string): void } {
  const client = createTestSqsClient();
  let armed: string | undefined;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (armed !== undefined && context.commandName === armed) {
        armed = undefined;
        throw new InjectedFault(context.commandName);
      }
      return next(args);
    },
    { step: 'initialize', name: 'failNextCommand' },
  );
  return {
    client,
    failNext(commandName) {
      armed = commandName;
    },
  };
}

export interface TemporaryQueues {
  queueUrl: string;
  deadLetterQueueUrl: string;
  /** Apaga as duas filas; uma que já não existe é ignorada. */
  remove(): Promise<void>;
}

/**
 * Par de filas FIFO (principal e DLQ) só deste teste. A fila compartilhada do `.env` tem visibilidade longa e é usada
 * por outras suítes; aqui a visibilidade é curta (`visibilityTimeoutSeconds`), para a reentrega por expiração caber
 * num teste, e nenhuma mensagem de outra suíte entra. Sem `RedrivePolicy`: a DLQ sob teste é a explícita do consumer.
 * As URLs vêm da URL do `.env` com o nome trocado, nunca da resposta do `CreateQueue` (formato diferente no LocalStack).
 */
export async function createTemporaryQueues(
  client: SQSClient,
  opts: { visibilityTimeoutSeconds: number },
): Promise<TemporaryQueues> {
  const base = testQueueUrls().wager;
  const suffix = Bun.randomUUIDv7();
  const queueName = `it-${suffix}.fifo`;
  const deadLetterQueueName = `it-${suffix}-dlq.fifo`;
  const queueUrl = base.replace(/[^/]+$/, queueName);
  const deadLetterQueueUrl = base.replace(/[^/]+$/, deadLetterQueueName);

  await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(opts.visibilityTimeoutSeconds),
      },
    }),
  );
  await client.send(
    new CreateQueueCommand({
      QueueName: deadLetterQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );

  return {
    queueUrl,
    deadLetterQueueUrl,
    async remove() {
      for (const url of [queueUrl, deadLetterQueueUrl]) {
        try {
          await client.send(new DeleteQueueCommand({ QueueUrl: url }));
        } catch (error) {
          if (!(error instanceof QueueDoesNotExist)) {
            throw error;
          }
        }
      }
    },
  };
}

/**
 * Esvazia a fila, inclusive as mensagens em voo. Só para testes: o LocalStack 4.14.0 aceita purges
 * seguidos, mas a AWS real recusa um segundo `PurgeQueue` dentro de 60 s.
 */
export async function purgeQueue(client: SQSClient, queueUrl: string): Promise<void> {
  await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
}

export interface ReceiveAllOptions {
  /** Para assim que recebe esta quantidade; sem ela, para no primeiro receive vazio. */
  expected?: number;
  /** Teto de espera total, em ms (padrão 5000). */
  timeoutMs?: number;
  /**
   * Apaga o que leu (padrão `true`). Numa fila FIFO, uma mensagem em voo segura as próximas do mesmo grupo,
   * então ler sem apagar esconde mensagens do mesmo `MessageGroupId`.
   */
  deleteAfterRead?: boolean;
}

/** Lê mensagens da fila em lotes de até 10 e as devolve na ordem de recebimento. */
export async function receiveAll(
  client: SQSClient,
  queueUrl: string,
  opts: ReceiveAllOptions = {},
): Promise<Message[]> {
  const { expected, timeoutMs = 5000, deleteAfterRead = true } = opts;
  const deadline = Date.now() + timeoutMs;
  const received: Message[] = [];

  while (Date.now() < deadline && (expected === undefined || received.length < expected)) {
    const { Messages: batch = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );

    if (batch.length === 0) {
      if (expected === undefined) {
        break;
      }
      continue;
    }

    received.push(...batch);
    if (deleteAfterRead) {
      await client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle ?? '',
          })),
        }),
      );
    }
  }
  return received;
}

export interface SendRawOptions {
  groupId: string;
  /** Sem ele, cada envio recebe um id novo: o mesmo corpo enviado duas vezes simula uma reentrega que o dedup do FIFO não pega. */
  deduplicationId?: string;
  correlationId?: string;
}

/** Envia o corpo como texto, sem passar por `JSON.stringify`: para mensagens que não são JSON. */
export async function sendRaw(
  client: SQSClient,
  queueUrl: string,
  body: string,
  opts: SendRawOptions,
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: opts.groupId,
      MessageDeduplicationId: opts.deduplicationId ?? Bun.randomUUIDv7(),
      ...(opts.correlationId !== undefined && {
        MessageAttributes: { correlationId: { DataType: 'String', StringValue: opts.correlationId } },
      }),
    }),
  );
}

export function sendEnvelope(
  client: SQSClient,
  queueUrl: string,
  envelope: Record<string, unknown>,
  opts: SendRawOptions,
): Promise<void> {
  return sendRaw(client, queueUrl, JSON.stringify(envelope), opts);
}

/** Envelope `WagerTransactionRequested` (T22); `messageId` sem override é um UUIDv7 novo. */
export function buildEnvelope(overrides: {
  messageId?: string;
  data: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    messageId: overrides.messageId ?? Bun.randomUUIDv7(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: overrides.data,
  };
}

/** Mensagens visíveis e em voo (recebidas e ainda dentro da visibilidade). Os números do SQS são aproximados. */
export async function queueDepth(
  client: SQSClient,
  queueUrl: string,
): Promise<{ visible: number; inFlight: number }> {
  const { Attributes = {} } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages ?? '0'),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? '0'),
  };
}

/** Repete `probe` até devolver algo verdadeiro (qualquer valor que não seja `null`, `undefined` ou `false`). */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 10000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await Bun.sleep(intervalMs);
  }
}
