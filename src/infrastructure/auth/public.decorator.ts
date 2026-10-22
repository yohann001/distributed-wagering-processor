import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/** Rota (ou controller) aberta: o guard global a deixa passar sem consultar a porta de identidade (health, métricas). */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);
