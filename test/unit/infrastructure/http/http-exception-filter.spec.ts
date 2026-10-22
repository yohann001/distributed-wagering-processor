import { describe, expect, it } from 'bun:test';

import { DriverException } from '@mikro-orm/core';
import type { ArgumentsHost } from '@nestjs/common';

import { DatabaseError } from '../../../../src/infrastructure/database/mikro-orm-unit-of-work';
import { HttpExceptionFilter } from '../../../../src/infrastructure/http/http-exception-filter';
import type { LogContext } from '../../../../src/infrastructure/observability/log-context';
import { FailureCode } from '../../../../src/shared/domain/failure-code';

const LEAK_MARKER = 'leak-binding-xyz';

interface Captured {
  status: number;
  body: unknown;
  logs: { level: string; fields: Record<string, unknown> }[];
}

function run(error: unknown): Captured {
  const captured: Captured = { status: 0, body: undefined, logs: [] };
  const logger = {
    error: (fields: Record<string, unknown>) => captured.logs.push({ level: 'error', fields }),
    warn: (fields: Record<string, unknown>) => captured.logs.push({ level: 'warn', fields }),
  };
  const filter = new HttpExceptionFilter({ current: () => logger } as unknown as LogContext);
  const response = {
    status(code: number) {
      captured.status = code;
      return response;
    },
    json(body: unknown) {
      captured.body = body;
    },
    setHeader: () => undefined,
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ id: 'corr-1', headers: {} }) }),
  } as unknown as ArgumentsHost;

  filter.catch(error, host);
  return captured;
}

/** Serializa o erro com as propriedades próprias (o serializer do pino também lê `message` e `stack`). */
function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner instanceof Error ? { ...inner, message: inner.message, stack: inner.stack } : inner,
  );
}

describe('HttpExceptionFilter', () => {
  it('logs a raw DriverException as a sanitized DatabaseError, without the SQL and its bindings (§12)', () => {
    const driverError = Object.assign(
      new Error(`select * from wallets where player_id = '${LEAK_MARKER}' - invalid input syntax`),
      { code: '22P02' },
    );

    const captured = run(new DriverException(driverError));

    expect(captured.status).toBe(500);
    expect(serialized(captured.body)).not.toContain(LEAK_MARKER);
    expect(captured.logs).toHaveLength(1);
    expect(captured.logs[0]?.level).toBe('error');
    expect(captured.logs[0]?.fields.err).toBeInstanceOf(DatabaseError);
    expect(captured.logs[0]?.fields.failureCode).toBe(FailureCode.InvariantViolation);
    expect(serialized(captured.logs[0]?.fields)).not.toContain(LEAK_MARKER);
  });

  it('does not log a 4xx', () => {
    const captured = run(Object.assign(new Error('too large'), { status: 413, expose: true }));

    expect(captured.status).toBe(413);
    expect(captured.logs).toEqual([]);
  });
});
