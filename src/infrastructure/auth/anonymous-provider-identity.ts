import { Injectable } from '@nestjs/common';

import {
  ProviderIdentityPort,
  type ProviderCredentials,
  type ProviderIdentity,
} from '../../shared/application/provider-identity';

/**
 * No-op do ponto de extensão de autenticação (§2): aceita toda requisição como anônima, sem olhar a credencial.
 * Um adapter OIDC substitui este provider (ver ARCHITECTURE.md, "Autenticação").
 */
@Injectable()
export class AnonymousProviderIdentity extends ProviderIdentityPort {
  async authenticate(_credentials: ProviderCredentials): Promise<ProviderIdentity> {
    return { kind: 'anonymous' };
  }
}
