export type DependencyName = 'postgres' | 'sqs';

export interface DependencyCheck {
  readonly name: DependencyName;
  /** Resolve se a dependência responde. `signal` aborta no estouro do timeout; a checagem pode ignorá-lo. */
  check(signal: AbortSignal): Promise<void>;
}

export type FailureReason = 'timeout' | 'error';

export type DependencyStatus =
  | { readonly status: 'up' }
  | { readonly status: 'down'; readonly reason: FailureReason };

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: Readonly<Partial<Record<DependencyName, DependencyStatus>>>;
}

export interface ReadinessFailure {
  readonly dependency: DependencyName;
  readonly reason: FailureReason;
  readonly errorName: string;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * Readiness (§9): roda as checagens em paralelo, cada uma com o próprio teto de tempo.
 *
 * O timeout limita a resposta da sonda, não a consulta por baixo: a corrida com o sinal também cobre a
 * checagem que ignora o `signal` (a query do Postgres), que segue ocupando a conexão até o driver desistir.
 * O relatório nunca carrega mensagem de erro, só `up` ou `down` com o motivo (`timeout` ou `error`); o
 * detalhe vai para o `onFailure` (log), sem corpo nem mensagem.
 */
export class ReadinessProbe {
  constructor(
    private readonly checks: readonly DependencyCheck[],
    private readonly timeoutMs: number,
    private readonly onFailure: (failure: ReadinessFailure) => void,
  ) {}

  async run(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.checks.map(async (check): Promise<[DependencyName, DependencyStatus]> => [
        check.name,
        await this.runCheck(check),
      ]),
    );
    const allUp = results.every(([, result]) => result.status === 'up');
    return { status: allUp ? 'ok' : 'unavailable', checks: Object.fromEntries(results) };
  }

  private async runCheck(check: DependencyCheck): Promise<DependencyStatus> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      await Promise.race([check.check(signal), rejectOnAbort(signal)]);
      return { status: 'up' };
    } catch (error) {
      const reason: FailureReason = signal.aborted ? 'timeout' : 'error';
      this.onFailure({
        dependency: check.name,
        reason,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return { status: 'down', reason };
    }
  }
}
