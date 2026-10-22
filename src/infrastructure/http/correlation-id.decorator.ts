import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/** `req.id` é definido pelo `genReqId` do pino-http (`logger.config.ts`): o `X-Correlation-Id` recebido ou um UUIDv7 novo. */
export const CorrelationId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const id = context.switchToHttp().getRequest<{ id?: unknown }>().id;
  if (typeof id !== 'string') {
    throw new Error('request without correlation id');
  }
  return id;
});
