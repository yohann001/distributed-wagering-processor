import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Counter, type Registry } from 'prom-client';

import { resolveCorrelationId } from '../../../../infrastructure/observability/correlation-id';
import type { LogContext } from '../../../../infrastructure/observability/log-context';
import type { FailureCode } from '../../../../shared/domain/failure-code';
import type { SubmitWagerTransaction } from '../../../wagering/application/submit-wager-transaction';
import { classifyConsumerFailure } from './consumer-failure';
import { WAGER_TRANSACTIONS_CONSUMER, type SqsConsumerOptions } from './sqs-consumer-options';
import { parseWagerTransactionEnvelope } from './wager-transaction-envelope';

type Outcome = 'processed' | 'replayed' | 'retried' | 'dead_lettered' | 'released';

/** Teto do `VisibilityTimeout` no SQS (12 horas). */
const MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200;
/** `ChangeMessageVisibilityBatch` aceita até 10 entradas por chamada. */
const VISIBILITY_BATCH_SIZE = 10;
const RECEIVE_ERROR_PAUSE_MS = 1000;
const DEAD_LETTER_DEFAULT_GROUP = 'dead-letter';

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Consumer da fila `wager-transactions.fifo` (§10): long polling, e cada mensagem vai para o mesmo
 * `SubmitWagerTransaction` do HTTP, com a inbox `(consumerName, messageId)` na mesma transação SQL. É só
 * transporte: a deduplicação e as regras de negócio ficam no caso de uso.
 *
 * - O `DeleteMessage` só acontece depois que `execute` retorna, ou seja, depois do commit. Um crash entre o
 *   commit e o ack reentrega a mensagem, e a inbox a trata como duplicata.
 * - Rejeição de negócio vem como `REJECTED` de `execute` e é confirmada. Falha transitória volta à fila com
 *   backoff (`ChangeMessageVisibility`) até `maxReceives`. Falha permanente, envelope inválido e esgotamento
 *   dos recebimentos vão para a DLQ, que recebe a mensagem antes de ela ser apagada da fila principal.
 * - Mensagens do mesmo `MessageGroupId` rodam em sequência e grupos diferentes em paralelo. É só otimização:
 *   a correção vem da inbox, da idempotency key e das constraints, nunca da ordem da fila (§5.3).
 * - `stop` interrompe o long polling, espera as mensagens em andamento e devolve as que ainda não começaram
 *   (visibilidade 0) para outra réplica pegar já.
 */
export class SqsWagerTransactionConsumer {
  private readonly messages: Counter<'outcome'>;
  private running = false;
  private loop: Promise<void> | undefined;
  private receiveAbort: AbortController | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly submit: SubmitWagerTransaction,
    private readonly options: SqsConsumerOptions,
    private readonly logContext: LogContext,
    registry: Registry,
  ) {
    this.messages = new Counter({
      name: 'sqs_consumer_messages_total',
      help: 'Mensagens da fila de transações por desfecho no consumer (processada, replay, retry, DLQ, devolvida no desligamento)',
      labelNames: ['outcome'],
      registers: [registry],
    });
  }

  start(): void {
    if (!this.options.enabled || this.running) {
      return;
    }
    this.running = true;
    this.loop = this.pollLoop();
  }

  /** Idempotente e seguro sem `start`. Passado `shutdownTimeoutMs`, desiste de esperar: a visibilidade expira e a inbox deduplica. */
  async stop(): Promise<void> {
    this.running = false;
    this.receiveAbort?.abort();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.shutdownTimeoutMs);
    });
    try {
      const outcome = await Promise.race([Promise.allSettled([this.loop]), timeout]);
      if (outcome === 'timeout') {
        this.logContext
          .current()
          .warn(
            { shutdownTimeoutMs: this.options.shutdownTimeoutMs },
            'sqs consumer shutdown timed out with messages in flight',
          );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      let received: Message[];
      try {
        received = await this.receive();
      } catch (error) {
        if (!this.running) {
          break;
        }
        // Só o nome do erro: a mensagem do SDK pode trazer endpoint e URL da fila.
        this.logContext.current().warn({ errorName: errorNameOf(error) }, 'sqs receive failed');
        await Bun.sleep(RECEIVE_ERROR_PAUSE_MS);
        continue;
      }
      try {
        await this.processBatch(received);
      } catch (error) {
        // O loop não pode morrer calado: sem ele a réplica para de consumir. As mensagens voltam após a visibilidade.
        this.logContext.current().error({ errorName: errorNameOf(error) }, 'sqs batch processing failed');
      }
    }
  }

  private async receive(): Promise<Message[]> {
    const abort = new AbortController();
    this.receiveAbort = abort;
    const { Messages = [] } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.options.batchSize,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['correlationId'],
      }),
      { abortSignal: abort.signal },
    );
    return Messages;
  }

  /** Nunca lança: cada mensagem trata os próprios erros, e a devolução também. */
  private async processBatch(received: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    received.forEach((message, index) => {
      const key = message.Attributes?.MessageGroupId ?? `message:${message.MessageId ?? index}`;
      groups.set(key, [...(groups.get(key) ?? []), message]);
    });

    const notStarted: Message[] = [];
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (!this.running) {
            notStarted.push(message);
            continue;
          }
          await this.handle(message);
        }
      }),
    );
    await this.release(notStarted);
  }

  private handle(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const correlationId = resolveCorrelationId(
      message.MessageAttributes?.correlationId?.StringValue,
      () => message.MessageId ?? Bun.randomUUIDv7(),
    );

    // `messageId` do log é o do envelope (a chave da inbox), definido depois do parse; o id do SQS vai em `sourceMessageId`.
    return this.logContext.run({ correlationId }, async () => {
      try {
        const envelope = parseWagerTransactionEnvelope(message.Body);
        this.logContext.assign({
          messageId: envelope.messageId,
          walletId: envelope.fields.walletId,
          providerId: envelope.fields.providerId,
        });

        const result = await this.submit.execute({
          ...envelope.fields,
          idempotencyKey: envelope.idempotencyKey,
          correlationId,
          inbox: { consumerName: WAGER_TRANSACTIONS_CONSUMER, messageId: envelope.messageId },
        });
        this.logContext.assign({ transactionId: result.transaction.id });

        await this.ack(message);
        this.count(result.idempotentReplay ? 'replayed' : 'processed');
        this.logContext.current().info(
          {
            sourceMessageId: message.MessageId,
            status: result.transaction.status,
            idempotentReplay: result.idempotentReplay,
            receiveCount,
          },
          'sqs message processed',
        );
      } catch (error) {
        await this.onFailure(message, error, receiveCount);
      }
    });
  }

  private async onFailure(message: Message, error: unknown, receiveCount: number): Promise<void> {
    const failure = classifyConsumerFailure(error);
    // Nunca `error.message` nem o corpo: o erro pode vir do driver e a mensagem carrega valores financeiros (§12).
    const errorName = errorNameOf(error);

    if (failure.disposition === 'retry' && receiveCount < this.options.maxReceives) {
      const visibilityTimeoutSeconds = this.retryDelaySeconds(receiveCount);
      await this.retryLater(message, visibilityTimeoutSeconds);
      this.count('retried');
      this.logContext
        .current()
        .warn(
          {
            sourceMessageId: message.MessageId,
            failureCode: failure.failureCode,
            receiveCount,
            visibilityTimeoutSeconds,
            errorName,
          },
          'sqs message retry',
        );
      return;
    }

    const deadLettered = await this.deadLetter(message, failure.failureCode, receiveCount);
    if (!deadLettered) {
      return;
    }
    this.count('dead_lettered');
    this.logContext
      .current()
      .error(
        { sourceMessageId: message.MessageId, failureCode: failure.failureCode, receiveCount, errorName },
        'sqs message dead-lettered',
      );
  }

  private retryDelaySeconds(receiveCount: number): number {
    const seconds = Math.ceil(this.options.retryBackoff.delayMs(receiveCount) / 1000);
    return Math.min(MAX_VISIBILITY_TIMEOUT_SECONDS, Math.max(1, seconds));
  }

  /** O SQS falhar aqui não perde nada: a mensagem volta ao fim da visibilidade e a inbox deduplica. */
  private async ack(message: Message): Promise<void> {
    try {
      await this.client.send(
        new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    } catch (error) {
      this.logContext.current().warn({ errorName: errorNameOf(error) }, 'sqs ack failed');
    }
  }

  private async retryLater(message: Message, visibilityTimeoutSeconds: number): Promise<void> {
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: visibilityTimeoutSeconds,
        }),
      );
    } catch (error) {
      this.logContext.current().warn({ errorName: errorNameOf(error) }, 'sqs retry scheduling failed');
    }
  }

  /**
   * Copia o corpo sem alteração para a DLQ e só então apaga da fila principal. Um crash no meio reentrega a
   * mensagem, e a DLQ deduplica pelo `MessageId` do SQS (janela de 5 min). Se o envio falhar, a mensagem fica.
   * Devolve se a mensagem chegou à DLQ.
   */
  private async deadLetter(message: Message, failureCode: FailureCode, receiveCount: number): Promise<boolean> {
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.options.deadLetterQueueUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? DEAD_LETTER_DEFAULT_GROUP,
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            failureCode: { DataType: 'String', StringValue: failureCode },
            ...(message.MessageId !== undefined && {
              sourceMessageId: { DataType: 'String', StringValue: message.MessageId },
            }),
            receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
          },
        }),
      );
    } catch (error) {
      this.logContext.current().warn({ errorName: errorNameOf(error) }, 'sqs dead-letter send failed');
      return false;
    }
    await this.ack(message);
    return true;
  }

  /** Visibilidade 0: a mensagem que não chegou a ser processada fica disponível já para outra réplica. */
  private async release(notStarted: Message[]): Promise<void> {
    for (let from = 0; from < notStarted.length; from += VISIBILITY_BATCH_SIZE) {
      const chunk = notStarted.slice(from, from + VISIBILITY_BATCH_SIZE);
      try {
        const { Successful = [], Failed = [] } = await this.client.send(
          new ChangeMessageVisibilityBatchCommand({
            QueueUrl: this.options.queueUrl,
            Entries: chunk.map((message, index) => ({
              Id: String(index),
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            })),
          }),
        );
        this.count('released', Successful.length);
        if (Failed.length > 0) {
          this.logContext.current().warn({ failed: Failed.length }, 'sqs release failed for some messages');
        }
      } catch (error) {
        this.logContext.current().warn({ errorName: errorNameOf(error) }, 'sqs release failed');
      }
    }
  }

  private count(outcome: Outcome, amount = 1): void {
    this.messages.inc({ outcome }, amount);
  }
}
