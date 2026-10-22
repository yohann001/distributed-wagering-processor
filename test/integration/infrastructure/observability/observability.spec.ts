import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { INestApplication } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Registry } from 'prom-client';

import { LogContext } from '../../../../src/infrastructure/observability/log-context';
import { createTestApp } from '../../../support/create-test-app';
import { createLogCapture } from '../../../support/log-capture';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('observability', () => {
  const capture = createLogCapture();
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp({ logDestination: capture.stream });
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('correlationId on HTTP requests', () => {
    it('echoes a valid X-Correlation-Id and logs it with instanceId', async () => {
      const res = await fetch(`${baseUrl}/does-not-exist`, {
        headers: { 'X-Correlation-Id': 'corr-t13-1' },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('x-correlation-id')).toBe('corr-t13-1');

      const line = await capture.waitFor(
        (l) => l.correlationId === 'corr-t13-1' && l.msg === 'request completed',
      );
      expect(line.instanceId).toEqual(expect.any(String));
      expect(line.req).toEqual({ method: 'GET', url: '/does-not-exist' });
      expect(line.res).toEqual({ statusCode: 404 });
      expect(line.req).not.toHaveProperty('headers');
    });

    it('generates a UUIDv7 when the header is absent', async () => {
      const res = await fetch(`${baseUrl}/does-not-exist-no-header`);
      const id = res.headers.get('x-correlation-id');
      expect(id).toMatch(UUID_V7);

      await capture.waitFor((l) => l.correlationId === id && l.msg === 'request completed');
    });

    it('replaces an invalid header (200 characters) with a UUIDv7', async () => {
      const invalid = 'a'.repeat(200);
      const res = await fetch(`${baseUrl}/does-not-exist-long-header`, {
        headers: { 'X-Correlation-Id': invalid },
      });
      const id = res.headers.get('x-correlation-id');
      expect(id).toMatch(UUID_V7);
      expect(id).not.toBe(invalid);

      await capture.waitFor((l) => l.correlationId === id && l.msg === 'request completed');
      expect(capture.raw()).not.toContain(invalid);
    });

    it('does not log the query string', async () => {
      const res = await fetch(`${baseUrl}/does-not-exist-query?marker=query-marker-t13`, {
        headers: { 'X-Correlation-Id': 'corr-t13-query' },
      });
      expect(res.status).toBe(404);

      const line = await capture.waitFor(
        (l) => l.correlationId === 'corr-t13-query' && l.msg === 'request completed',
      );
      expect(line.req).toEqual({ method: 'GET', url: '/does-not-exist-query' });
      expect(capture.raw()).not.toContain('query-marker-t13');
    });
  });

  describe('probes', () => {
    it('does not write "request completed" for /health/live and /metrics, but still echoes the correlation id', async () => {
      const health = await fetch(`${baseUrl}/health/live`, {
        headers: { 'X-Correlation-Id': 'corr-t13-probe-health' },
      });
      const metrics = await fetch(`${baseUrl}/metrics`, {
        headers: { 'X-Correlation-Id': 'corr-t13-probe-metrics' },
      });
      expect(health.headers.get('x-correlation-id')).toBe('corr-t13-probe-health');
      expect(metrics.headers.get('x-correlation-id')).toBe('corr-t13-probe-metrics');

      await fetch(`${baseUrl}/does-not-exist-after-probe`, {
        headers: { 'X-Correlation-Id': 'corr-t13-after-probe' },
      });
      await capture.waitFor(
        (l) => l.correlationId === 'corr-t13-after-probe' && l.msg === 'request completed',
      );
      await Bun.sleep(100);

      const probeLines = capture
        .lines()
        .filter(
          (l) =>
            l.correlationId === 'corr-t13-probe-health' ||
            l.correlationId === 'corr-t13-probe-metrics',
        );
      expect(probeLines).toEqual([]);
    });
  });

  describe('redaction', () => {
    it('never logs request bodies', async () => {
      const res = await fetch(`${baseUrl}/does-not-exist-post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': 'corr-t13-post' },
        body: JSON.stringify({
          money: { amount: '25.00', currency: 'BRL' },
          secretMarker: 'payload-marker-t13',
        }),
      });
      expect(res.status).toBe(404);

      await capture.waitFor(
        (l) => l.correlationId === 'corr-t13-post' && l.msg === 'request completed',
      );
      expect(capture.raw()).not.toContain('"25.00"');
      expect(capture.raw()).not.toContain('payload-marker-t13');
    });

    it('redacts financial fields at the top level and one level nested', async () => {
      const logger = await app.resolve(PinoLogger);
      const logContext = app.get(LogContext);

      logContext.run({ correlationId: 'corr-sqs-1', messageId: 'msg-1' }, () => {
        logContext.assign({ walletId: 'w-1' });
        logger.info(
          {
            money: { amount: '25.00', currency: 'BRL' },
            payload: { idempotencyKey: 'k', amount: '25.00' },
            entry: { balanceAfter: '75.00' },
          },
          'redaction probe',
        );
      });

      const line = await capture.waitFor((l) => l.msg === 'redaction probe');
      expect(line.correlationId).toBe('corr-sqs-1');
      expect(line.messageId).toBe('msg-1');
      expect(line.walletId).toBe('w-1');
      expect(line.instanceId).toEqual(expect.any(String));
      expect(line.money).toBe('[REDACTED]');
      expect(line.payload).toBe('[REDACTED]');
      expect(line.entry).toEqual({ balanceAfter: '[REDACTED]' });
      expect(capture.raw()).not.toContain('"25.00"');
      expect(capture.raw()).not.toContain('"75.00"');
    });
  });

  describe('LogContext', () => {
    it('adds fields assigned inside the scope only to logs of that scope', async () => {
      const logger = await app.resolve(PinoLogger);
      const logContext = app.get(LogContext);

      logContext.run({ correlationId: 'corr-scope-a' }, () => {
        logContext.assign({ transactionId: 'tx-1', providerId: 'prov-1' });
        logger.info('inside scope a');
      });
      logContext.run({ correlationId: 'corr-scope-b' }, () => {
        logger.info('inside scope b');
      });

      const a = await capture.waitFor((l) => l.msg === 'inside scope a');
      const b = await capture.waitFor((l) => l.msg === 'inside scope b');
      expect(a).toMatchObject({
        correlationId: 'corr-scope-a',
        transactionId: 'tx-1',
        providerId: 'prov-1',
      });
      expect(b.correlationId).toBe('corr-scope-b');
      expect(b).not.toHaveProperty('transactionId');
    });

    it('throws when assign is called outside a scope', () => {
      expect(() => app.get(LogContext).assign({ walletId: 'w-1' })).toThrow(
        'LogContext.assign called outside a log scope',
      );
    });
  });

  describe('GET /metrics', () => {
    it('responds in Prometheus text format with the instance_id label', async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(Registry.PROMETHEUS_CONTENT_TYPE);

      const body = await res.text();
      expect(body).toContain('process_cpu_seconds_total');
      expect(body).toContain('instance_id="');
    });
  });
});
