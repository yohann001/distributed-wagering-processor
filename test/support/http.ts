import { expect } from 'bun:test';

import type { MoneyProps } from '../../src/shared/domain/money';

export interface HttpResult<T> {
  status: number;
  headers: Headers;
  body: T;
}

async function toResult<T>(response: Response): Promise<HttpResult<T>> {
  return { status: response.status, headers: response.headers, body: (await response.json()) as T };
}

export async function getJson<T>(baseUrl: string, path: string): Promise<HttpResult<T>> {
  return toResult<T>(await fetch(`${baseUrl}${path}`));
}

export async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult<T>> {
  return postRaw<T>(baseUrl, path, JSON.stringify(body), headers);
}

/** Corpo enviado como texto, sem passar por `JSON.stringify`: para JSON malformado. */
export async function postRaw<T>(
  baseUrl: string,
  path: string,
  rawText: string,
  headers: Record<string, string> = {},
): Promise<HttpResult<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawText,
  });
  return toResult<T>(response);
}

/** O valor monetário da resposta é `{ amount: string, currency }`, nunca um número JSON. */
export function expectMoney(value: unknown, amount: string, currency = 'BRL'): void {
  const money = value as MoneyProps;
  expect(typeof money.amount).toBe('string');
  expect(money).toEqual({ amount, currency });
}
