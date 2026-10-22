import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';

import { MessageQueue } from '../../application/message-queue';

export class SqsMessageQueue extends MessageQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }

  async ping(signal: AbortSignal): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] }),
      { abortSignal: signal },
    );
  }
}
