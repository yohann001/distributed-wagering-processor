/** Fonte de tempo dos casos de uso: o domínio nunca lê o relógio (testes determinísticos). */
export abstract class Clock {
  abstract now(): Date;
}
