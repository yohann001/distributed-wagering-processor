/** Nome do header de entrada em minúsculas, como o Node entrega. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const CORRELATION_ID_RESPONSE_HEADER = 'X-Correlation-Id';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Devolve o header quando é um id válido; caso contrário, gera um UUIDv7.
 *
 * Valor inválido é substituído, não rejeitado com 400: o id é metadado de diagnóstico e não pode
 * derrubar uma requisição financeira. O padrão barra injeção em log (quebra de linha, aspas) e
 * tamanho ilimitado. Header repetido (array) também é descartado.
 */
export function resolveCorrelationId(
  header: string | string[] | undefined,
  generate: () => string = () => Bun.randomUUIDv7(),
): string {
  if (typeof header === 'string' && CORRELATION_ID_PATTERN.test(header)) {
    return header;
  }
  return generate();
}
