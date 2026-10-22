import { Module } from '@nestjs/common';

import { HealthModule } from './health/health.module';
import { AuthModule } from './infrastructure/auth/auth.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { HttpModule } from './infrastructure/http/http.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { RuntimeModule } from './infrastructure/runtime/runtime.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [
    ObservabilityModule,
    HttpModule,
    AuthModule,
    DatabaseModule,
    RuntimeModule,
    WalletModule,
    WageringModule,
    MessagingModule,
    HealthModule,
  ],
})
export class AppModule {}
