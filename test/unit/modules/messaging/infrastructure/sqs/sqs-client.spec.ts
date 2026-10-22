import { describe, expect, it } from 'bun:test';

import { loadEnv } from '../../../../../../src/config/env';
import { buildSqsClient } from '../../../../../../src/modules/messaging/infrastructure/sqs/sqs-client';

const BASE_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  AWS_REGION: 'us-east-1',
  SQS_WAGER_QUEUE_URL: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  SQS_WAGER_DLQ_URL: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
};

describe('buildSqsClient', () => {
  it('uses the static keys and the session token when they are set', async () => {
    const client = buildSqsClient({
      AWS_REGION: 'us-east-1',
      AWS_ENDPOINT_URL: undefined,
      AWS_ACCESS_KEY_ID: 'ASIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'session-token',
    });

    const credentials = await client.config.credentials();

    expect(credentials.accessKeyId).toBe('ASIAEXAMPLE');
    expect(credentials.secretAccessKey).toBe('secret');
    expect(credentials.sessionToken).toBe('session-token');
    client.destroy();
  });
});

describe('loadEnv: AWS credentials', () => {
  it('accepts no static keys, so the SDK default chain (task role, IRSA) resolves them', () => {
    const env = loadEnv(BASE_ENV);

    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('treats empty keys (`AWS_ACCESS_KEY_ID=` in .env, `${VAR:-}` in compose) as not set', () => {
    const env = loadEnv({ ...BASE_ENV, AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '' });

    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
  });

  it.each([
    ['only the access key', { AWS_ACCESS_KEY_ID: 'key' }],
    ['only the secret', { AWS_SECRET_ACCESS_KEY: 'secret' }],
    ['a session token without keys', { AWS_SESSION_TOKEN: 'token' }],
  ])('refuses %s', (_name, extra) => {
    expect(() => loadEnv({ ...BASE_ENV, ...extra })).toThrow('Invalid environment configuration');
  });
});
