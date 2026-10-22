import { Controller, Get, Header, StreamableFile } from '@nestjs/common';
import { Registry } from 'prom-client';

import { Public } from '../auth/public.decorator';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly registry: Registry) {}

  /**
   * Scrape do Prometheus: formato texto de exposição. Devolve `StreamableFile` porque o Express
   * reescreve o `Content-Type` de respostas string e reordena os parâmetros (`charset` antes de
   * `version`); assim o header sai exatamente como o prom-client o define.
   */
  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  async metrics(): Promise<StreamableFile> {
    return new StreamableFile(Buffer.from(await this.registry.metrics()));
  }
}
