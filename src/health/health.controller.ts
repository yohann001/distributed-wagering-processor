import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';

import { Public } from '../infrastructure/auth/public.decorator';
import type { HttpResponse } from '../infrastructure/http/http-exception-filter';
import { ReadinessProbe, type ReadinessReport } from './readiness';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessProbe) {}

  /** Liveness: o processo está de pé. Não toca dependências externas. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness (§9): Postgres e SQS alcançáveis, cada um com timeout curto. 503 se algum falhar. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: HttpResponse): Promise<ReadinessReport> {
    const report = await this.readiness.run();
    response.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
