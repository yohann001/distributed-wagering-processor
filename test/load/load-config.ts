import { z } from 'zod';

/** Moeda única do teste de carga: o experimento mede concorrência por wallet, não câmbio. */
export const LOAD_CURRENCY = 'BRL';

/** Valor monetário como texto decimal de escala 2: nunca `number` (CLAUDE.md, "Dinheiro"). */
const decimalAmount = z.string().regex(/^\d{1,12}\.\d{2}$/, 'must be a decimal string with 2 places, like 300.00');

const ratio = z.coerce.number().min(0).max(1);

const loadConfigSchema = z.object({
  LOAD_BASE_URL: z.url().default('http://localhost:8080'),
  LOAD_DURATION_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  // As amostras do aquecimento entram nas invariantes, mas ficam fora de throughput e latência.
  LOAD_WARMUP_SECONDS: z.coerce.number().int().min(0).max(600).default(5),
  // Usuários virtuais em laço fechado, sem tempo de espera entre rodadas.
  LOAD_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(24),
  LOAD_HOT_WALLETS: z.coerce.number().int().min(1).max(100).default(4),
  LOAD_HOT_TRAFFIC_RATIO: ratio.default(0.5),
  LOAD_HOT_INITIAL_BALANCE: decimalAmount.default('300.00'),
  LOAD_COLD_WALLETS: z.coerce.number().int().min(1).max(10000).default(200),
  LOAD_COLD_INITIAL_BALANCE: decimalAmount.default('1000.00'),
  LOAD_SQS_RATIO: ratio.default(0.2),
  LOAD_REPLAY_RATIO: ratio.default(0.1),
  LOAD_SEED: z.coerce.number().int().min(0).default(42),
  LOAD_EXPECTED_REPLICAS: z.coerce.number().int().min(1).default(3),
  // `true`: a pilha (infra, réplicas e nginx) é do usuário; o script não chama o docker, mas roda as migrations.
  LOAD_SKIP_COMPOSE: z.stringbool().default(false),
  // `true`: deixa `app` e `nginx` de pé depois da execução.
  LOAD_KEEP_APP: z.stringbool().default(false),
  LOAD_DRAIN_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(1800).default(180),
  LOAD_REPORT_DIR: z.string().min(1).default('reports/load'),
});

export interface LoadConfig {
  baseUrl: string;
  durationSeconds: number;
  warmupSeconds: number;
  concurrency: number;
  hotWallets: number;
  hotTrafficRatio: number;
  hotInitialBalance: string;
  coldWallets: number;
  coldInitialBalance: string;
  sqsRatio: number;
  replayRatio: number;
  seed: number;
  expectedReplicas: number;
  skipCompose: boolean;
  keepApp: boolean;
  drainTimeoutSeconds: number;
  reportDir: string;
}

/** Valida as variáveis `LOAD_*` e falha rápido, como o `loadEnv` da aplicação. */
export function loadLoadConfig(source: Record<string, string | undefined> = process.env): LoadConfig {
  const parsed = loadConfigSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid load test configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    baseUrl: env.LOAD_BASE_URL.replace(/\/+$/, ''),
    durationSeconds: env.LOAD_DURATION_SECONDS,
    warmupSeconds: env.LOAD_WARMUP_SECONDS,
    concurrency: env.LOAD_CONCURRENCY,
    hotWallets: env.LOAD_HOT_WALLETS,
    hotTrafficRatio: env.LOAD_HOT_TRAFFIC_RATIO,
    hotInitialBalance: env.LOAD_HOT_INITIAL_BALANCE,
    coldWallets: env.LOAD_COLD_WALLETS,
    coldInitialBalance: env.LOAD_COLD_INITIAL_BALANCE,
    sqsRatio: env.LOAD_SQS_RATIO,
    replayRatio: env.LOAD_REPLAY_RATIO,
    seed: env.LOAD_SEED,
    expectedReplicas: env.LOAD_EXPECTED_REPLICAS,
    skipCompose: env.LOAD_SKIP_COMPOSE,
    keepApp: env.LOAD_KEEP_APP,
    drainTimeoutSeconds: env.LOAD_DRAIN_TIMEOUT_SECONDS,
    reportDir: env.LOAD_REPORT_DIR,
  };
}
