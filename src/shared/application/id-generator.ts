/** Ids de domínio (UUIDv7). Porta para que testes possam fixar os ids. */
export abstract class IdGenerator {
  abstract next(): string;
}
