import { IdGenerator } from '../../shared/application/id-generator';

export class UuidV7IdGenerator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
