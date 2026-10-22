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

## Dinheiro: `Money` (§6.1)

`Money` (`src/shared/domain/money.ts`) guarda o valor como `decimal.js` (precisão 64, escala fixa de 2) e só entra no sistema pelo parser estrito `Money.from`. Testes: `test/unit/shared/domain/money.spec.ts`.

- **Teto de 16 dígitos inteiros.** O `amount` aceito vai de `0.00` a `9999999999999999.99`. O limite casa com a coluna `numeric(18,2)` do T10 (16 inteiros + 2 casas), então nada que o domínio aceite estoura o schema. A precisão 64 continua, mas agora com folga garantida: nenhuma soma ou subtração chega a arredondar em silêncio.
- **O teto vale para o resultado, não só para a entrada.** `Money.of` (o único ponto de construção, usado por `from`, `zero`, `add`, `subtract` e `negate`) lança `InvalidMoneyError` (`INVALID_MONEY`) se o valor absoluto chegar a 10^16. Vale também para negativos. A mensagem não traz o valor (§12).
- **Efeito na wallet.** Um crédito que estoure o saldo lança `InvalidMoneyError` antes de qualquer mutação, porque `Wallet.apply` calcula o `balanceAfter` antes de alterar o estado. Na prática o estouro é erro de payload (`FIX_PAYLOAD`), não um estado que a wallet chegue a assumir.

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
- **`open` valida a identidade e a data.** `id` e `playerId` precisam ser texto não vazio (depois de `trim`) e `openedAt` uma data válida; senão lança `InvalidWalletOpeningError` (erro de programação, a borda T19 valida com zod antes). Isso vale também para saldo zero, caso em que nenhum lançamento validaria a data. `rehydrate` continua sem validar.
- **Saldo insuficiente lança `InsufficientFundsError`, e `canDebit` permite decidir antes.** A `Wallet` não sabe se o débito é uma aposta ou uma reversão. A política de aplicação (T06) consulta `canDebit` e escolhe o `failureCode`: `INSUFFICIENT_FUNDS` para `BET`, `REVERSAL_INSUFFICIENT_FUNDS` para `ROLLBACK` de `WIN`/`REFUND`. A rejeição de negócio vira `REJECTED` persistido. A exceção da `Wallet` é a última barreira, não o fluxo normal. A mensagem do erro só cita o `walletId`, nunca valores (§12).
- **`lastLedgerEntryId`.** A `Wallet` guarda, fora do `WalletState`, o id do último lançamento que ela mesma aplicou (o de abertura em `open` com saldo, e o de cada `debit`/`credit` bem-sucedido). Em `open` com saldo zero e em wallet reidratada sem movimento é `undefined`. Serve para o `WalletBalanceChanged.from` provar que o lançamento recebido é o mais recente da instância (T08).
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
- **`reject` só aceita os 11 códigos "REJECTED persistido"** da tabela de códigos: `CURRENCY_MISMATCH`, `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`, `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_NOT_PROCESSED` e `ALREADY_REVERSED`. Qualquer outro lança `InvalidWagerTransactionError`: os de resposta síncrona (`INVALID_PAYLOAD`, `INVALID_MONEY`, `KIND_NOT_ALLOWED`, `REFERENCE_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS`) nunca viram estado da transação, `TRANSIENT_FAILURE` não grava nada, `PERMANENT_FAILURE` vai para `fail` e `INVARIANT_VIOLATION` nunca é persistido. Pelo mesmo critério, `fail` só aceita `PERMANENT_FAILURE`.
- **`ledgerDirectionFor(reference?)`:** `BET` → `DEBIT`; `WIN`, `REFUND` e `OPENING` → `CREDIT`; `ROLLBACK` → direção inversa da direção da referência (`BET` → `CREDIT`; `WIN`/`REFUND` → `DEBIT`). Lança `InvalidWagerTransactionError` para `LOSS` (não há lançamento), para `ROLLBACK` sem referência e para `ROLLBACK` de `ROLLBACK`, `LOSS` ou `OPENING`. A política da T06 rejeita esses casos com `INVALID_REFERENCE_KIND` antes de chegar aqui, então a exceção é a última barreira.
- **`create` e `createOpening` validam os campos obrigatórios** (`InvalidWagerTransactionError`, erro de programação, porque a borda T19/T22 valida com zod antes): `id`, `providerId`, `externalTransactionId`, `idempotencyKey`, `payloadHash`, `walletId`, `playerId`, `roundId` e `gameId` não podem ser vazios nem só espaços, e `createdAt` precisa ser uma data válida. Uma referência `''` continua normalizada para `undefined` (contrato do payload hash), mas uma referência só com espaços é recusada (`referenceExternalTransactionId must not be blank`). As mensagens citam só o nome do campo. `rehydrate` continua sem validar.
- `createdAt` e `processedAt` são guardados com cópia defensiva, como na `Wallet` e no ledger. `rehydrate` não revalida nada (aceita inclusive `OPENING`).

## Política de aplicação (§7)

`WagerApplicationPolicy` (`src/modules/wagering/domain/wager-application-policy.ts`) é um serviço de domínio puro e sem estado, que implementa as regras de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. Testes: `test/unit/modules/wagering/domain/wager-application-policy.spec.ts`.

- **Entrada e saída.** `apply({ transaction, wallet, reference, reversalsOfReference, ledgerEntryId, at })` recebe tudo já carregado (sem I/O). A transação precisa estar em `PENDING` ou `PENDING_REFERENCE` e ter um kind submetível (`WagerTransaction.isSubmittableKind`): terminal, status desconhecido (dado reidratado) e `OPENING` são erro de programação e lançam antes de qualquer mutação (`InvalidTransactionStateError` ou `InvalidWagerTransactionError`). A política executa as transições na `Wallet` e na `WagerTransaction` e devolve um resultado. O caso de uso (T16) e o worker de `PENDING_REFERENCE` (T24) só carregam as entradas e persistem o que volta. Ids (`ledgerEntryId`) e tempo (`at`) vêm de quem chama.
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
- **Reversão única, mais estrita que a letra do §7 regra 4.** Numa `BET`, `REFUND` e `ROLLBACK` se excluem: qualquer um dos dois em `PROCESSED` bloqueia o outro, porque os dois creditam o valor da aposta e a regra "por tipo" permitiria crédito em dobro, o que o §3 proíbe. Em referência `WIN` ou `REFUND` só um segundo `ROLLBACK` é bloqueado. Reversões `REJECTED` e os `WIN`/`LOSS` que apontam a `BET` nunca bloqueiam. A política ignora a própria transação na lista recebida e também os itens que não apontam para a referência (`referenceTransactionId` diferente do id dela).
- **Fora do escopo desta política:** o lookup de idempotência e o replay (T07/T16), a resolução da referência e a listagem das reversões (I/O no T16), o esgotamento de `PENDING_REFERENCE` (`REFERENCE_NOT_FOUND`, T24, que chama `reject` direto) e os eventos (T08/T16).
- **Nota para o T10:** um índice único parcial por tipo de reversão não cobre a exclusão entre `REFUND` e `ROLLBACK` da mesma `BET`. Basta um índice só, `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`: como `REFUND` só aponta `BET` e só `ROLLBACK` aponta `WIN`/`REFUND`, ele reproduz exatamente a regra desta política sob concorrência entre instâncias (§5.9). Nenhum trabalho de schema foi feito aqui. Implementado na T10 (`wager_transactions_single_reversal_uq`).

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
- **Fora do escopo desta função:** consulta pela key, decisão replay x conflito e a corrida na unique constraint (T16); DTOs zod e parsing do header (T19); envelope SQS (T22). `canonicalJson` fica em `shared/domain` por ser transversal; o `toJSON` dos eventos (T08) não o usa, porque o envelope tem números (ver "Eventos de integração").

## Eventos de integração (§11)

Classes puras de domínio, sem I/O. Envelope: `IntegrationEvent<T>` e `EventContext` em `src/shared/domain/integration-event.ts`. Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected` e `WagerTransactionPendingReference` em `src/modules/wagering/domain/wager-transaction-events.ts`; `WalletBalanceChanged` em `src/modules/wallet/domain/wallet-balance-changed.ts`. Testes: `test/unit/shared/domain/integration-event.spec.ts`, `test/unit/modules/wagering/domain/wager-transaction-events.spec.ts` e `test/unit/modules/wallet/domain/wallet-balance-changed.spec.ts`.

- **Construção só por `from(...)`.** O construtor do envelope é `protected` e o das subclasses é `private`. Cada `from` recebe o objeto de domínio já decidido (`WagerTransaction`, ou `Wallet` mais `WalletLedgerEntry`) e um `EventContext`. `eventType` e `version` ficam no tipo (`readonly eventType = 'WalletBalanceChanged'`, `readonly version = 1`), não numa string solta no call site.
- **`EventContext` vem de quem chama.** `eventId`, `correlationId`, `causationId` (opcional) e `occurredAt` são entregues pelo caso de uso, que é dono das portas `IdGenerator` e `Clock`. O domínio não gera id nem lê o relógio. `occurredAt` tem cópia defensiva, como `createdAt` do ledger.
- **`aggregateId`.** É o `id` da transação nos três eventos de `WagerTransaction*` e o `id` da wallet em `WalletBalanceChanged`. O `walletId` vai sempre em `data`, então o consumidor não precisa inferir a wallet pelo agregado. A unidade de ordenação na publicação (T23) é decisão daquela task.
- **`data` por evento.** Os três eventos de transação carregam `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money` e, quando existe, `referenceExternalTransactionId`. `Processed` soma `balanceAfter` e, quando resolvida, `referenceTransactionId`. `Rejected` soma `failureCode` e `balanceAfter` (ausente quando não há saldo a expor: wallet inexistente, de outro player ou de outra moeda, o mesmo critério do `reject(code, null)`). `PendingReference` exige `referenceExternalTransactionId`. `WalletBalanceChanged` carrega os campos do §11 mais `ledgerEntryId`, para rastrear o evento até o lançamento. `idempotencyKey` e `payloadHash` ficam de fora: são dados internos de deduplicação, não contrato de integração.
- **Dinheiro é sempre `MoneyProps`.** Cada valor é copiado para um literal `{ amount, currency }` a partir de `Money.toJSON()`, então nenhuma instância de `Money` entra em `data` (teste percorre o objeto recursivamente). Os únicos números do envelope são `version` e `walletVersion`, inteiros.
- **JSON estável.** `toJSON()` monta o objeto à mão, com a ordem de chaves fixa `eventId, eventType, aggregateId, correlationId, causationId, occurredAt, version, data`. `causationId` é omitido quando ausente (nunca `undefined` nem `null`) e `occurredAt` é `toISOString()`. Os testes comparam `JSON.stringify(evento)` com uma string escrita à mão (golden), sem `toMatchSnapshot`, então uma mudança acidental de forma quebra a suíte. O `canonicalJson` do payload hash não é reaproveitado: ele proíbe números por desenho, e o envelope tem `version` e `walletVersion`. A estabilidade vem da ordem fixa de chaves escrita no código (não alfabética).
- **Guardas em `from` (`InvalidIntegrationEventError`, `INVARIANT_VIOLATION`).** `Processed` exige transação `PROCESSED` com `balanceAfter` (aceita qualquer kind, inclusive `LOSS` e `OPENING`); `Rejected` exige `REJECTED` com `failureCode`; `PendingReference` exige `PENDING_REFERENCE` com referência; `WalletBalanceChanged` exige lançamento da mesma wallet e que `entry` seja o último lançamento aplicado pela instância (`entry.id == wallet.lastLedgerEntryId`), ou seja, o evento é montado logo após a movimentação, e `walletVersion` corresponde a esse saldo. Comparar só o saldo não bastava: saldos que voltam ao mesmo valor (abrir com 100, creditar 10, debitar 10) deixariam um lançamento antigo passar. O envelope também recusa `eventId`, `aggregateId` ou `correlationId` vazios, `causationId` vazio e `occurredAt` inválido. É erro de programação e as mensagens citam só ids e estado, nunca valores (§12).
- **Imutável por fora.** `data` e os objetos aninhados são congelados (`Object.freeze` recursivo). A instância do evento não é congelada, porque os campos `eventType` e `version` da subclasse são inicializados depois do `super()`.
- **Contrato versionado.** Todos os eventos nascem com `version = 1`. Mudar o formato de `data` exige uma nova `version` (e consumidores que entendam as duas), nunca a edição da existente, porque mensagens antigas ainda estão na outbox ou já foram publicadas.
- **Fora do escopo.** `OutboxMessage.enqueue(event)` e a gravação do payload (T09), a escolha de quais eventos cada caso de uso emite a partir do `decision` da política (T15, T16, T24), o destino e o `MessageGroupId` da publicação (T23) e a desserialização no consumidor.

## Inbox e Outbox (§6.5)

Entidades puras de domínio, sem I/O: `InboxMessage` em `src/modules/messaging/domain/inbox-message.ts`, `OutboxMessage` (e `DEFAULT_OUTBOX_BACKOFF`) em `src/modules/messaging/domain/outbox-message.ts` e `ExponentialBackoff` em `src/shared/domain/exponential-backoff.ts`. Testes: `test/unit/modules/messaging/domain/inbox-message.spec.ts`, `test/unit/modules/messaging/domain/outbox-message.spec.ts` e `test/unit/shared/domain/exponential-backoff.spec.ts`.

- **Chave da inbox.** A deduplicação é por `(consumerName, messageId)`, garantida pela PK no banco (T10). A entidade não deduplica: `receive` só valida `messageId`, `consumerName`, `payloadHash` (não vazios) e `receivedAt` (data válida) e nasce não processada. `matchesPayload(payloadHash)` compara o hash gravado com o de uma nova entrega: o mesmo `messageId` com hash diferente não é duplicata, e o consumer (T22) manda a mensagem para a DLQ.
- **Segunda chamada de `markProcessed`/`markPublished` é erro de programação.** Lança `InvalidInboxMessageError`/`InvalidOutboxMessageError` (`INVARIANT_VIOLATION`, sem retry) e não altera o estado. O mesmo vale para `scheduleRetry` depois de publicada. Motivo: o claim por linha do publisher (T23) faz uma segunda publicação na mesma instância ser bug. A publicação duplicada entre instâncias (o publicador cai entre o envio ao SQS e o commit do `markPublished`) é tratada pela deduplicação do consumidor por `eventId`, não pela entidade.
- **`id` da outbox é o `eventId`.** O consumidor deduplica pelo `eventId`, e o mesmo id na outbox impede enfileirar o mesmo evento duas vezes. `aggregateId`, `eventType` e `occurredAt` são copiados do evento.
- **Payload é a cópia JSON do envelope.** `enqueue` grava `JSON.parse(JSON.stringify(evento))` (`JSON.stringify(outbox.payload) === JSON.stringify(evento)`), congelado em profundidade (`deepFreeze`, agora exportado de `integration-event.ts`). `rehydrate` também recebe uma cópia congelada, para a entidade nunca congelar um objeto que não é dela. A ordem fixa das chaves só chega à fila se a coluna for `json`/`text`: o `jsonb` reordena as chaves (decisão da T10). Consumidores que fazem parse do JSON não são afetados.
- **`nextAttemptAt = occurredAt` no enqueue.** Nunca é nulo: a mensagem já nasce devida e o índice da T10 pode ser um simples `next_attempt_at <= now()` sobre as pendentes. É um desvio do esqueleto do §6.5, que declara `nextAttemptAt` opcional; getter e estado são `Date`.
- **Backoff.** `delay = ceil(min(maxDelayMs, baseDelayMs · 2^(attempt-1)) · (1 − jitterRatio · random))`, com `attempt` a partir de 1. `ceil`, e não `round`: com piso fracionário (ex.: `jitterRatio` 0.3336) o `round` cairia abaixo dele. Padrão (`DEFAULT_OUTBOX_BACKOFF`): 1 s, dobrando até 60 s, com até 50% de jitter. O jitter é subtrativo: o atraso fica em `[capped·(1−jitterRatio), capped]`, então o teto é rígido e o piso também cresce. Tentativas enormes não geram `Infinity` nem `NaN` (`2 ** n` vira `Infinity` e o `Math.min` devolve o teto). Opções ou tentativa inválidas e uma fonte aleatória fora de `[0, 1)` lançam `InvalidBackoffError` (`INVARIANT_VIOLATION`). `maxDelayMs` tem teto de 24 h (`MAX_BACKOFF_DELAY_MS`): um atraso maior que um dia não é backoff, é configuração errada. `OutboxMessage.scheduleRetry` também valida a data resultante (`nextAttemptAt`) antes de alterar `attempts`, porque `now` perto do limite do `Date` somado ao atraso viraria `Invalid Date`.
- **Aleatoriedade injetada.** O domínio não chama `Math.random` nem lê o relógio. O jitter vem de um `RandomSource` entregue ao `ExponentialBackoff` (em produção, `Math.random`), e o tempo chega como argumento. Por isso `scheduleRetry(now, backoff)` tem um parâmetro a mais que o esqueleto do §6.5. O atraso é calculado antes de mutar, então um backoff que lança não deixa `attempts` incrementado.
- **Sem limite de tentativas na outbox.** Evento confirmado nunca é descartado (§3, §11): a outbox tenta para sempre no teto de 60 s. Não existe estado "morto" nela.
- **`ExponentialBackoff` em `shared/domain`.** Reutilizável pelo worker de `PENDING_REFERENCE` (T24), que terá o próprio limite de tentativas.
- **Fora do escopo.** Colunas, índices e migrations de `inbox_messages`/`outbox_messages` (T10); mapeamento ORM e repositórios (T11); publisher, claim com `FOR UPDATE SKIP LOCKED`, `MessageGroupId` e métricas de tentativas/atraso (T23, T25); consumer SQS, fluxo de deduplicação e DLQ (T22); worker de `PENDING_REFERENCE` (T24); valores do backoff configuráveis por env (a T23 pode ligar `DEFAULT_OUTBOX_BACKOFF` ao ambiente); checagem de ordem entre relógios (`processedAt >= receivedAt`, `publishedAt >= occurredAt`), porque o publisher roda em outras instâncias e há defasagem possível.

## Schema e constraints (§5.9)

Migration `src/infrastructure/database/migrations/Migration20261022021041_initial_schema.ts` (reversível: `down()` apaga tudo o que `up()` cria, na ordem inversa). Toda constraint, índice, trigger e função tem nome explícito; os testes da T12 verificam por nome e SQLSTATE.

| Nome | Tabela | Regra | Invariante protegida | § |
|---|---|---|---|---|
| `*_pkey` (`wallets`, `wager_transactions`, `wallet_ledger_entries`, `outbox_messages`) | todas menos `inbox_messages` | PK `uuid` (UUIDv7) | Identidade única; o `id` da outbox é o `eventId` | §6.5 |
| `wallets_balance_non_negative` | `wallets` | `CHECK (balance >= 0)` | Saldo nunca negativo, mesmo sob race | §3, §5.9, §6.2 |
| `wallets_version_positive` | `wallets` | `CHECK (version >= 1)` | `version` começa em 1 | §6.2 |
| `wallets_currency_iso` | `wallets` | `CHECK (currency ~ '^[A-Z]{3}$')` | Mesma regex do `Money` (ISO-4217, três maiúsculas) | §6.1 |
| `wallets_player_currency_uq` | `wallets` | `UNIQUE (player_id, currency)` | No máximo uma wallet por `playerId + currency` | §6.2 |
| `wallets_id_currency_uq` | `wallets` | `UNIQUE (id, currency)` | Alvo da FK composta do ledger (moeda do lançamento = moeda da wallet) | §6.4 |
| `wager_transactions_provider_external_uq` | `wager_transactions` | `UNIQUE (provider_id, external_transaction_id)` | Mesma transação do provedor nunca entra duas vezes | §6.3, §9 |
| `wager_transactions_provider_idempotency_uq` | `wager_transactions` | `UNIQUE (provider_id, idempotency_key)` | Idempotência por provedor: a key nunca é global | §6.3, §9 |
| `wager_transactions_id_wallet_currency_uq` | `wager_transactions` | `UNIQUE (id, wallet_id, currency)` | Alvo da FK composta do ledger (wallet e moeda da transação) | §6.4 |
| `wager_transactions_kind_valid` | `wager_transactions` | `kind IN (OPENING, BET, WIN, LOSS, REFUND, ROLLBACK)` | Só tipos conhecidos | §6.3 |
| `wager_transactions_status_valid` | `wager_transactions` | `status IN (PENDING, PENDING_REFERENCE, PROCESSED, REJECTED, FAILED)` | Só estados da máquina de estados | §6.3 |
| `wager_transactions_opening_processed` | `wager_transactions` | `kind <> 'OPENING' OR status = 'PROCESSED'` | `OPENING` é interno e nasce `PROCESSED` | §6.3 |
| `wager_transactions_currency_iso` | `wager_transactions` | `CHECK (currency ~ '^[A-Z]{3}$')` | Moeda no formato do `Money` | §6.1 |
| `wager_transactions_amount_valid` | `wager_transactions` | `amount > 0 OR (kind = 'LOSS' AND amount = 0)` | Espelha `create`: valor positivo, e `LOSS` pode ser `0.00` | §6.3 |
| `wager_transactions_balance_after_non_negative` | `wager_transactions` | `balance_after IS NULL OR balance_after >= 0` | O saldo observado nunca é negativo | §3, §6.3 |
| `wager_transactions_reversal_requires_reference` | `wager_transactions` | `kind NOT IN (REFUND, ROLLBACK) OR reference_external_transaction_id IS NOT NULL` | Reversão sempre aponta uma referência | §7 regra 1 |
| `wager_transactions_pending_reference_has_reference` | `wager_transactions` | `status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL` | Só espera referência quem tem referência | §7 regra 8 |
| `wager_transactions_processed_complete` | `wager_transactions` | `status <> 'PROCESSED' OR (processed_at IS NOT NULL AND balance_after IS NOT NULL)` | O replay devolve o saldo observado (`PROCESSED` sempre tem os dois) | §7 regra 7 |
| `wager_transactions_processed_reversal_resolved` | `wager_transactions` | `status <> 'PROCESSED' OR kind NOT IN (REFUND, ROLLBACK) OR reference_transaction_id IS NOT NULL` | Reversão processada tem a referência resolvida, o que alimenta o índice de reversão única | §7 regra 4 |
| `wager_transactions_failure_code_by_status` | `wager_transactions` | `(status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)` | `failureCode` presente exatamente nos estados de falha | §6.3, §7.2 |
| `wager_transactions_failed_permanent` | `wager_transactions` | `status <> 'FAILED' OR failure_code = 'PERMANENT_FAILURE'` | `fail` só aceita `PERMANENT_FAILURE` | §6.3 |
| `wager_transactions_reference_not_self` | `wager_transactions` | `reference_transaction_id IS NULL OR reference_transaction_id <> id` | Transação não referencia a si mesma | §7 |
| `wager_transactions_reference_fk` | `wager_transactions` | `FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id)`, `DEFERRABLE INITIALLY DEFERRED` | A referência resolvida existe | §7 regra 2 |
| `wager_transactions_single_reversal_uq` | `wager_transactions` | `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` | Reversão única por referência e exclusão `REFUND`/`ROLLBACK` da mesma `BET`, mesmo entre instâncias (decisão da T06) | §5.9, §7 regra 4 |
| `wager_transactions_pending_reference_idx` | `wager_transactions` | índice `(created_at, id) WHERE status = 'PENDING_REFERENCE'` | O worker acha as pendentes sem varrer a tabela (T24) | §7.1 |
| `wager_transactions_reference_lookup_idx` | `wager_transactions` | índice `(provider_id, reference_external_transaction_id) WHERE reference_external_transaction_id IS NOT NULL` | Listar reversões de uma referência (T16) e acordar dependentes quando a referência chega (T24) | §7 regra 2, §7.1 |
| `wager_transactions_guard` + `wager_transactions_guard_change()` | `wager_transactions` | trigger `BEFORE UPDATE OR DELETE` por linha | Estado terminal não muda, colunas de identidade não mudam, linha nunca é apagada | §6.3 |
| `wager_transactions_no_truncate` | `wager_transactions` | trigger `BEFORE TRUNCATE` | Idem, para `TRUNCATE` | §6.3 |
| `wallet_ledger_entries_transaction_wallet_uq` | `wallet_ledger_entries` | `UNIQUE (transaction_id, wallet_id)` | No máximo um lançamento por transação por wallet: sem débito ou crédito duplicado | §3, §6.4 |
| `wallet_ledger_entries_wallet_seq_uq` | `wallet_ledger_entries` | `UNIQUE (wallet_id, seq)` | Ordem total do ledger por wallet, para paginação (T14) e para a cadeia de `assertWalletConsistent` (T12) | §6.4 |
| `wallet_ledger_entries_direction_valid` | `wallet_ledger_entries` | `direction IN ('DEBIT','CREDIT')` | Só as duas direções | §6.4 |
| `wallet_ledger_entries_amount_positive` | `wallet_ledger_entries` | `CHECK (amount > 0)` | Lançamento de valor zero não existe | §6.4 |
| `wallet_ledger_entries_balances_non_negative` | `wallet_ledger_entries` | `balance_before >= 0 AND balance_after >= 0` | A cadeia de saldos nunca passa por valor negativo | §3, §6.4 |
| `wallet_ledger_entries_balanced` | `wallet_ledger_entries` | `DEBIT: balance_after = balance_before - amount`; `CREDIT: balance_after = balance_before + amount` | Aritmética do lançamento, validada também na factory | §6.4 |
| `wallet_ledger_entries_wallet_fk` | `wallet_ledger_entries` | `FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency)`, `DEFERRABLE INITIALLY DEFERRED` | O lançamento pertence a uma wallet existente, na moeda dela | §6.4 |
| `wallet_ledger_entries_transaction_fk` | `wallet_ledger_entries` | `FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions (id, wallet_id, currency)`, `DEFERRABLE INITIALLY DEFERRED` | O lançamento pertence a uma transação existente, da mesma wallet e moeda | §6.4 |
| `wallet_ledger_entries_append_only` + `wallet_ledger_entries_reject_change()` | `wallet_ledger_entries` | trigger `BEFORE UPDATE OR DELETE` por linha | Ledger nunca é sobrescrito nem apagado | §5.5, §6.4 |
| `wallet_ledger_entries_no_truncate` | `wallet_ledger_entries` | trigger `BEFORE TRUNCATE` | Idem, para `TRUNCATE` | §5.5 |
| `wallet_ledger_entries_transaction_processed` + `wallet_ledger_entries_check_transaction()` | `wallet_ledger_entries` | constraint trigger `AFTER INSERT`, `DEFERRABLE INITIALLY DEFERRED`: a transação do lançamento está `PROCESSED` e não é `LOSS` (SQLSTATE `23514`) | `LOSS` e `REJECTED` não geram lançamento; lançamento só de transação concluída | §6.4 |
| `inbox_messages_pkey` | `inbox_messages` | `PRIMARY KEY (consumer_name, message_id)` | Deduplicação de mensagens por consumidor | §6.5 |
| `outbox_messages_attempts_non_negative` | `outbox_messages` | `CHECK (attempts >= 0)` | Contador de tentativas coerente | §6.5 |
| `outbox_messages_pending_idx` | `outbox_messages` | índice `(next_attempt_at) WHERE published_at IS NULL` | O publisher acha as pendentes devidas sem varrer as publicadas | §6.5, §11 |

### Decisões

- **`numeric(18,2)` em todo valor monetário.** É o teto do `Money` (16 inteiros mais 2 casas): nada que o domínio aceite estoura a coluna, e nada que a coluna aceite o domínio recusa. O driver devolve `numeric` como string, então não há `number` no caminho.
- **`integer` para `version` e `attempts`.** O driver devolve `bigint` como string, que vazaria para o `number` do domínio. Um `integer` (até 2^31 − 1) cobre com folga qualquer contador por wallet ou por mensagem.
- **`outbox_messages.payload` é `json`, não `jsonb`.** O `json` guarda o texto como foi enviado e preserva a ordem fixa das chaves do envelope (`eventId, eventType, aggregateId, ...`) até a fila. O `jsonb` reordenaria as chaves. Ninguém consulta dentro do payload, então o `jsonb` não traria ganho.
- **`seq bigint generated always as identity` no ledger.** Existe só na persistência (não está no domínio). Dá uma ordem total e estável dentro da wallet para a paginação do extrato (T14) e para a cadeia de saldos da reconciliação (T12). `created_at` não serve: vem do relógio da aplicação e pode empatar ou voltar entre instâncias. `generated always` impede que a aplicação grave um `seq` à mão. A ordem de commit só é garantida se o caso de uso (T13/T16) travar a linha da wallet (o `UPDATE` com checagem de `version`) **antes** de inserir o lançamento: assim duas movimentações da mesma wallet nunca obtêm `seq` fora da ordem em que commitam.
- **FKs `DEFERRABLE INITIALLY DEFERRED`.** Verificadas no `COMMIT`. Inbox, transação, saldo, ledger e outbox vão na mesma transação SQL (§6.5, §11), e a ordem de flush do MikroORM (T11, colunas escalares sem relações) nunca pode quebrar uma FK.
- **Sem FK de `wager_transactions.wallet_id` para `wallets`.** Uma transação `REJECTED` com `WALLET_NOT_FOUND` é persistida com um `walletId` que não existe. Consequência para a T19/T22: a borda precisa validar `walletId` como UUID (`INVALID_PAYLOAD`), porque a coluna é `uuid` e um texto qualquer estouraria no banco.
- **Uma coluna `currency` só no ledger.** `money`, `balance_before` e `balance_after` ficam na mesma moeda por construção (o domínio exige "mesma moeda nos três valores").
- **FKs compostas para consistência de moeda e wallet.** `(wallet_id, currency)` garante a moeda da wallet, e `(transaction_id, wallet_id, currency)` garante que o lançamento é da wallet e da moeda da transação. Por isso `wallets` e `wager_transactions` têm as `UNIQUE` extras que servem de alvo.
- **O trigger do ledger também bloqueia `TRUNCATE`,** com errcode `restrict_violation` (SQLSTATE `23001`). A sonda feita com `set local session_replication_role = replica` (exige superuser) **contorna** o trigger e o `TRUNCATE` passa. Nota para o reset de banco dos testes (T12): ele pode usar esse caminho em vez de `DROP`/`TRUNCATE` normal, mas isso nunca deve existir em código de produção.
- **Trigger de estado terminal em `wager_transactions`.** Bloqueia `UPDATE` a partir de `PROCESSED`/`REJECTED`/`FAILED`, `UPDATE` de colunas de identidade (`id`, `provider_id`, `external_transaction_id`, `idempotency_key`, `payload_hash`, `wallet_id`, `player_id`, `round_id`, `game_id`, `kind`, `amount`, `currency`, `reference_external_transaction_id`, `created_at`) e `DELETE`. É a versão em SQL de §6.3 ("terminal é terminal"), para o caso de outro caminho de código (ou um operador) tentar. As mensagens citam só id, status e operação, nunca valores (§12). O `TRUNCATE` de `wager_transactions` já é barrado antes pela FK do ledger (`0A000`); o trigger fica como segunda barreira.
- **Lançamento só de transação `PROCESSED` e não `LOSS`** (migration `Migration20261022120924_ledger_entry_processed_transaction`, adicionada no review de T10–T12). Defesa extra do §6.4, fora das três categorias do §5.9. É um constraint trigger deferred, e não um `CHECK`, porque o caso de uso pode inserir a transação `PENDING` e movê-la para `PROCESSED` depois do lançamento, na mesma transação SQL: o status é lido no `COMMIT`. Uma transação inexistente fica para a FK `wallet_ledger_entries_transaction_fk`. Não confere a direção do lançamento contra o `kind` (`BET` → `DEBIT` etc.): isso continua no domínio.
- **`failure_code` não tem `CHECK` de valores.** Seria a terceira cópia da lista (`PERSISTED_REJECTION_CODES` e a tabela de códigos acima). O banco só confere presença por estado e `PERMANENT_FAILURE` em `FAILED`.
- **`player_id`, `provider_id` e ids externos são `text` sem limite de tamanho.** O limite é da borda (zod, T19).
- **Fora do escopo.** Mapeamento ORM e repositórios (T11), testes das constraints e do roundtrip da migration (T12), colunas de retry do `PENDING_REFERENCE` (T24, em migration própria), rodar migrations no boot ou na imagem Docker.

## Persistência e ORM (§4, §6.1)

Schemas e mapeadores em `src/modules/*/infrastructure/persistence/` (`*.persistence.ts`), portas em `src/modules/*/application/` e adapters `MikroOrm*Repository` ao lado dos schemas. A lista única dos schemas é `ENTITY_SCHEMAS` (`src/infrastructure/database/entity-schemas.ts`), usada por `buildMikroOrmConfig` (app e CLI). Testes: `test/integration/modules/*/infrastructure/*-persistence.spec.ts`.

- **Por que MikroORM.** É o ORM preferencial do §4. Dá `em.transactional()` com o contexto propagado por `AsyncLocalStorage` (os repositórios usam o `EntityManager` injetado e enxergam a transação ativa, sem passar `em` por parâmetro), `LockMode` para o controle de concorrência da T14 e migrations versionadas e reversíveis. As migrations são escritas à mão, porque o schema da T10 tem constraints e triggers que o metadata não conhece: `migration:create` deve usar `--blank`.
- **Row + mapper com `EntitySchema`, não o domínio mapeado direto.** Cada tabela tem uma interface de linha (`WalletRow`, ...), um `EntitySchema` sobre ela e funções `toRow`/`fromRow`. Motivos concretos: `WalletLedgerEntry` é `Object.freeze` e o MikroORM precisa anotar a instância; `Money` ocupa duas colunas (`amount` + `currency`, e no ledger uma `currency` para três valores), o que um custom type de coluna única não representa; o estado é `private _campo` com getters e cópia defensiva de `Date`; `Wallet.lastLedgerEntryId` é transitório e não existe no banco. O mapper reconstrói só por `rehydrate`, que não revalida (§6.0). `EntitySchema` evita decorators e `reflect-metadata` também na infraestrutura, e o domínio continua sem nenhum import de ORM (§6.1).
- **Mapeamento do `Money`.** `numeric(18,2)` ↔ `type: 'decimal'` com `precision: 18, scale: 2`, e a propriedade da row é `string` (o `DecimalType` do MikroORM devolve `String(value)`), nunca `number`. A escrita usa `money.toJSON().amount`; a leitura usa `Money.from({ amount, currency })`, que é estrito: um valor fora do contrato vindo do banco (impossível com as constraints da T10) lança `INVALID_MONEY` em vez de virar um `Money` errado. `wager_transactions.balance_after` reaproveita a `currency` da transação; o ledger tem uma `currency` para `amount`, `balance_before` e `balance_after`. Os testes de roundtrip cobrem `0.00`, `0.10`, `99999999.99` e o teto `9999999999999999.99`.
- **Estratégia de escrita: SQL explícito, não Unit of Work.** Os adapters executam `em.insert` e `em.nativeUpdate` na hora, dentro da transação, e leem com `disableIdentityMap`. Motivos: uma violação de constraint aparece na própria chamada (e não no `flush`, longe do código que a causou); o dirty checking do Unit of Work reintroduziria o `read → calculate → update` sem controle de concorrência que o §5.7 proíbe; e o `version: true` do MikroORM conflita com o `version` do domínio (que só sobe quando o saldo muda, §6.2). Sem identity map, uma leitura depois de `nativeUpdate` na mesma transação nunca devolve linha velha, e nada fica gerenciado para um `flush` acidental. Os métodos de escrita chamam `assertInTransaction` e lançam `... must run inside em.transactional()` fora de uma transação (erro de programação, sem valores na mensagem).
- **`update` grava só as colunas mutáveis.** `wager_transactions`: `status`, `reference_transaction_id`, `failure_code`, `balance_after`, `processed_at`. `inbox_messages`: `processed_at`. `outbox_messages`: `attempts`, `next_attempt_at`, `published_at`. O trigger da T10 bloqueia as demais colunas de `wager_transactions`, e as outras tabelas não têm por que reescrevê-las. `update` de uma linha inexistente lança erro (`... not found for update`). O ledger só tem `append`: é append-only no código e no banco.
- **Violação de constraint aborta a transação no Postgres.** Um `INSERT` que viola uma `UNIQUE` deixa a transação inutilizável até o rollback. Por isso o replay por corrida de inserção (T16) relê numa transação nova (ou depois de um savepoint), e a inbox (T22) pode usar `INSERT ... ON CONFLICT DO NOTHING` em vez de tratar a exceção.
- **Payload da outbox.** A coluna `json` guarda o texto do envelope e preserva a ordem das chaves. O `OutboxMessage` congela o payload em profundidade, mas o MikroORM escreve nos parâmetros ao processá-los, então o mapper entrega uma cópia mutável (`structuredClone`) e a leitura volta pelo `OutboxMessage.rehydrate`, que faz a própria cópia congelada. O teste compara `JSON.stringify(lido.payload)` com o original.
- **Portas como classes abstratas.** O token de DI é a própria classe (sem `@Inject`) e o contrato não depende de framework; cada módulo Nest (`WalletModule`, `WageringModule`, `MessagingModule`) liga a porta ao adapter com `{ provide: Porta, useClass: MikroOrm... }`. O `EntityManager` vem do `MikroOrmModule` global.
- **Fora do escopo.** Buscas por chave natural (`idempotencyKey`, `externalTransactionId`, referência por `providerId` + id externo; T16/T17); mapeamento da coluna `seq` do ledger e paginação (T17/T18); claim da outbox com `SKIP LOCKED` (T23); busca de pendentes (T24); reset de banco e testes de constraints (T12); `Clock` e `IdGenerator` (T15); `RequestContext` para o consumer SQS (T22).

## Concorrência por wallet (§8)

Código: porta `UnitOfWork`, `ConcurrencyConflictError` e `ConcurrencyConflictReason` em `src/shared/application/unit-of-work.ts`; adapter `MikroOrmUnitOfWork` e `classifyConcurrencyConflict` em `src/infrastructure/database/mikro-orm-unit-of-work.ts`; contador em `src/infrastructure/database/concurrency-metrics.ts`; `WalletRepository.lockById` e `WalletRepository.updateBalance` (porta e adapter MikroORM). Testes: `test/unit/infrastructure/database/classify-concurrency-conflict.spec.ts`, `test/integration/infrastructure/database/unit-of-work.spec.ts` e `test/integration/modules/wallet/infrastructure/wallet-concurrency.spec.ts`.

- **Estratégia.** Lock pessimista de linha (`SELECT … FOR UPDATE` em `wallets` por `id`) dentro de `UnitOfWork.run`, mais `UPDATE … WHERE id = ? AND version = ?` como segunda barreira, mais retry limitado em `40P01` (deadlock), `40001` (serialization failure), `55P03` (lock timeout) e `VERSION_CONFLICT`. O caso de uso trava a wallet, lê o saldo já travado, decide, grava transação, lançamento e saldo, e solta tudo no commit.
- **Por que pessimista e não só otimista.** Com contenção alta numa mesma wallet (50× a mesma aposta, §13), um otimista puro gastaria as tentativas em conflitos de `version` e devolveria 503 em carga normal. Com `FOR UPDATE` as transações enfileiram na linha, e só falha quem esperou mais que o `lock_timeout`. O `version` continua no `WHERE` para pegar um caminho de escrita que esqueça o lock.
- **Por que não `UPDATE … SET balance = balance - x WHERE balance >= x`.** É atômico, mas tira a decisão do aggregate `Wallet` e da política (T06), que precisam do estado da wallet e da referência para escolher o `failureCode` (`INSUFFICIENT_FUNDS` vs `REVERSAL_INSUFFICIENT_FUNDS`) e para gerar o lançamento com `balanceBefore`/`balanceAfter`.
- **Sem lock global (§5.6).** O lock é só da linha da wallet: wallets diferentes nunca se esperam (teste "does not make different wallets wait for each other"). Nenhum fluxo trava duas wallets na mesma transação, então não há ordem de lock a impor; deadlock só aparece com outras linhas (ou no teste, que força X→Y e Y→X) e é coberto pelo retry. A garantia vem só do Postgres (lock de linha e a constraint `wallets_balance_non_negative`), sem estado em processo, então vale com várias instâncias (§5.8).
- **`READ COMMITTED`.** Depois de esperar o `FOR UPDATE`, o Postgres relê a linha na versão commitada, então o cálculo parte do saldo atual. `REPEATABLE READ` daria `40001` em toda espera e forçaria retry. `40001` fica na lista por segurança.
- **`lock_timeout` por transação** (`set_config('lock_timeout', ..., true)`, `DB_LOCK_TIMEOUT_MS`, padrão 2000 ms). Uma transação presa não segura as outras da mesma wallet nem esgota o pool indefinidamente. Vale para todo statement da transação (inclusive a espera por índice único de outro `INSERT`) e não vaza para a conexão do pool (teste de sanidade).
- **Retry.** `DB_TRANSACTION_MAX_ATTEMPTS` (padrão 3), com `ExponentialBackoff` de 10 ms até 200 ms e 50% de jitter entre tentativas. O retry refaz o callback inteiro numa transação nova (rollback de tudo, inclusive idempotência e inbox), por isso `work` precisa ser reexecutável e ler tudo dentro dele. `run` aninhado é erro de programação. Esgotado o limite, lança `ConcurrencyConflictError` (`TRANSIENT_FAILURE`, ação `RETRY`): a T19 mapeia para 503 com `Retry-After` e a T22 devolve a mensagem à fila. Unique violation e outros erros não são refeitos (o replay por corrida de inserção é da T16).
- **Ordem do ledger.** Como a linha da wallet é travada antes do `INSERT` do lançamento, dois lançamentos da mesma wallet obtêm `seq` na ordem de commit (atende a nota da seção "Schema e constraints").
- **Métrica.** `lock_conflicts_total{reason, outcome}`, com `reason` em `deadlock`, `serialization_failure`, `lock_timeout` e `version_conflict`, e `outcome` em `retried` ou `exhausted`. Espera sem conflito não conta: não há histograma de espera, que fica para a T25 se fizer falta. O contador é criado no `Registry` do app (T13).
- **Trade-offs.** Uma wallet quente serializa as transações dela: a vazão é limitada pelo tempo de transação, por isso a transação deve ser curta e sem I/O externo dentro dela. Conexões ficam presas enquanto esperam o lock (pool 10 × réplicas, dentro do `max_connections=200`). `lock_timeout` curto demais vira 503 sob rajada; longo demais segura o pool.
- **Fora do escopo.** Mapeamento HTTP/SQS do erro (T19/T22), testes com 3+ processos e 50× a mesma aposta (T29/T30), `Clock` e `IdGenerator` (T15).

## Suporte de testes (§13)

Helpers em `test/support/` (`database.ts`, `fixtures.ts`, `wallet-consistency.ts`, `sqs.ts`, `schema-objects.ts`, além de `create-test-app.ts` e `orm-context.ts`) e specs em `test/integration/support/test-support.spec.ts` e `test/integration/infrastructure/database/` (`constraints.spec.ts`, `migrations.spec.ts`).

- **Reset de banco.** `resetDatabase` trunca as 5 tabelas num único `TRUNCATE` dentro de uma transação com `set local session_replication_role = replica`, que desliga os triggers append-only/terminal (exige superuser; o usuário do compose é). Só existe em `test/support/`; recusa rodar com `NODE_ENV=production`. Um único statement porque a FK do ledger barra o `TRUNCATE` isolado de `wager_transactions` (`0A000`).
- **Roundtrip de migrations em banco descartável.** O teste cria `wagering_migrations_<uuid>`, roda `up → down → up` e apaga com `drop database ... with (force)`. Rodar `down` no banco compartilhado apagaria o schema usado pelos outros specs e pelo dev.
- **Constraints verificadas por SQLSTATE e nome.** Cada caso quebra só a constraint alvo e o teste confere `code` e `constraint` do erro do driver (`pg` `DatabaseError`); triggers conferem `23001` e um trecho da mensagem. Um teste de catálogo compara o conjunto exato de constraints, índices, triggers e funções com a lista esperada (`test/support/schema-objects.ts`): constraint nova sem teste ou removida sem querer quebra o teste. `wallets_id_currency_uq` não é violável sem violar a PK e `wallet_ledger_entries_wallet_seq_uq` é protegido pelo `generated always` (`428C9`); os dois ficam cobertos pelo catálogo.
- **`wallet_ledger_entries_direction_valid` precisa de ajuda para ser isolada.** Um `direction` fora de `DEBIT`/`CREDIT` também falha `wallet_ledger_entries_balanced`, que o Postgres confere antes (checks em ordem de nome). O teste mostra os dois lados: o `INSERT` direto é recusado por `balanced`, e, com `balanced` removida dentro de uma transação revertida (`withRollback`), a recusa passa a ser de `direction_valid`. O teste confere em seguida que a constraint continua no catálogo.
- **`assertWalletConsistent`.** Lê a wallet e o ledger por `seq`: saldo == soma (CREDIT − DEBIT), cadeia contínua a partir de `0.00`, saldo == último `balance_after`, `version == 1 + lançamentos cuja transação não é OPENING` (§6.2): a wallet nasce com `version` 1, com ou sem o CREDIT de abertura, e só sobe nas mudanças de saldo seguintes. Contar todos os lançamentos (`max(1, n)`) reprovaria uma wallet aberta com 0.00 depois do primeiro crédito. Compara com `Money`, nunca `number`.
- **SQS nos testes.** `purgeQueue` usa `PurgeQueue` (LocalStack 4.14.0 aceita purges seguidos e remove também mensagens em voo; na AWS real há o limite de 60 s, por isso é só de teste). `receiveAll` apaga o que lê por padrão, porque numa fila FIFO uma mensagem em voo segura as próximas do mesmo grupo.

## Observabilidade (§12)

Código em `src/infrastructure/observability/` (`correlation-id.ts`, `logger.config.ts`, `log-context.ts`, `metrics.controller.ts`, `observability.module.ts`), módulo global importado primeiro pelo `AppModule`. Testes: `test/unit/infrastructure/observability/correlation-id.spec.ts`, `test/integration/infrastructure/observability/observability.spec.ts` e o helper `test/support/log-capture.ts`.

- **`correlationId` por requisição.** Vem do header `X-Correlation-Id` quando casa com `^[A-Za-z0-9._:-]{1,128}$`; senão (ausente, vazio, longo, com caractere fora do padrão, header repetido) é gerado um UUIDv7. Valor inválido é substituído, não recusado com 400: o id é metadado de diagnóstico e não pode derrubar uma requisição financeira, e o padrão barra injeção em log (quebra de linha, aspas) e tamanho ilimitado. O id é devolvido no header `X-Correlation-Id` da resposta e vai em toda linha de log da requisição. O `X-Request-Id` do nginx não é usado como fallback.
- **UUIDv7 sem a porta `IdGenerator`.** O `resolveCorrelationId` chama `Bun.randomUUIDv7()` direto (o gerador é um parâmetro com esse default, então o teste injeta um fake). A porta `IdGenerator` é para ids de domínio e ainda não existe (T15); o id de correlação é metadado de transporte da infraestrutura, não identidade de agregado.
- **Formato do log da requisição.** `pino-http` com `quietReqLogger: true` e `customAttributeKeys.reqId = 'correlationId'`: o logger da requisição é `logger.child({ correlationId })`, então os logs da aplicação dentro da requisição carregam o `correlationId` sem arrastar o objeto `req` inteiro. A linha "request completed" tem `correlationId`, `req: { method, url }`, `res: { statusCode }` e `responseTime`. Os serializers emitem só o método e o caminho: **nunca** headers, corpo, query string ou endereço remoto. Toda linha traz `instanceId` (no lugar do `pid`/`hostname` padrão do pino) e timestamp ISO.
- **Redaction.** `REDACTED_LOG_FIELDS`: `money`, `amount`, `balance`, `balanceBefore`, `balanceAfter`, `storedBalance`, `calculatedBalance`, `difference`, `payload`, `body`, `data`; o valor vira `[REDACTED]`. Os paths do pino cobrem o nível raiz (`money`) e **um** nível de aninhamento (`*.money`). Um campo financeiro mais fundo (`a.b.money`) não é coberto: não deve ser logado, e a T25 revisa os logs. O objeto inteiro de `money`/`payload` é censurado, não só o `amount` dentro dele.
- **`LogContext` para SQS e workers.** `run({ correlationId, messageId, ... }, fn)` roda `fn` num escopo do `AsyncLocalStorage` do nestjs-pino (o mesmo que o `PinoLogger` lê), e `assign({ walletId, transactionId, providerId })` acrescenta campos ao resto do escopo. Para o consumer SQS (T22) o `correlationId` vem do envelope. Usa o `ROOT_LOGGER` do próprio app e não `PinoLogger.root`: o nestjs-pino guarda o logger de fora de requisição num singleton do módulo, definido pelo primeiro app do processo, então com vários apps no mesmo processo (`bun test`) ele escreveria no destino errado. `LogContext.assign` fora de um escopo lança erro (erro de programação). Aqui só existe o helper e o teste; a ligação com o consumer é da T22.
- **Um `ROOT_LOGGER` por app, a partir de `LOG_DESTINATION`.** O destino padrão é o stdout (`pino.destination(1)`, JSON puro, sem `pino-pretty`). Os testes trocam o provider `LOG_DESTINATION`: `createTestApp()` descarta os logs por padrão (suítes silenciosas) e `createTestApp({ logDestination })` captura num stream em memória (`createLogCapture`). `LOG_LEVEL` continua sem `silent`. Os tokens `LOG_DESTINATION` e `ROOT_LOGGER` ficam em `logger.config.ts` (e são reexportados pelo módulo) para o `LogContext` não importar o módulo que o declara. Os logs internos do Nest saem pelo `Logger` do nestjs-pino (`bufferLogs: true` + `app.useLogger`) e, fora de requisição, pelo singleton do primeiro app do processo.
- **Probes não geram "request completed".** `autoLogging.ignore` pula `/health/*` e `/metrics` (volume de probe e de scrape sem informação); o `correlationId` continua atribuído e devolvido no header.
- **`Registry` do prom-client por app.** `GET /metrics` serve um `Registry` próprio (provider injetável), com o label padrão `instance_id` e as métricas de processo (`collectDefaultMetrics`). Nunca o registry global do prom-client: um segundo app no mesmo processo (testes) lançaria "metric already registered". As métricas de negócio (transações por status, duplicadas, retries, DLQ, conflitos de lock (`lock_conflicts_total`, criada na T14), lag da outbox, latência, divergência da reconciliação) ficam para T22/T23/T25, que injetam o `Registry` e criam as métricas nele.
- **`Content-Type` do `/metrics`.** O controller devolve um `StreamableFile`: o Express reescreve o `Content-Type` de respostas string e reordena os parâmetros (`charset` antes de `version`), e o `StreamableFile` mantém o header exatamente como o `Registry.PROMETHEUS_CONTENT_TYPE` (`text/plain; version=0.0.4; charset=utf-8`).
- **Fora do escopo.** Mapeamento de erro HTTP e `LoggerErrorInterceptor` (T19), `/health/ready` (T21), ligação do `LogContext` ao consumer (T22), OpenTelemetry e dashboards.
