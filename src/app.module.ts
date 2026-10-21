import { Module } from '@nestjs/common';

import { HealthModule } from './health/health.module';
import { DatabaseModule } from './infrastructure/database/database.module';

@Module({
  imports: [DatabaseModule, HealthModule],
})
export class AppModule {}
