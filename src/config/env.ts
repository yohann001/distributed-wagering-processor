import { hostname } from 'node:os';

import { z } from 'zod';

/** Texto opcional em que vazio vale como ausente (`VAR=` no `.env`, `${VAR:-}` no compose). */
const optionalText = z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  INSTANCE_ID: z.string().min(1).default(hostname()),

  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Acima de DB_LOCK_TIMEOUT_MS × DB_TRANSACTION_MAX_ATTEMPTS + backoff (~6,5 s no padrão): a espera pelo lock de
  // uma wallet quente não pode esgotar a espera por conexão das outras wallets da réplica.
  DB_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  DB_TRANSACTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
  HEALTH_CHECK_CACHE_MS: z.coerce.number().int().min(0).default(1000),

  AWS_REGION: z.string().min(1),
  AWS_ENDPOINT_URL: z.url().optional(),
  // Chaves estáticas são opcionais: sem elas o SDK usa a cadeia padrão (task role, IRSA, perfil). Ou as duas, ou nenhuma.
  AWS_ACCESS_KEY_ID: optionalText,
  AWS_SECRET_ACCESS_KEY: optionalText,
  AWS_SESSION_TOKEN: optionalText,
  SQS_WAGER_QUEUE_URL: z.url(),
  SQS_WAGER_DLQ_URL: z.url(),
})
  .refine((env) => (env.AWS_ACCESS_KEY_ID === undefined) === (env.AWS_SECRET_ACCESS_KEY === undefined), {
    path: ['AWS_SECRET_ACCESS_KEY'],
    message: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together',
  })
  .refine((env) => env.AWS_SESSION_TOKEN === undefined || env.AWS_ACCESS_KEY_ID !== undefined, {
    path: ['AWS_SESSION_TOKEN'],
    message: 'AWS_SESSION_TOKEN requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
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
