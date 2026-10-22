import { describe, expect, it } from 'bun:test';

import {
  canonicalJson,
  CanonicalJsonError,
  type CanonicalJsonValue,
} from '../../../../src/shared/domain/canonical-json';
import { DomainError } from '../../../../src/shared/domain/domain-error';
import { Money } from '../../../../src/shared/domain/money';

const forbidden = (value: unknown): CanonicalJsonValue => value as unknown as CanonicalJsonValue;

class Wrapper {
  readonly value = 'x';
}

describe('canonicalJson: key order', () => {
  it('gives the same output for keys in a different order at depth 1', () => {
    expect(canonicalJson({ a: 'x', b: 'y', c: 'z' })).toBe(canonicalJson({ c: 'z', a: 'x', b: 'y' }));
  });

  it('gives the same output for keys in a different order at depth 2', () => {
    const first = { money: { amount: '25.00', currency: 'BRL' }, kind: 'BET' };
    const second = { kind: 'BET', money: { currency: 'BRL', amount: '25.00' } };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('sorts keys by UTF-16 code unit, so uppercase comes before lowercase', () => {
    expect(canonicalJson({ a: 'x', B: 'y', _: 'z' })).toBe('{"B":"y","_":"z","a":"x"}');
  });

  it('sorts keys inside objects nested in arrays', () => {
    expect(canonicalJson({ list: [{ b: 'x', a: 'y' }] })).toBe('{"list":[{"a":"y","b":"x"}]}');
  });
});

describe('canonicalJson: structure', () => {
  it('keeps the order of array items', () => {
    expect(canonicalJson(['b', 'a', 'c'])).toBe('["b","a","c"]');
    expect(canonicalJson(['b', 'a'])).not.toBe(canonicalJson(['a', 'b']));
  });

  it('serializes nested arrays', () => {
    expect(canonicalJson([['a'], [], [['b']]])).toBe('[["a"],[],[["b"]]]');
  });

  it('serializes empty object and empty array', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('serializes null, booleans and strings at the top level', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson('text')).toBe('"text"');
  });

  it('omits object values that are undefined', () => {
    expect(canonicalJson({ a: 'x', b: undefined })).toBe('{"a":"x"}');
    expect(canonicalJson({ a: 'x', b: undefined })).toBe(canonicalJson({ a: 'x' }));
  });

  it('keeps null object values', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('accepts objects without a prototype', () => {
    const bare = Object.assign(Object.create(null) as Record<string, string>, { b: '2', a: '1' });
    expect(canonicalJson(bare)).toBe('{"a":"1","b":"2"}');
  });

  it('emits no whitespace and the exact expected string for a sample', () => {
    const sample = {
      providerId: 'provider-a',
      money: { currency: 'BRL', amount: '25.00' },
      tags: ['a', { z: true, y: null }],
      note: undefined,
    };
    expect(canonicalJson(sample)).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"},"providerId":"provider-a","tags":["a",{"y":null,"z":true}]}',
    );
  });
});

describe('canonicalJson: string escaping', () => {
  it.each([
    ['quotes', 'say "hi"'],
    ['backslash', 'C:\\temp\\file'],
    ['unicode', 'ação 日本語 😀'],
    ['control characters', 'line1\nline2\ttab\u0000\u001f'],
    ['empty', ''],
  ])('escapes %s exactly like JSON.stringify', (_label, text) => {
    expect(canonicalJson(text)).toBe(JSON.stringify(text));
    expect(canonicalJson({ [text]: text })).toBe(`{${JSON.stringify(text)}:${JSON.stringify(text)}}`);
  });
});

describe('canonicalJson: rejected values', () => {
  it.each([
    ['a number', 42, 'number at $'],
    ['NaN', Number.NaN, 'number at $'],
    ['undefined at the top level', undefined, 'undefined at $'],
    ['a function', () => 'x', 'function at $'],
    ['a symbol', Symbol('s'), 'symbol at $'],
    ['a bigint', 10n, 'bigint at $'],
    ['a Date', new Date('2026-10-21T12:00:00.000Z'), 'Date at $'],
    ['a class instance', new Wrapper(), 'Wrapper at $'],
    ['a Money instance', Money.from({ amount: '25.00', currency: 'BRL' }), 'Money at $'],
    ['a Map', new Map<string, string>(), 'Map at $'],
  ])('throws on %s', (_label, value, location) => {
    let error: unknown;
    try {
      canonicalJson(forbidden(value));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CanonicalJsonError);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as CanonicalJsonError).message).toBe(`Value is not canonical JSON: ${location}`);
    expect<string>((error as CanonicalJsonError).code).toBe('INVARIANT_VIOLATION');
  });

  it('names the path of a number nested in an object', () => {
    expect(() => canonicalJson({ money: { amount: forbidden(25) } })).toThrow(
      'number at $.money.amount',
    );
  });

  it('throws on undefined inside an array and names the index', () => {
    expect(() => canonicalJson(['a', forbidden(undefined)])).toThrow('undefined at $[1]');
  });

  it('throws on a hole in a sparse array', () => {
    const sparse = new Array<string>(3);
    sparse[0] = 'a';
    sparse[2] = 'c';
    expect(() => canonicalJson(sparse)).toThrow('undefined at $[1]');
  });

  it('never includes the offending value in the message', () => {
    let error: unknown;
    try {
      canonicalJson({ amount: forbidden(987654.32) });
    } catch (e) {
      error = e;
    }
    expect((error as CanonicalJsonError).message).not.toContain('987654');
  });
});
