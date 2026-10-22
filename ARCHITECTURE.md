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

`DomainError` é abstrata e expõe `code: FailureCode` e `action: FailureAction`. As subclasses atuais são `InvalidMoneyError`, `CurrencyMismatchError`, `InvalidTransactionStateError`, `InvalidLedgerEntryError`, `InsufficientFundsError`, `InvalidWalletOpeningError`, `KindNotAllowedError`, `ReferenceRequiredError` e `InvalidWagerTransactionError`. Regras de negócio não lançam exceção para o controller: viram `REJECTED` com o código correspondente. O mapeamento para HTTP (T19) e para ack, retry e DLQ (T22) parte desta classificação.

## Lançamento de ledger (§6.4)

`WalletLedgerEntry` (`src/modules/wallet/domain/wallet-ledger-entry.ts`) é imutável por estrutura: todos os campos são `readonly`, a instância é congelada (`Object.freeze`) e não existe nenhum método de transição. Testes: `test/unit/modules/wallet/domain/wallet-ledger-entry.spec.ts`.

- **`create` valida:** direção `DEBIT`/`CREDIT`; mesma moeda em `money`, `balanceBefore` e `balanceAfter`; `money` estritamente positivo (lançamento de valor zero seria uma operação sem efeito, e essas não geram lançamento); saldos antes e depois não negativos; `createdAt` válido; e `balanceBefore − money = balanceAfter` (débito) ou `balanceBefore + money = balanceAfter` (crédito).
- **`rehydrate` não revalida.** `isBalanced()` nunca lança: moeda misturada ou direção desconhecida contam como desbalanceado, então ela pode ser usada para auditar dados lidos do banco.
- **Erro `InvalidLedgerEntryError` com `INVARIANT_VIOLATION`, e não `CURRENCY_MISMATCH`.** Quem cria lançamentos é a `Wallet`, nunca o cliente. Um lançamento inválido é bug, não payload errado. A moeda errada vinda do cliente é barrada antes, pela `Wallet`, com `CurrencyMismatchError`.
- **`createdAt` com cópia defensiva.** `Date` é mutável mesmo atrás de `readonly`, por isso a entidade guarda uma cópia e o getter também devolve uma cópia. É a única diferença em relação ao esqueleto do §6.4, que expõe `public readonly createdAt: Date`.
- As mesmas regras serão repetidas no schema (T10: `CHECK` de aritmética e de sinal, trigger contra `UPDATE`/`DELETE`), conforme §5.9.

## Aggregate Wallet (§6.2)

`Wallet` (`src/modules/wallet/domain/wallet.ts`) é a única porta de entrada para alterar saldo. Testes: `test/unit/modules/wallet/domain/wallet.spec.ts`.

- **Saldo e ledger consistentes por construção.** `debit`/`credit` montam primeiro o `WalletLedgerEntry` (que valida a aritmética) e só então aplicam `balance = entry.balanceAfter`, `version + 1` e `updatedAt`. Toda validação (moeda, saldo, valor positivo) acontece antes da mutação: um erro deixa saldo, `version` e `updatedAt` intactos. Não existe caminho que altere o saldo sem devolver um lançamento.
- **Abertura com `version 1`, inclusive com saldo inicial.** O contrato de `POST /wallets` (§9) devolve `version: 1` para uma wallet aberta com `1000.00`, e o saldo inicial gera um `CREDIT` da transação `OPENING`. Por isso `open` recebe os ids da transação `OPENING` e do lançamento e devolve `{ wallet, openingEntry }`: a abertura é o estado inicial e não conta como incremento. Saldo zero não gera lançamento. `opening` ausente com saldo positivo, ou presente com saldo zero, é `InvalidWalletOpeningError` (`INVARIANT_VIOLATION`), porque indica bug no caso de uso.
- **Ids e tempo vêm de quem chama** (portas `IdGenerator` e `Clock`). O domínio não gera id nem lê o relógio.
- **Saldo insuficiente lança `InsufficientFundsError`, e `canDebit` permite decidir antes.** A `Wallet` não sabe se o débito é uma aposta ou uma reversão. A política de aplicação (T06) consulta `canDebit` e escolhe o `failureCode`: `INSUFFICIENT_FUNDS` para `BET`, `REVERSAL_INSUFFICIENT_FUNDS` para `ROLLBACK` de `WIN`/`REFUND`. A rejeição de negócio vira `REJECTED` persistido. A exceção da `Wallet` é a última barreira, não o fluxo normal. A mensagem do erro só cita o `walletId`, nunca valores (§12).
- **`version` é o contador de alterações de saldo** e será usado no controle de concorrência (T13). O domínio só garante que ele incrementa exatamente uma vez por lançamento. `rehydrate` não revalida e continua a partir da `version` persistida.

## WagerTransaction e máquina de estados (§6.3)

`WagerTransaction` (`src/modules/wagering/domain/wager-transaction.ts`). Testes: `test/unit/modules/wagering/domain/wager-transaction.spec.ts`.

### Transições

```
            create()
               │
               ▼
           PENDING ──────────────┬──────────────┬──────────────┐
               │                 │              │              │
  markPendingReference()  markProcessed()   reject()        fail()
               │                 │              │              │
               ▼                 ▼              ▼              ▼
     PENDING_REFERENCE ───► PROCESSED       REJECTED        FAILED
       (↺ idempotente)  ───────────────────►    ▲              ▲
                        ────────────────────────┴──────────────┘

  createOpening() ──► PROCESSED (OPENING, interno)
```

| De \ Para | `PENDING_REFERENCE` | `PROCESSED` | `REJECTED` | `FAILED` |
|---|---|---|---|---|
| `PENDING` | ✓ | ✓ | ✓ | ✓ |
| `PENDING_REFERENCE` | no-op (idempotente) | ✓ | ✓ | ✓ |
| `PROCESSED`, `REJECTED`, `FAILED` | `InvalidTransactionStateError` | `InvalidTransactionStateError` | `InvalidTransactionStateError` | `InvalidTransactionStateError` |

Uma transição a partir de estado terminal é erro de programação (`INVARIANT_VIOLATION`) e não altera nada.

### Decisões

- **`create` recebe só transações de provedor e nasce em `PENDING`.** `OPENING` ou um kind desconhecido lançam `KindNotAllowedError` (`KIND_NOT_ALLOWED`). `REFUND` ou `ROLLBACK` sem `referenceExternalTransactionId` (ausente ou vazio) lançam `ReferenceRequiredError` (`REFERENCE_REQUIRED`, §7 regra 1). Em `WIN` e `LOSS` a referência é opcional (o §7 diz que o `WIN` "pode referenciar" a `BET`). Uma referência vazia é normalizada para `undefined`.
- **`money > 0` exigido em `create` para `BET`, `WIN`, `REFUND` e `ROLLBACK`** (`InvalidMoneyError`, `INVALID_MONEY`). O motivo é que o ledger recusa lançamento de valor zero. `LOSS` aceita `0.00`, porque só registra o resultado.
- **`createOpening` é o único caminho para criar um `OPENING`.** Ele nasce em `PROCESSED` com `balanceAfter = money`. Os campos sintéticos (provider, ids externos, rodada) ficam por conta do caso de uso que cria a wallet.
- **`balanceAfter` é o saldo observado na decisão, devolvido no replay (§7 regra 7).** `markProcessed` o recebe sempre. No `LOSS` ele é o saldo inalterado. `reject(code, balanceAfter | null)` também o recebe. O valor `null` serve para quando não há saldo que possa ser exposto: wallet inexistente, wallet de outro player (expor o saldo vazaria dado de terceiro) ou wallet de outra moeda. Em ambos os casos, saldo de outra moeda ou negativo é `InvalidWagerTransactionError`.
- **`markProcessed` exige o `referenceTransactionId` (id interno resolvido) para `REFUND` e `ROLLBACK`.** Em `WIN` ele é opcional.
- **`markPendingReference` vale para qualquer transação que tenha referência,** inclusive um `WIN` que aponta uma `BET` ainda não recebida (§7 regra 8). A partir de `PENDING_REFERENCE` é um no-op, para que o worker possa reavaliar sem tratar um caso especial. Contagem de tentativas e backoff ficam com o worker (§7.1).
- **`reject` só aceita códigos de negócio.** `TRANSIENT_FAILURE` (nada é gravado), `PERMANENT_FAILURE` (vai para `fail`) e `INVARIANT_VIOLATION` (nunca persistido) lançam `InvalidWagerTransactionError`. Pelo mesmo critério, `fail` só aceita `PERMANENT_FAILURE`.
- **`ledgerDirectionFor(reference?)`:** `BET` → `DEBIT`; `WIN`, `REFUND` e `OPENING` → `CREDIT`; `ROLLBACK` → direção inversa da direção da referência (`BET` → `CREDIT`; `WIN`/`REFUND` → `DEBIT`). Lança `InvalidWagerTransactionError` para `LOSS` (não há lançamento), para `ROLLBACK` sem referência e para `ROLLBACK` de `ROLLBACK`, `LOSS` ou `OPENING`. A política da T06 rejeita esses casos com `INVALID_REFERENCE_KIND` antes de chegar aqui, então a exceção é a última barreira.
- `createdAt` e `processedAt` são guardados com cópia defensiva, como na `Wallet` e no ledger. `rehydrate` não revalida nada (aceita inclusive `OPENING`).

## Política de aplicação (§7)

`WagerApplicationPolicy` (`src/modules/wagering/domain/wager-application-policy.ts`) é um serviço de domínio puro e sem estado, que implementa as regras de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. Testes: `test/unit/modules/wagering/domain/wager-application-policy.spec.ts`.

- **Entrada e saída.** `apply({ transaction, wallet, reference, reversalsOfReference, ledgerEntryId, at })` recebe tudo já carregado (sem I/O). A transação precisa estar em `PENDING` ou `PENDING_REFERENCE`. A política executa as transições na `Wallet` e na `WagerTransaction` e devolve um resultado. O caso de uso (T16) e o worker de `PENDING_REFERENCE` (T24) só carregam as entradas e persistem o que volta. Ids (`ledgerEntryId`) e tempo (`at`) vêm de quem chama.
- **Nada é alterado antes da decisão.** Todas as checagens vêm antes de qualquer mutação, então uma rejeição nunca deixa saldo, `version` ou lançamento para trás.
- **Rejeição de negócio é resultado, não exceção.** Só erros de programação lançam.

### Resultado

| `decision` | Status da transação | Lançamento no ledger |
|---|---|---|
| `APPLIED` | `PROCESSED` | 1 (`DEBIT` ou `CREDIT`) |
| `RECORDED` (`LOSS`) | `PROCESSED` | nenhum, saldo e `version` intactos |
| `REJECTED` (`failureCode`) | `REJECTED` | nenhum |
| `AWAITING_REFERENCE` | `PENDING_REFERENCE` | nenhum |

O `decision` é o que o T16 usa para escolher os eventos de integração (T08).

### Ordem das checagens

A primeira que falha decide.

0. Erros de programação, que lançam sem mutar nada: transação terminal (`InvalidTransactionStateError`), `REFUND`/`ROLLBACK` reidratado sem `referenceExternalTransactionId`, wallet que não é a da transação e referência resolvida para outro id externo (`InvalidWagerTransactionError`). A terminal vem primeiro: do contrário a wallet seria movimentada e o `markProcessed` lançaria depois. Um segundo `apply` numa transação já decidida nunca reaplica nada.
1. Wallet inexistente: `WALLET_NOT_FOUND`.
2. Wallet de outro player: `WALLET_PLAYER_MISMATCH`.
3. Wallet de outra moeda: `CURRENCY_MISMATCH`. As rejeições 1 a 3 não expõem saldo (`balanceAfter` indefinido); a partir da 4 a rejeição carrega o saldo da wallet.
4. Se a transação tem `referenceExternalTransactionId`:
   1. kind que não referencia nada (`BET`): `INVALID_REFERENCE_KIND`, mesmo que a referência não exista;
   2. referência não encontrada: `AWAITING_REFERENCE` (regra 8);
   3. provider, player, wallet, moeda ou rodada diferentes: `REFERENCE_MISMATCH` (regra 2);
   4. kind da referência fora do permitido (`REFUND` → `BET`; `ROLLBACK` → `BET`/`WIN`/`REFUND`; `WIN` e `LOSS` → `BET`): `INVALID_REFERENCE_KIND` (regra 3);
   5. referência `PENDING` ou `PENDING_REFERENCE`: `AWAITING_REFERENCE`; referência `REJECTED` ou `FAILED`: `REFERENCE_NOT_PROCESSED`;
   6. só `REFUND`/`ROLLBACK`: valor diferente do da referência: `REFERENCE_AMOUNT_MISMATCH` (regra 5);
   7. só `REFUND`/`ROLLBACK`: reversão já feita: `ALREADY_REVERSED` (regra 4).
5. `LOSS`: `PROCESSED` com o saldo atual, sem lançamento.
6. Débito sem saldo: `REVERSAL_INSUFFICIENT_FUNDS` para `ROLLBACK`, `INSUFFICIENT_FUNDS` para `BET` (regra 9). Crédito nunca depende de saldo.
7. Lançamento via `Wallet.debit`/`credit` e `markProcessed` com o saldo resultante. A direção vem de `ledgerDirectionFor` (o `ROLLBACK` inverte a da referência).

### Interpretações adotadas

- **Referência ainda em `PENDING` ou `PENDING_REFERENCE` espera.** Ela ainda pode ser processada, então a transação vira `PENDING_REFERENCE` e o worker reavalia. Referência que terminou `REJECTED`/`FAILED` não tem efeito a reverter: `REFERENCE_NOT_PROCESSED`, sem espera.
- **Moeda da referência diferente da da transação é `REFERENCE_MISMATCH`.** `CURRENCY_MISMATCH` fica para a moeda da wallet.
- **`WIN` e `LOSS` com referência** (o §7 diz que o `WIN` "pode referenciar" a `BET`) passam pelas checagens 4.2 a 4.5 (existência, origem, kind e status da referência) e pulam valor e reversão: o prêmio não precisa ter o valor da aposta, e uma `BET` já estornada não impede o registro do resultado. A referência resolvida é gravada em `referenceTransactionId`. Sem `referenceExternalTransactionId`, qualquer referência entregue é ignorada.
- **`BET` com `referenceExternalTransactionId` é rejeitada com `INVALID_REFERENCE_KIND`,** antes de procurar a referência: uma aposta não aponta nenhuma transação.
- **Reversão única, mais estrita que a letra do §7 regra 4.** Numa `BET`, `REFUND` e `ROLLBACK` se excluem: qualquer um dos dois em `PROCESSED` bloqueia o outro, porque os dois creditam o valor da aposta e a regra "por tipo" permitiria crédito em dobro, o que o §3 proíbe. Em referência `WIN` ou `REFUND` só um segundo `ROLLBACK` é bloqueado. Reversões `REJECTED` e os `WIN`/`LOSS` que apontam a `BET` nunca bloqueiam. A política ignora a própria transação na lista recebida.
- **Fora do escopo desta política:** o lookup de idempotência e o replay (T07/T16), a resolução da referência e a listagem das reversões (I/O no T16), o esgotamento de `PENDING_REFERENCE` (`REFERENCE_NOT_FOUND`, T24, que chama `reject` direto) e os eventos (T08/T16).
- **Nota para o T10:** o índice único parcial por tipo de reversão não cobre a exclusão entre `REFUND` e `ROLLBACK` da mesma `BET`. Para que a garantia valha sob concorrência entre instâncias (§5.9), o schema precisa de uma guarda adicional (por exemplo, um índice único parcial sobre `referenceTransactionId` das reversões `PROCESSED` de `BET`). Nenhum trabalho de schema foi feito aqui.

## Idempotência: `payloadHash` (§9)

Funções puras, sem I/O: `canonicalJson` em `src/shared/domain/canonical-json.ts`; `wagerPayloadHash`, `defaultIdempotencyKey` e o tipo `WagerPayload` em `src/modules/wagering/application/payload-hash.ts`. Testes: `test/unit/shared/domain/canonical-json.spec.ts` e `test/unit/modules/wagering/application/payload-hash.spec.ts`. O mesmo caso de uso (T16) chama as funções para HTTP e para SQS.

- **Key.** A fonte da verdade é o header `Idempotency-Key`, obrigatório no HTTP. O formato recomendado é `{providerId}:{externalTransactionId}`, calculado por `defaultIdempotencyKey` (também é o fallback da entrada SQS se `data.idempotencyKey` faltar, a confirmar na T22). A key identifica a requisição; o `payloadHash` decide se uma repetição é replay (mesmo hash) ou conflito (hash diferente, `IDEMPOTENCY_CONFLICT`) via `WagerTransaction.matchesPayload`.
- **Campos que entram no hash:** `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money` (`{ amount, currency }`) e `referenceExternalTransactionId`. O subconjunto é montado campo a campo, sem spread da entrada, então campos extras nunca entram.
- **O que não entra:** o header `Idempotency-Key`, o campo `idempotencyKey` do corpo, o envelope SQS (`messageId`, `type`, `occurredAt`), `correlationId` e qualquer outro header ou metadado de transporte. O mesmo pedido enviado por HTTP ou por SQS gera o mesmo hash.
- **Regras de canonicalização:** chaves ordenadas recursivamente por unidade de código UTF-16 (a ordem padrão de `Array.prototype.sort`, a mesma da RFC 8785); sem espaços; arrays mantêm a ordem; valores `undefined` de objeto são omitidos; `referenceExternalTransactionId` vazio equivale a ausente; strings escapadas como em `JSON.stringify`; **números são proibidos** (`CanonicalJsonError`, `INVARIANT_VIOLATION`), assim dinheiro nunca entra como float. `money` entra como `{ "amount": "25.00", "currency": "BRL" }`, pela string de 2 casas de `Money.toJSON()`. Nenhuma normalização de texto (trim, caixa): os campos são hasheados exatamente como chegam, depois da validação na borda.
- **Hash:** SHA-256 sobre os bytes UTF-8 do JSON canônico, em hexadecimal minúsculo (64 caracteres), via `node:crypto` (só na camada `application/`; o `domain/` não importa módulos `node:`).
- **Exemplo (BET do §9):** o JSON canônico abaixo gera `629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344`. O teste fixa esse valor (golden), então uma mudança acidental no algoritmo quebra a suíte.

  ```
  {"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}
  ```

- **Contrato versionado.** O hash fica gravado em `payloadHash` de cada transação. Mudar a lista de campos ou as regras de canonicalização muda o hash de toda requisição repetida, e as já gravadas passariam a dar falso conflito. Regras novas exigiriam uma nova versão do hash (coluna ou prefixo), nunca uma edição desta.
- **Fora do escopo desta função:** consulta pela key, decisão replay x conflito e a corrida na unique constraint (T16); DTOs zod e parsing do header (T19); envelope SQS (T22). `canonicalJson` fica em `shared/domain` para que o `toJSON` dos eventos (T08) possa reaproveitá-lo.
