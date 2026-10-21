# Arquitetura — Distributed Wagering Processor

Este documento é preenchido task a task e consolidado no T33.

## Taxonomia de FailureCode (§7.2)

Cada falha de negócio ou de infraestrutura tem um `FailureCode` estável e legível por máquina. Os valores são contrato público (persistidos em `failureCode` e expostos nas respostas): nunca renomear nem reutilizar, só adicionar. Fonte: `src/shared/domain/failure-code.ts`. Testes: `test/unit/shared/domain/failure-code.spec.ts`.

### Classificações

| Classificação | Significado |
|---|---|
| `RETRY` | Reenviar o mesmo request, com a mesma key, pode dar certo. |
| `FIX_PAYLOAD` | Request inválido ou inconsistente. Corrigir e enviar com **nova** key, porque a mesma key devolve o resultado gravado ou conflito. |
| `GIVE_UP` | Resultado terminal de negócio ou falha permanente. Não reenviar. |

A classificação é sobre reenviar **aquele** request. Por idempotência, reenviar a mesma key de uma transação `REJECTED` devolve o mesmo `REJECTED`.

### Códigos

| Código | Classificação | Quando ocorre | Onde aparece |
|---|---|---|---|
| `INVALID_PAYLOAD` | `FIX_PAYLOAD` | Payload ou envelope fora do contrato (zod na borda, envelope SQS). | Resposta síncrona |
| `INVALID_MONEY` | `FIX_PAYLOAD` | `amount` ou `currency` fora do formato (§6.1). | Resposta síncrona |
| `CURRENCY_MISMATCH` | `FIX_PAYLOAD` | Moeda da operação difere da wallet ou da referência. | `REJECTED` persistido |
| `KIND_NOT_ALLOWED` | `FIX_PAYLOAD` | `kind` interno (`OPENING`) submetido por API ou fila. | Resposta síncrona |
| `REFERENCE_REQUIRED` | `FIX_PAYLOAD` | `REFUND` ou `ROLLBACK` sem `referenceExternalTransactionId` (§7 regra 1). | Resposta síncrona |
| `IDEMPOTENCY_CONFLICT` | `FIX_PAYLOAD` | Mesma idempotency key com `payloadHash` diferente (§9). | Resposta síncrona |
| `WALLET_NOT_FOUND` | `FIX_PAYLOAD` | `walletId` inexistente. | `REJECTED` persistido |
| `WALLET_PLAYER_MISMATCH` | `FIX_PAYLOAD` | A wallet pertence a outro `playerId`. | `REJECTED` persistido |
| `WALLET_ALREADY_EXISTS` | `GIVE_UP` | Já existe wallet para `playerId + currency` (§6.2). | Resposta síncrona |
| `INSUFFICIENT_FUNDS` | `GIVE_UP` | `BET` maior que o saldo. | `REJECTED` persistido |
| `REVERSAL_INSUFFICIENT_FUNDS` | `GIVE_UP` | Reversão (`ROLLBACK` de `WIN`/`REFUND`) deixaria o saldo negativo (§7 regra 9). Exige ação operacional, por isso é distinto de `INSUFFICIENT_FUNDS`. | `REJECTED` persistido |
| `REFERENCE_NOT_FOUND` | `FIX_PAYLOAD` | A referência não chegou dentro do limite de `PENDING_REFERENCE` (§7.1). Corrigir o id ou enviar a original antes e reenviar a reversão com nova key. | `REJECTED` persistido |
| `REFERENCE_MISMATCH` | `FIX_PAYLOAD` | Referência de outro provider, player, wallet, moeda ou rodada (§7 regra 2). | `REJECTED` persistido |
| `INVALID_REFERENCE_KIND` | `FIX_PAYLOAD` | `REFUND` que não aponta `BET`, ou `ROLLBACK` que não aponta `BET`/`WIN`/`REFUND` (§7 regra 3). | `REJECTED` persistido |
| `REFERENCE_AMOUNT_MISMATCH` | `FIX_PAYLOAD` | Valor diferente do da referência (§7 regra 5). | `REJECTED` persistido |
| `REFERENCE_NOT_PROCESSED` | `GIVE_UP` | A referência existe mas terminou `REJECTED` ou `FAILED`: não há efeito a reverter. | `REJECTED` persistido |
| `ALREADY_REVERSED` | `GIVE_UP` | Referência já revertida pelo mesmo tipo de operação (§7 regra 4). | `REJECTED` persistido |
| `TRANSIENT_FAILURE` | `RETRY` | Infraestrutura indisponível ou conflito de concorrência esgotado (banco fora, timeout, deadlock, serialization). Nada foi gravado. | Resposta síncrona; a mensagem volta para a fila |
| `PERMANENT_FAILURE` | `GIVE_UP` | Erro de infraestrutura irrecuperável, registrado para auditoria (§6.3). | `FAILED` persistido |
| `INVARIANT_VIOLATION` | `GIVE_UP` | Erro de programação, como `InvalidTransactionStateError` (transição a partir de estado terminal). Nunca persistido como `failureCode`. | Resposta síncrona (erro interno) |

### Hierarquia de erros

`DomainError` é abstrata e expõe `code: FailureCode` e `action: FailureAction`. As subclasses atuais são `InvalidMoneyError`, `CurrencyMismatchError` e `InvalidTransactionStateError`. Regras de negócio não lançam exceção para o controller: viram `REJECTED` com o código correspondente. O mapeamento para HTTP (T19) e para ack, retry e DLQ (T22) parte desta classificação.
