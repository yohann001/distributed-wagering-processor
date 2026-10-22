import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

import { Public } from '../infrastructure/auth/public.decorator';

@Public()
@Controller('health')
export class HealthController {
  /** Liveness: o processo está de pé. Não toca dependências externas. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
