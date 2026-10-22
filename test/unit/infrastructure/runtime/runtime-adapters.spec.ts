import { describe, expect, it } from 'bun:test';

import { SystemClock } from '../../../../src/infrastructure/runtime/system-clock';
import { UuidV7IdGenerator } from '../../../../src/infrastructure/runtime/uuidv7-id-generator';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('SystemClock', () => {
  it('returns the current instant as a valid Date', () => {
    const before = Date.now();
    const now = new SystemClock().now();
    const after = Date.now();

    expect(now).toBeInstanceOf(Date);
    expect(Number.isNaN(now.getTime())).toBe(false);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('UuidV7IdGenerator', () => {
  it('returns UUIDv7 strings', () => {
    expect(new UuidV7IdGenerator().next()).toMatch(UUID_V7);
  });

  it('returns a different id on every call', () => {
    const generator = new UuidV7IdGenerator();

    expect(generator.next()).not.toBe(generator.next());
  });
});
