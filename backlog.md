# Backlog — Distributed Wagering Processor

Tasks em **ordem de dependência**, divididas em fases. A fonte da verdade é o `DESAFIO.md`, e as referências `§N` apontam para as seções dele.
Cada task traz: **id**, **título**, **descrição**, **critério de aceite**, **seção do enunciado** e **dependências**. Marque `[x]` ao concluir.

Definição de pronto (vale para toda task): `bun run typecheck` limpo, testes da task verdes contra a infraestrutura real quando houver I/O, nenhuma violação de §5, e decisões relevantes anotadas no `ARCHITECTURE.md`.

---

## Fase 0 — Fundação

### [x] T00 — Setup do projeto
- **Descrição:** Bun + TS strict + NestJS 11 + MikroORM 6 (Postgres) + cliente SQS. Estrutura de pastas, `bunfig.toml`, `.env.example`, docker compose (Postgres, LocalStack com filas FIFO + DLQ, 3 réplicas + nginx), `GET /health/live` e teste de sanidade.
- **Critério de aceite:** `bun run infra:up && bun test` verde. App conecta no Postgres e responde `GET /health/live` 200. `docker compose --profile app up` sobe 3 réplicas saudáveis atrás do nginx. `migration:up/down` funcionam sob Bun.
- **Seção:** §4
- **Depende de:** —

---

## Fase 1 — Domínio puro (testes unitários, sem I/O)

### [x] T01 — Value object `Money`
- **Descrição:** `Money` imutável sobre `decimal.js`: `from`, `zero`, `add`, `subtract`, `negate`, `isZero/isPositive/isNegative/isLessThan/equals`, `toJSON`, `toString`. Escala fixa de 2 casas, moeda ISO-4217 validada. Parser de entrada que rejeita `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas e valores negativos em contratos de entrada. Operações entre moedas diferentes lançam erro de domínio.
- **Critério de aceite:** testes unitários cobrem cada entrada inválida listada, escala/serialização (`"25.00"`, `"0.10"`, `"1000.00"`), imutabilidade (operações retornam nova instância), aritmética exata (`0.10 + 0.20 == 0.30`) e conflito de moeda. Nenhum `number` na API pública de `Money`.
- **Seção:** §6.1, §5.1, §13 (Unidade)
- **Depende de:** T00

### [x] T02 — Erros de domínio e taxonomia de `FailureCode`
- **Descrição:** Hierarquia de erros de domínio (`DomainError`, `CurrencyMismatchError`, `InvalidTransactionStateError`, …) e enum `FailureCode` estável e legível por máquina (ex.: `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_AMOUNT_MISMATCH`, `ALREADY_REVERSED`, `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`, …). Cada código é classificado em "reenviar", "corrigir payload" ou "desistir".
- **Critério de aceite:** a falta de saldo em aposta e a falta de saldo em reversão têm códigos distintos. A tabela de códigos e a classificação estão documentadas no `ARCHITECTURE.md`.
- **Seção:** §7.2, §7 regra 9
- **Depende de:** T00

### [x] T03 — `WalletLedgerEntry` imutável
- **Descrição:** Entidade com todos os campos `readonly`, sem métodos de transição. `create` valida `balanceBefore ± money === balanceAfter`, a mesma moeda nos três valores e `money` positivo. `rehydrate` não revalida. `isBalanced()`.
- **Critério de aceite:** testes unitários com lançamento desbalanceado (rejeitado), moedas misturadas (rejeitado), `DEBIT`/`CREDIT` corretos e `rehydrate` sem revalidação.
- **Seção:** §6.4
- **Depende de:** T01, T02

### [x] T04 — Aggregate `Wallet`
- **Descrição:** `open` (version 1, saldo inicial), `rehydrate`, `debit`/`credit` que alteram o saldo e devolvem o `WalletLedgerEntry` correspondente, garantindo que saldo e ledger são consistentes por construção. `version` incrementa somente quando o saldo muda. Saldo nunca negativo. Moeda da operação igual à da wallet.
- **Critério de aceite:** testes unitários para débito com saldo insuficiente (não muda estado nem version), débito/crédito válidos (version +1, entrada correta), conflito de moeda, saldo inicial zero e `rehydrate`.
- **Seção:** §6.2, §13 (Unidade: invariantes da `Wallet`, conflito de moeda)
- **Depende de:** T03

### [ ] T05 — `WagerTransaction` e máquina de estados
- **Descrição:** Entidade com `create` (nasce `PENDING`, valida exigência de referência por kind, recusa `OPENING` vindo de fora), `rehydrate`, transições `markProcessed`, `markPendingReference`, `reject`, `fail` e consultas `isTerminal`, `affectsBalance`, `requiresReference`, `matchesPayload`, `ledgerDirectionFor`. Guarda o saldo resultante observado, para replay (§7 regra 7).
- **Critério de aceite:** testes cobrindo todas as transições válidas e inválidas (transição a partir de terminal lança `InvalidTransactionStateError`), `REFUND`/`ROLLBACK` sem referência rejeitados na criação, direção de ledger por kind (`ROLLBACK` inverte a referência). Diagrama ou tabela de transições no `ARCHITECTURE.md`.
- **Seção:** §6.3, §7 regras 1 e 6
- **Depende de:** T01, T02

### [ ] T06 — Política de aplicação de transações (regras BET/WIN/LOSS/REFUND/ROLLBACK)
- **Descrição:** Serviço de domínio puro que, dada a `Wallet`, a transação e a referência (se houver), decide: aplicar (gera ledger), registrar sem efeito (`LOSS`), rejeitar com `FailureCode` ou aguardar referência. Valida referência do mesmo provider, player, wallet, moeda e rodada, os kinds permitidos (`REFUND`→`BET`; `ROLLBACK`→`BET|WIN|REFUND`), o valor igual ao da referência, a reversão única por tipo e a reversão que deixaria saldo negativo.
- **Critério de aceite:** testes unitários para cada linha da tabela do §7 e cada regra adicional 1–9. `REJECTED` nunca produz lançamento. `LOSS` nunca produz lançamento.
- **Seção:** §7, §13 (Unidade: regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
- **Depende de:** T04, T05

### [ ] T07 — Idempotência: JSON canônico e `payloadHash`
- **Descrição:** Função pura que monta o subconjunto de campos de negócio, serializa em JSON canônico (chaves ordenadas recursivamente, sem header nem metadados de transporte) e calcula o hash (ex.: SHA-256 hex). Default da key `"{providerId}:{externalTransactionId}"`.
- **Critério de aceite:** mesma carga com chaves em ordem diferente gera o mesmo hash. Qualquer campo de negócio alterado gera hash diferente. Campos de transporte não influenciam. Teste de "mesma key com payload divergente" usando `matchesPayload`. Algoritmo documentado no `ARCHITECTURE.md`.
- **Seção:** §9 (Idempotência), §6.3, §13 (Unidade: idempotency key com payload divergente)
- **Depende de:** T05

### [ ] T08 — `IntegrationEvent` e eventos mínimos
- **Descrição:** Classe abstrata `IntegrationEvent<T>` (envelope com `eventId`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version`, `toJSON`) e subclasses `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference`, com `eventType`/`version` no tipo e factories `from(...)`.
- **Critério de aceite:** `toJSON()` produz JSON estável com `occurredAt` ISO-8601 e `MoneyProps` (string decimal) em `data`, nunca a instância de `Money`. Teste de snapshot do envelope de cada evento.
- **Seção:** §11 (Eventos mínimos)
- **Depende de:** T04, T05

### [ ] T09 — `InboxMessage` e `OutboxMessage` (domínio)
- **Descrição:** `InboxMessage.receive/rehydrate/markProcessed/isProcessed` e `OutboxMessage.enqueue/rehydrate/isPending/isDue/markPublished/scheduleRetry`, com backoff exponencial e jitter limitados.
- **Critério de aceite:** testes unitários de backoff (crescimento e teto), `isDue` em relação ao relógio, e `markPublished` idempotente ou tratado como erro de programação, conforme a decisão documentada.
- **Seção:** §6.5
- **Depende de:** T08

---

## Fase 2 — Persistência e schema

### [ ] T10 — Schema e migrations iniciais com constraints
- **Descrição:** Migrations versionadas e reversíveis para `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`. Valores em `numeric(…,2)`. Garantias aplicadas no banco:
  - `CHECK (balance >= 0)` e `CHECK (version >= 1)`;
  - `UNIQUE (player_id, currency)`;
  - `UNIQUE (provider_id, external_transaction_id)` e unicidade da idempotency key;
  - `UNIQUE (transaction_id, wallet_id)` no ledger;
  - `CHECK` da aritmética do lançamento e moeda consistente;
  - ledger imutável (trigger bloqueando `UPDATE`/`DELETE`);
  - índice único parcial impedindo dupla reversão da mesma referência pelo mesmo kind;
  - `CHECK` de status/kind válidos;
  - PK `(consumer_name, message_id)` no inbox;
  - índice para outbox pendente (`published_at IS NULL`, `next_attempt_at`);
  - índices para o worker de `PENDING_REFERENCE` e para a paginação do ledger.
- **Critério de aceite:** `migration:up` → `migration:down` → `migration:up` executa limpo. Cada constraint é documentada no `ARCHITECTURE.md` com a invariante que protege.
- **Seção:** §5.9, §5.5, §4 (Migrations), §6.2, §6.4, §6.5, §7 regra 4
- **Depende de:** T03–T09

### [ ] T11 — Mapeamento ORM e repositórios
- **Descrição:** Mapeamento MikroORM em `infrastructure/` (EntitySchema ou entidades de persistência com mapper; decidir e justificar), com o domínio sem decorators. `numeric` lido como **string** e reidratado em `Money` via `rehydrate`. Portas de repositório em `application/` e adapters MikroORM. Registro dos módulos no `DatabaseModule`.
- **Critério de aceite:** teste de integração round-trip (salvar → ler) de cada agregado/entidade, preservando `Money` exato (ex.: `"0.10"`, `"99999999.99"`). Nenhum `number` no caminho do dinheiro. Justificativa do ORM e do mapeamento do `Money` no `ARCHITECTURE.md`.
- **Seção:** §4 (ORM), §6.0, §6.1 (persistência)
- **Depende de:** T10

### [ ] T12 — Suporte de testes e testes de migrations/constraints
- **Descrição:** Helpers em `test/support/`: reset de banco entre testes, fixtures (wallet com saldo, provider), `assertWalletConsistent(walletId)` (saldo == soma do ledger e cadeia `balanceBefore/After` contínua) e utilitário para limpar e ler filas SQS. Testes de integração que tentam violar cada constraint via SQL direto.
- **Critério de aceite:** cada constraint da T10 tem um teste que comprova a rejeição pelo banco: saldo negativo, wallet duplicada, `UPDATE`/`DELETE` em ledger, lançamento desbalanceado, transação duplicada, dupla reversão, inbox duplicado. O roundtrip das migrations é testado.
- **Seção:** §13 (Integração: migrations e constraints), §5.9
- **Depende de:** T11

---

## Fase 3 — Aplicação (casos de uso)

### [ ] T13 — Base de observabilidade (logger, métricas, correlação)
- **Descrição:** `nestjs-pino` com saída JSON, campos de contexto (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `instanceId`) e redaction de campos sensíveis/financeiros. Registry `prom-client` exposto em `GET /metrics`. Propagação de `correlationId` (header `X-Correlation-Id` ou gerado; na fila, vindo do envelope).
- **Critério de aceite:** log de uma requisição sai em JSON com `correlationId`. `GET /metrics` responde no formato Prometheus. Teste garantindo que `money`/payload completo não aparecem no log.
- **Seção:** §12
- **Depende de:** T00

### [ ] T14 — Estratégia de concorrência por wallet
- **Descrição:** Implementar e encapsular a estratégia escolhida (ex.: `SELECT … FOR UPDATE` na linha da wallet dentro de `em.transactional()`, update condicional por `version` e retry limitado em deadlock/serialization failure), sempre por `walletId` e nunca com lock global. Contabilizar conflitos de lock em métrica.
- **Critério de aceite:** teste de integração com N débitos paralelos na mesma wallet sem lost update e sem saldo negativo. Wallets diferentes não se bloqueiam. Justificativa e trade-offs no `ARCHITECTURE.md`.
- **Seção:** §8, §5.6, §5.7, §5.8
- **Depende de:** T12, T13

### [ ] T15 — Use case `OpenWallet`
- **Descrição:** Cria a wallet. Com saldo inicial > 0, cria na **mesma transação SQL** a `WagerTransaction` interna `OPENING` (`PROCESSED`), o lançamento `CREDIT` e os eventos na outbox. Wallet duplicada (`playerId + currency`) vira conflito, detectado pela constraint do banco.
- **Critério de aceite:** testes de integração para wallet com saldo (1 `OPENING`, 1 `CREDIT`, `version 1`, consistente com o ledger), wallet com saldo zero (sem lançamento) e criação duplicada concorrente (exatamente uma criada, a outra conflito).
- **Seção:** §9 (Criar wallet), §6.2
- **Depende de:** T14

### [ ] T16 — Use case `SubmitWagerTransaction`
- **Descrição:** Caso de uso único para HTTP e SQS. Em uma transação SQL:
  1. idempotência persistente: busca pela key; se existir, compara o `payloadHash` e devolve replay ou conflito;
  2. em corrida de inserção, a unique constraint é a guarda final e o use case relê e devolve replay;
  3. registro de inbox opcional (entrada SQS);
  4. lock da wallet, resolução da referência por `(providerId, referenceExternalTransactionId)` e aplicação da política (T06);
  5. persistência da transação, do saldo e do ledger, e enfileiramento dos eventos na outbox.

  Referência ausente → `PENDING_REFERENCE` + evento.
- **Critério de aceite:** testes de integração para cada kind (BET, WIN, LOSS, REFUND, ROLLBACK), replay idêntico (`idempotentReplay: true`, saldo original), key com payload divergente (conflito, sem efeito), saldo insuficiente (`REJECTED`, sem ledger, evento `WagerTransactionRejected`), reversão sem saldo (código distinto) e referência ausente (`PENDING_REFERENCE`). `WalletBalanceChanged` só sai quando o saldo muda. `assertWalletConsistent` ao final de cada teste.
- **Seção:** §7, §9 (Submeter transação, Idempotência), §10, §11, §5.2, §5.4
- **Depende de:** T15

### [ ] T17 — Use cases de consulta
- **Descrição:** Wallet por id, ledger paginado com **cursor estável e opaco** (ex.: base64 de `(created_at, id)` ou de uma sequência monotônica), transação por id interno e por `(providerId, externalTransactionId)`.
- **Critério de aceite:** a paginação não pula nem repete itens quando novos lançamentos chegam durante a navegação (teste). Cursor inválido é tratado como payload inválido. `limit` validado com teto.
- **Seção:** §9 (Consultas)
- **Depende de:** T16

### [ ] T18 — Use case de reconciliação
- **Descrição:** Recalcula o saldo pelo ledger e compara com o saldo materializado. Devolve `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`. Divergência é logada, contabilizada em métrica e sinalizada, **sem** correção silenciosa.
- **Critério de aceite:** teste com wallet consistente (`consistent: true`) e teste com divergência forçada via SQL, que retorna `consistent: false`, incrementa a métrica, gera log e não altera dados.
- **Seção:** §9 (Reconciliação)
- **Depende de:** T16, T13

---

## Fase 4 — Borda HTTP e infraestrutura de entrada

### [ ] T19 — API HTTP e mapeamento de status
- **Descrição:** Controllers para `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`, `POST /wagering/transactions` (header `Idempotency-Key` obrigatório), `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId` e `POST /wallets/:walletId/reconciliation`. DTOs validados com zod. Rejeitar `OPENING`. Filtro global de exceções com mapeamento **consistente** que distinga: payload inválido, conflito de idempotência, rejeição de negócio, aceite com processamento pendente, falha transitória de infraestrutura (com `Retry-After`) e não encontrado.
- **Critério de aceite:** testes e2e (app real + Postgres) para cada endpoint e cada classe de resposta. Tabela de status HTTP documentada no `ARCHITECTURE.md`. Formato de `Money` sempre `{ amount: string, currency }`.
- **Seção:** §9, §6.3 (OPENING interno)
- **Depende de:** T15–T18

### [ ] T20 — Ponto de extensão de autenticação
- **Descrição:** Decidir entre integrar um IdP externo (Keycloak/Zitadel) ou deixar o ponto de extensão explícito (`AuthGuard` no-op / `ProviderIdentityPort`). Health fica aberto. A identidade do provedor vinda da fila continua sujeita às validações de domínio.
- **Critério de aceite:** guard aplicado aos endpoints de negócio e ausente em `/health/*`. Decisão e desenho no `ARCHITECTURE.md`. Sem tabela própria de usuários/senhas.
- **Seção:** §2
- **Depende de:** T19

### [ ] T21 — Adapter SQS e `GET /health/ready`
- **Descrição:** Cliente SQS configurado para o LocalStack (endpoint, região e credenciais via env), atrás de uma porta. `GET /health/ready` verifica Postgres (`select 1`) e SQS (ex.: `GetQueueAttributes`) com timeout curto. 503 se alguma dependência falhar.
- **Critério de aceite:** teste de integração com ready 200 e infra no ar, e ready 503 quando o SQS está inalcançável (endpoint inválido). `/health/live` continua sem tocar dependências.
- **Seção:** §9 (Health checks), §12
- **Depende de:** T13

---

## Fase 5 — Mensageria e workers

### [ ] T22 — Consumer SQS (`wager-transactions.fifo`)
- **Descrição:** Long polling, validação do envelope `WagerTransactionRequested` e chamada ao **mesmo** use case da T16, com dedup via inbox `(consumerName, messageId)` na mesma transação. `DeleteMessage` (ack) **somente após o commit**. Classificação de erros:
  - negócio: terminal, com ack;
  - transitório: retry com backoff via `ChangeMessageVisibility`;
  - permanente ou envelope inválido: DLQ.

  Limite de tentativas antes da DLQ (`maxReceiveCount` + contagem própria). Em `SIGTERM`: parar o polling, concluir as mensagens em andamento ou devolver a visibilidade (`ChangeMessageVisibility 0`). `MessageGroupId = walletId` como otimização, sem servir de garantia.
- **Critério de aceite:** testes de integração com LocalStack real: mensagem processada e removida; mesma mensagem reentregue sem duplicar efeito; erro de negócio com ack; erro transitório reentregue com backoff; mensagem venenosa na DLQ após o limite; shutdown sem perder mensagem.
- **Seção:** §10, §5.3
- **Depende de:** T16, T21

### [ ] T23 — Outbox publisher
- **Descrição:** Worker em cada instância que reivindica lotes pendentes e vencidos com `FOR UPDATE SKIP LOCKED` (ou lease com expiração), publica no SQS e marca `published_at`. Em caso de falha, `scheduleRetry` com backoff. Definir e documentar o destino dos eventos (ex.: fila `wagering-events.fifo` criada no init do LocalStack, com `MessageDeduplicationId = eventId`). Métrica de outbox lag.
- **Critério de aceite:** eventos só são publicados após o commit; nenhum é perdido se o processo morrer entre o commit e a publicação; dois publishers concorrentes não publicam o mesmo evento em paralelo; publicação duplicada é segura (o consumidor deduplica por `eventId`).
- **Seção:** §11, §5.4
- **Depende de:** T16, T21

### [ ] T24 — Worker de `PENDING_REFERENCE`
- **Descrição:** Worker agendado que reprocessa transações `PENDING_REFERENCE` com backoff exponencial (claim com `SKIP LOCKED`) e limite de tentativas/TTL definido e justificado. Quando a referência chega, aplica pela mesma política. Esgotado o limite, `REJECTED` com `REFERENCE_NOT_FOUND` (ou equivalente) e evento publicado.
- **Critério de aceite:** testes de integração para `REFUND` antes da `BET` (vira `PROCESSED` depois que a `BET` chega), `ROLLBACK` cuja referência nunca chega (`REJECTED` + evento após o limite) e reprocessamento concorrente entre instâncias aplicando uma única vez.
- **Seção:** §7.1, §7 regra 8
- **Depende de:** T16

---

## Fase 6 — Observabilidade completa

### [ ] T25 — Cobertura de métricas e revisão de logs
- **Descrição:** Garantir que existem e são incrementadas as métricas de: transações por status, duplicatas detectadas (replay HTTP + inbox), retries, mensagens enviadas à DLQ, conflitos de lock, outbox lag, latência de processamento (histograma) e divergências de reconciliação. Revisar todos os logs para presença dos campos de contexto e ausência de payload financeiro completo.
- **Critério de aceite:** teste que executa um fluxo e verifica os contadores em `GET /metrics`. Lista de métricas documentada (nome, tipo, labels).
- **Seção:** §12, §9 (Reconciliação)
- **Depende de:** T18, T22, T23, T24

---

## Fase 7 — Testes obrigatórios (integração e concorrência)

> Todos os testes desta fase usam PostgreSQL e LocalStack **reais** e terminam com `assertWalletConsistent` (`wallet.balance == saldo reconstruído pelo ledger`).

### [ ] T26 — Integração: atomicidade wallet/ledger/inbox/outbox
- **Descrição:** Injetar falha em cada etapa da transação (após o ledger, antes da outbox, no commit) e comprovar que nada é persistido parcialmente.
- **Critério de aceite:** para cada ponto de falha, nenhuma linha nova em `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`, e saldo inalterado.
- **Seção:** §13 (Integração: atomicidade), §6.5, §11
- **Depende de:** T22, T23

### [ ] T27 — Integração: inbox, redelivery, retry e DLQ
- **Descrição:** Cenários reais de SQS: redelivery após o timeout de visibilidade, mensagem duplicada com o mesmo `messageId`, falha transitória com retry e mensagem permanente indo para a DLQ.
- **Critério de aceite:** efeito único por mensagem; mensagem na DLQ após o limite configurado; métricas de retry e DLQ incrementadas.
- **Seção:** §13 (Integração: inbox e redelivery; retry e DLQ), §10
- **Depende de:** T22, T25

### [ ] T28 — Integração: publishers concorrentes e recuperação após reinicialização
- **Descrição:** Dois publishers sobre a mesma outbox. Reinício da aplicação com outbox e inbox pendentes, que precisam ser retomados.
- **Critério de aceite:** todos os eventos publicados pelo menos uma vez, sem publicação paralela do mesmo evento. Após o restart, pendências concluídas e estado consistente.
- **Seção:** §13 (Integração: publishers concorrentes; recuperação após reinicialização), §11
- **Depende de:** T23

### [ ] T29 — Concorrência: mesma aposta 50×, cenário §8 e wallets distintas
- **Descrição:**
  1. A mesma aposta enviada 50× em paralelo (HTTP e/ou SQS).
  2. Saldo 100.00 com duas apostas de 80.00 simultâneas.
  3. N wallets distintas processadas em paralelo.
- **Critério de aceite:**
  1. Exatamente um débito.
  2. 1 `PROCESSED`, 1 `REJECTED` (`INSUFFICIENT_FUNDS`), saldo 20.00, exatamente 1 lançamento `DEBIT`, e retries não duplicam o débito.
  3. Todas corretas, sem serialização global (tempo compatível com paralelismo).
- **Seção:** §13 (Concorrência 1, 2, 3), §8 (Cenário obrigatório)
- **Depende de:** T19, T22

### [ ] T30 — Concorrência: ≥ 3 processos/instâncias simultâneos
- **Descrição:** Subir 3 ou mais processos reais da aplicação (subprocessos Bun ou réplicas do compose) disputando as mesmas wallets via HTTP e SQS.
- **Critério de aceite:** invariantes preservadas (sem saldo negativo, sem débito/crédito duplicado), contagem exata de lançamentos esperados e `assertWalletConsistent` em todas as wallets.
- **Seção:** §13 (Concorrência 4), §5.8, §8
- **Depende de:** T29

### [ ] T31 — Concorrência: crash, outbox dupla, referência fora de ordem e restart
- **Descrição:**
  - (5) Worker morto (`SIGKILL`) depois do commit e antes do ack.
  - (6) Dois publishers sobre a mesma outbox.
  - (7) `ROLLBACK`/`REFUND` entregue antes da referência.
  - (8) Reinício do serviço com comprovação da consistência final.
- **Critério de aceite:**
  - (5) A redelivery não duplica o efeito (inbox).
  - (6) Nenhum evento perdido, duplicatas seguras.
  - (7) Resolve via worker de `PENDING_REFERENCE`.
  - (8) Após o restart, reconciliação `consistent: true` em todas as wallets.
- **Seção:** §13 (Concorrência 5, 6, 7, 8), §11 (cenário de crash)
- **Depende de:** T24, T28, T30

---

## Fase 8 — Diferenciais opcionais

### [ ] T32 — Teste de carga (`bun run test:load`)
- **Descrição:** Script de carga contra as 3 réplicas atrás do nginx, com mistura de operações e wallets quentes/frias. Registrar ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag.
- **Critério de aceite:** `bun run test:load` executa de ponta a ponta e gera relatório. Resultados e análise honesta (incluindo limitações) no README/ARCHITECTURE. Invariantes verificadas ao final.
- **Seção:** §14 (Diferenciais opcionais)
- **Depende de:** T30, T25

---

## Fase 9 — Documentação final

### [ ] T33 — `ARCHITECTURE.md`
- **Descrição:** Consolidar as decisões e justificativas:
  - escolha do MikroORM, mapeamento do `Money` e estratégia transacional (§4);
  - estratégia de concorrência (§8);
  - schema, constraints e índices (§5.9);
  - máquina de estados e transições (§6.3);
  - taxonomia de `FailureCode` (§7.2);
  - algoritmo do `payloadHash` (§9);
  - mapeamento de status HTTP (§9);
  - limite/TTL de `PENDING_REFERENCE` (§7.1);
  - inbox/outbox e destino de eventos (§10, §11);
  - autenticação (§2);
  - observabilidade (§12);
  - interpretações adicionais adotadas (§7), trade-offs e limitações conhecidas.
- **Critério de aceite:** cada item que o enunciado manda "justificar/documentar" está coberto e aponta para o código e os testes correspondentes.
- **Seção:** §2, §4, §7, §7.1, §7.2, §8, §9, §14 (Documentação)
- **Depende de:** T01–T31 (T32 se feita)

### [ ] T34 — `README.md` final
- **Descrição:** Visão geral, pré-requisitos, setup (`bun install`, `.env`, `infra:up`, migrations), como rodar a app (local e 3 réplicas + nginx), todos os comandos de teste, exemplos de requisições (curl) e de mensagem SQS, endpoints, health e métricas, e link para o `ARCHITECTURE.md`.
- **Critério de aceite:** um avaliador consegue, partindo de um clone limpo e seguindo só o README, subir tudo e rodar todos os testes com sucesso.
- **Seção:** §14 (Documentação)
- **Depende de:** T33
