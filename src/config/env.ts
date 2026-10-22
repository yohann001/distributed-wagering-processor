import { hostname } from 'node:os';

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  INSTANCE_ID: z.string().min(1).default(hostname()),

  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  DB_TRANSACTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  AWS_REGION: z.string().min(1),
  AWS_ENDPOINT_URL: z.url().optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_WAGER_QUEUE_URL: z.url(),
  SQS_WAGER_DLQ_URL: z.url(),
});

export type Env = z.infer<typeof envSchema>;

/** Valida as variáveis de ambiente e falha rápido no boot se algo estiver faltando. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
