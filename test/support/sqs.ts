import {
  DeleteMessageBatchCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

import { loadEnv } from '../../src/config/env';

/** Cliente SQS apontado para o LocalStack, com a configuração do `.env`. */
export function createTestSqsClient(): SQSClient {
  const env = loadEnv();
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL !== undefined && { endpoint: env.AWS_ENDPOINT_URL }),
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
  });
}

/** URLs das filas de teste, lidas do `.env`. */
export function testQueueUrls(): { wager: string; dlq: string } {
  const env = loadEnv();
  return { wager: env.SQS_WAGER_QUEUE_URL, dlq: env.SQS_WAGER_DLQ_URL };
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
