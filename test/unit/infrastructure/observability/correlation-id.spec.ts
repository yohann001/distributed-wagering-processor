import { describe, expect, it } from 'bun:test';

import { resolveCorrelationId } from '../../../../src/infrastructure/observability/correlation-id';

const generate = (): string => 'generated';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveCorrelationId: valid header', () => {
  it('returns a valid header as is', () => {
    expect(resolveCorrelationId('corr-123', generate)).toBe('corr-123');
  });

  it('accepts every allowed character', () => {
    expect(resolveCorrelationId('Az09._:-', generate)).toBe('Az09._:-');
  });

  it('accepts exactly 128 characters', () => {
    const id = 'a'.repeat(128);
    expect(resolveCorrelationId(id, generate)).toBe(id);
  });
});

describe('resolveCorrelationId: invalid header is replaced', () => {
  it('rejects 129 characters', () => {
    expect(resolveCorrelationId('a'.repeat(129), generate)).toBe('generated');
  });

  it.each([
    ['empty string', ''],
    ['space', 'a b'],
    ['newline', 'a\nb'],
    ['quotes', '"x"'],
  ])('rejects %s', (_label, value) => {
    expect(resolveCorrelationId(value, generate)).toBe('generated');
  });

  it('rejects a repeated header (array)', () => {
    expect(resolveCorrelationId(['a', 'b'], generate)).toBe('generated');
  });

  it('generates when the header is absent', () => {
    expect(resolveCorrelationId(undefined, generate)).toBe('generated');
  });
});

describe('resolveCorrelationId: default generator', () => {
  it('generates a UUIDv7', () => {
    expect(resolveCorrelationId(undefined)).toMatch(UUID_V7);
  });

  it('generates a different id on each call', () => {
    expect(resolveCorrelationId(undefined)).not.toBe(resolveCorrelationId(undefined));
  });
});
