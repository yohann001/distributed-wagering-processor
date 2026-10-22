import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { ProviderIdentityPort } from '../../shared/application/provider-identity';
import { AnonymousProviderIdentity } from './anonymous-provider-identity';
import { ProviderAuthGuard } from './provider-auth.guard';

@Global()
@Module({
  providers: [
    { provide: ProviderIdentityPort, useClass: AnonymousProviderIdentity },
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
  ],
  exports: [ProviderIdentityPort],
})
export class AuthModule {}
