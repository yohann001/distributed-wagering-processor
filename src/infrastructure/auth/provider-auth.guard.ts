import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ProviderIdentityPort, type ProviderIdentity } from '../../shared/application/provider-identity';
import { UnauthenticatedError } from '../http/http-errors';
import { IS_PUBLIC_KEY } from './public.decorator';

/** O pedaço do `Request` do Express que o guard usa. `@types/express` não é dependência do projeto. */
export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  providerIdentity?: ProviderIdentity;
}

/**
 * Guard global do ponto de extensão de autenticação (§2): toda rota passa pela `ProviderIdentityPort`, salvo as
 * marcadas com `@Public()`. É fail-closed para rotas novas. Roda depois do pino-http (o `correlationId` já existe)
 * e antes de qualquer validação de corpo ou acesso ao banco. Nunca loga a credencial.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identities: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const identity = await this.identities.authenticate({
      authorization: typeof header === 'string' ? header : undefined,
    });
    if (identity === null) {
      throw new UnauthenticatedError();
    }
    request.providerIdentity = identity;
    return true;
  }
}
