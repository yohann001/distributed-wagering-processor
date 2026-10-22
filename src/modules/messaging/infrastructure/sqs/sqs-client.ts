import { SQSClient } from '@aws-sdk/client-sqs';

import type { Env } from '../../../../config/env';

export type SqsClientEnv = Pick<
  Env,
  'AWS_REGION' | 'AWS_ENDPOINT_URL' | 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY'
>;

/** Cliente SQS a partir do ambiente. No dev e nos testes `AWS_ENDPOINT_URL` aponta para o LocalStack; sem ela vale a AWS real. */
export function buildSqsClient(env: SqsClientEnv): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL !== undefined && { endpoint: env.AWS_ENDPOINT_URL }),
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
  });
}
