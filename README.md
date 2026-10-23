# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`) de vários provedores, por HTTP e por SQS. Ele continua correto com mensagens duplicadas, fora de ordem e várias instâncias rodando ao mesmo tempo. A correção vem do PostgreSQL (lock de linha da wallet, constraints, inbox e idempotency key), nunca de estado em memória nem da ordem da fila.

Este README cobre setup, execução, testes e exemplos de uso. As decisões, os trade-offs e as limitações estão no [ARCHITECTURE.md](ARCHITECTURE.md).

Stack: Bun 1.4.2, TypeScript 5.9.3, NestJS 11, MikroORM 6.6, PostgreSQL 17.11, SQS via LocalStack 4.14.0 e nginx 1.30.6 na frente de 3 réplicas.

## Pré-requisitos

- Bun 1.4.2: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"`.
- Docker com Compose v2 (`docker compose`, com suporte a `--wait`).
- `curl` e `jq`, usados nos exemplos de API.
- Portas livres no host: `5432` (Postgres), `4566` (LocalStack), `3000` (app local) e `8080` (nginx). Para mudar uma delas, veja "Problemas comuns".

Não precisa de AWS CLI no host: o `awslocal` já vem dentro do contêiner do LocalStack.

## Do clone aos testes verdes

```bash
bun install
cp .env.example .env
bun run infra:up           # Postgres + LocalStack; só volta quando as filas SQS já existem
bun run migration:up       # cria o schema (a aplicação não migra no boot)

bun run typecheck
bun run test:unit
bun run test:integration
bun run test:concurrency   # ou `bun run test` para as três suítes de uma vez
bun run test:load          # opcional: sobe as 3 réplicas atrás do nginx e aplica carga
```

Tempos medidos num notebook com 16 threads e 14,5 GiB de memória, com as imagens do Docker já baixadas: `infra:up` cerca de 15 s (na primeira vez, soma o download das imagens), `typecheck` 4 s, `test:unit` 1 s, `test:integration` 1 min, `test:concurrency` 40 s e `test:load` menos de 2 min. `bun run test` leva cerca de 95 s.

Antes de rodar os testes:

- **Os testes apagam dados.** `test:integration` e `test:concurrency` truncam as tabelas do banco do `DATABASE_URL` e usam as filas do `.env`. Não aponte o `.env` para dados que você quer manter.
- **Não deixe a aplicação no ar.** Um `bun run dev` ou as réplicas do compose consomem as mesmas filas e a mesma outbox e quebram as contagens dos testes. Pare com `Ctrl+C` (app local) e `docker compose --profile app stop app nginx` (réplicas). Não use `down` para isso: ele derruba também o Postgres e o LocalStack.
- **Use `bun run test`, não `bun test`.** O script passa `--timeout 30000`; o `bun test` cru usa 5 s e o teste de DLQ (cerca de 5 s) estoura.
- **Falta de `migration:up`** aparece como `relation ... does not exist`.

## Rodando a aplicação

### Local (uma instância)

Com a infra no ar e o schema migrado:

```bash
bun run dev      # com watch
bun run start    # sem watch
```

A API sobe em `http://localhost:3000`. A instância roda os quatro papéis: HTTP, consumer SQS, publisher da outbox e worker de `PENDING_REFERENCE`.

### 3 réplicas atrás do nginx

```bash
bun run infra:up
bun run migration:up
docker compose --profile app up -d --build --wait
```

A entrada é `http://localhost:8080` (nginx, round-robin). Cada réplica roda HTTP, consumer SQS, publisher da outbox e worker de `PENDING_REFERENCE`, e elas se coordenam só pelo banco. A imagem não roda migration: o `bun run migration:up` do host serve, porque as réplicas usam o mesmo Postgres. O primeiro `--build` baixa as imagens base e leva alguns minutos.

Para ver as 3 réplicas respondendo (o `instance_id` é o hostname do contêiner):

```bash
for i in $(seq 1 12); do curl -s localhost:8080/metrics | grep -o -m1 'instance_id="[^"]*"'; done | sort | uniq -c
docker compose --profile app ps
```

Para parar:

```bash
docker compose --profile app stop app nginx   # para só a aplicação, a infra continua no ar
docker compose --profile app down             # derruba tudo, inclusive Postgres e LocalStack
bun run infra:up                              # volta a infra depois de um down
```

Ao parar réplicas na mão, espere cerca de 20 s antes de rodar `test:integration`: o LocalStack mantém o `ReceiveMessage` das réplicas paradas vivo até 20 s e entrega a próxima mensagem a essa conexão morta.

## Testes

| Comando | O que roda | Exige | Tempo |
|---|---|---|---|
| `bun run typecheck` | `tsc --noEmit` | nada | 4 s |
| `bun run test:unit` | `test/unit`: domínio puro, sem I/O | nada | 1 s |
| `bun run test:integration` | `test/integration`: app, Postgres e LocalStack reais | `infra:up` + `migration:up` | 1 min |
| `bun run test:concurrency` | `test/concurrency`: paralelismo real, com processos da app (`bun src/main.ts`) | `infra:up` + `migration:up` | 40 s |
| `bun run test` | as três suítes acima de uma vez, com `--timeout 30000` | `infra:up` + `migration:up` | 95 s |
| `bun run test:load` | carga contra 3 réplicas + nginx | Docker, `bun install` e `.env` (o script sobe a infra) | menos de 2 min |

Integração e concorrência rodam contra Postgres e LocalStack reais, sem mocks. Todo teste que mexe em saldo termina conferindo que o saldo da wallet é igual ao saldo reconstruído pelo ledger.

`test:load` é um script, não um spec. Ele sobe a infra, roda `migration:up`, sobe `app` e `nginx` (`docker compose --profile app up -d --build --wait`), abre as wallets, aplica carga por cerca de 60 s, espera a drenagem das filas e da outbox, confere as invariantes no banco e grava `reports/load/load-<runId>.md` e `.json`. No fim para `app` e `nginx` (a infra continua no ar) e espera 21 s antes de devolver o controle. Sai com 0 se as invariantes passam e a drenagem conclui no prazo. Variáveis `LOAD_*`, metodologia e resultados: seção "Teste de carga (§14)" do [ARCHITECTURE.md](ARCHITECTURE.md).

## API HTTP

Todo corpo é JSON. Todo valor monetário é `{ "amount": "25.00", "currency": "BRL" }`, com o valor em texto decimal e duas casas, nunca número.

| Rota | Sucesso |
|---|---|
| `POST /wallets` | 201 `{ id, playerId, balance, version }`; a mesma `playerId` + moeda de novo: 409 `WALLET_ALREADY_EXISTS` |
| `GET /wallets/:walletId` | 200, mesmo corpo |
| `GET /wallets/:walletId/ledger?limit=50&cursor=...` | 200 `{ items, nextCursor }`, mais recente primeiro, `limit` de 1 a 100 |
| `POST /wallets/:walletId/reconciliation` | 200 `{ walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries }` |
| `POST /wagering/transactions` | 200 `PROCESSED`, 202 `PENDING_REFERENCE` ou 422 `REJECTED`; header `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:transactionId` | 200, visão completa da transação |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200, mesma visão |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | ver "Health e métricas" |

O corpo de `POST /wagering/transactions` é `{ providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId? }`. `kind` é `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`. `referenceExternalTransactionId` é obrigatório em `REFUND` e `ROLLBACK` e aponta a transação original; `WIN` e `LOSS` também o usam para apontar a `BET`.

### Roteiro com curl

Rode os blocos em ordem, na mesma sessão de shell, com a aplicação no ar em `http://localhost:3000`. Para as 3 réplicas, troque `BASE` por `http://localhost:8080`.

**1. Preparar variáveis e criar a wallet com 100.00 BRL.**

```bash
BASE=http://localhost:3000
RUN=$(date +%s)
PLAYER="player-$RUN"
ROUND="round-$RUN"

RESP=$(curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/wallets" \
  -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
echo "$RESP"
WALLET=$(echo "$RESP" | head -n1 | jq -r .id)
```

```
{"id":"01a168f8-f2c4-73f3-8f19-7792eb5803c2","playerId":"player-1792762507","balance":{"amount":"100.00","currency":"BRL"},"version":1}
HTTP 201
```

**2. Definir a função que envia uma transação.** Ela monta o corpo, usa `provider-a:<externalTransactionId>` como `Idempotency-Key` (o formato recomendado) e imprime a resposta com o status HTTP.

```bash
# uso: tx <externalTransactionId> <kind> <amount> [referenceExternalTransactionId]
tx() {
  local ref=""
  if [ -n "$4" ]; then ref=",\"referenceExternalTransactionId\":\"$4\""; fi
  curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/wagering/transactions" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: provider-a:$1" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"$ROUND\",\"gameId\":\"slots-1\",\"kind\":\"$2\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}$ref}"
}
```

**3. BET de 25.00.** O corpo que a função envia é:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1792762507",
  "playerId": "player-1792762507",
  "walletId": "01a168f8-f2c4-73f3-8f19-7792eb5803c2",
  "roundId": "round-1792762507",
  "gameId": "slots-1",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

```bash
tx "bet-$RUN" BET 25.00
```

```
{"transactionId":"01a168f8-f2dc-761d-ad09-5b1f758da9d2","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"failureCode":null,"idempotentReplay":false}
HTTP 200
```

**4. Replay: o mesmo pedido de novo.** A mesma key e o mesmo corpo devolvem o resultado original, sem novo débito.

```bash
tx "bet-$RUN" BET 25.00
```

```
{"transactionId":"01a168f8-f2dc-761d-ad09-5b1f758da9d2","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"failureCode":null,"idempotentReplay":true}
HTTP 200
```

**5. Conflito: a mesma key com outro valor.**

```bash
tx "bet-$RUN" BET 30.00
```

```
{"failureCode":"IDEMPOTENCY_CONFLICT","action":"FIX_PAYLOAD","message":"Idempotency key of provider provider-a was already used with a different payload"}
HTTP 409
```

**6. WIN de 50.00 referenciando a BET.**

```bash
tx "win-$RUN" WIN 50.00 "bet-$RUN"
```

O saldo vai a `125.00`, com `PROCESSED` e HTTP 200.

**7. REFUND que chega antes da BET que ele estorna.** A referência ainda não existe: a resposta é 202 `PENDING_REFERENCE` e o saldo não muda. Quando a BET chega, o worker de `PENDING_REFERENCE` aplica o estorno sozinho.

```bash
tx "refund2-$RUN" REFUND 10.00 "bet2-$RUN"
tx "bet2-$RUN" BET 10.00
sleep 5
curl -s "$BASE/providers/provider-a/wagering/transactions/refund2-$RUN" | jq '{status, referenceTransactionId, balanceAfter}'
```

```
{"transactionId":"01a168f8-f321-7609-8583-f044170cf84f","status":"PENDING_REFERENCE","balance":null,"failureCode":null,"idempotentReplay":false}
HTTP 202
{"transactionId":"01a168f8-f336-703d-9fc0-f8853defeb03","status":"PROCESSED","balance":{"amount":"115.00","currency":"BRL"},"failureCode":null,"idempotentReplay":false}
HTTP 200
{
  "status": "PROCESSED",
  "referenceTransactionId": "01a168f8-f336-703d-9fc0-f8853defeb03",
  "balanceAfter": {
    "amount": "125.00",
    "currency": "BRL"
  }
}
```

**8. BET acima do saldo.** É uma rejeição de negócio: fica gravada como `REJECTED` (422) e não gera lançamento.

```bash
tx "bet-big-$RUN" BET 1000.00
```

```
{"transactionId":"01a168f9-0301-76db-87f1-698bf36cfd65","status":"REJECTED","balance":{"amount":"125.00","currency":"BRL"},"failureCode":"INSUFFICIENT_FUNDS","idempotentReplay":false}
HTTP 422
```

**9. Consultar a transação** por id interno e por provider + id externo:

```bash
TX_ID=$(curl -s "$BASE/providers/provider-a/wagering/transactions/bet-$RUN" | jq -r .id)
curl -s "$BASE/wagering/transactions/$TX_ID" | jq .
curl -s "$BASE/providers/provider-a/wagering/transactions/bet-$RUN" | jq .status
```

**10. Ledger da wallet.** Cada alteração de saldo tem um lançamento imutável, do mais recente para o mais antigo. O `nextCursor` vai em `?cursor=` para a próxima página.

```bash
curl -s "$BASE/wallets/$WALLET/ledger?limit=2" | jq .
```

Resposta (com os valores monetários em uma linha só, para caber):

```json
{
  "items": [
    {
      "id": "01a168f8-f444-75c5-b457-1bd1540ce4f1",
      "transactionId": "01a168f8-f321-7609-8583-f044170cf84f",
      "direction": "CREDIT",
      "money": { "amount": "10.00", "currency": "BRL" },
      "balanceBefore": { "amount": "115.00", "currency": "BRL" },
      "balanceAfter": { "amount": "125.00", "currency": "BRL" },
      "createdAt": "2026-10-23T13:35:08.348Z"
    },
    {
      "id": "01a168f8-f336-703e-9459-4129c96d5696",
      "transactionId": "01a168f8-f336-703d-9fc0-f8853defeb03",
      "direction": "DEBIT",
      "money": { "amount": "10.00", "currency": "BRL" },
      "balanceBefore": { "amount": "125.00", "currency": "BRL" },
      "balanceAfter": { "amount": "115.00", "currency": "BRL" },
      "createdAt": "2026-10-23T13:35:08.081Z"
    }
  ],
  "nextCursor": "eyJ2IjoxLCJ3IjoiMDFhMTY4ZjgtZjJjNC03M2YzLThmMTktNzc5MmViNTgwM2MyIiwicyI6IjUifQ"
}
```

**11. Reconciliação.** Compara o saldo guardado com o saldo recalculado pelo ledger. Só lê, nunca corrige.

```bash
curl -s -X POST "$BASE/wallets/$WALLET/reconciliation" | jq .
```

Resposta (idem):

```json
{
  "walletId": "01a168f8-f2c4-73f3-8f19-7792eb5803c2",
  "storedBalance": { "amount": "125.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "125.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 5
}
```

### Erros

Todo erro tem o mesmo formato e o header `X-Correlation-Id` (envie o seu em `X-Correlation-Id` para propagá-lo):

```json
{ "failureCode": "INVALID_PAYLOAD", "action": "FIX_PAYLOAD", "message": "Invalid request", "issues": [{ "path": "headers.idempotency-key", "message": "Invalid input: expected string, received undefined" }] }
```

Resumo dos status: 200 e 201 sucesso, 202 referência pendente, 400 payload inválido, 404 wallet ou transação inexistente, 409 conflito de idempotência ou wallet duplicada, 422 rejeição de negócio e 503 com `Retry-After: 1` para falha transitória (reenvie com a mesma key). A tabela completa e os `failureCode` estão em "API HTTP (§9)" e "Taxonomia de FailureCode (§7.2)" do [ARCHITECTURE.md](ARCHITECTURE.md).

Autenticação não está implementada: há um ponto de extensão (`ProviderIdentityPort`) e o adapter padrão aceita qualquer chamada. Ver "Autenticação (§2)" no [ARCHITECTURE.md](ARCHITECTURE.md).

## Mensagens SQS

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | Entrada: o consumer de cada réplica lê as transações daqui. |
| `wager-transactions-dlq.fifo` | DLQ: recebe a mensagem com falha permanente ou depois de 5 recebimentos. |
| `wagering-events.fifo` | Saída: o publisher da outbox publica aqui os eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged`, só depois do commit. |

As filas são criadas pelo `docker/localstack/init-sqs.sh`, e as URLs têm o formato `http://localhost:4566/000000000000/<fila>`. Não use a saída do `list-queues` como fonte de URL: ela vem em outro formato.

Uma mensagem `WagerTransactionRequested` tem o envelope `{ messageId, type, occurredAt, data }`. O `data` leva os mesmos campos do corpo HTTP, mais `idempotencyKey` opcional (sem ela, vale `providerId:externalTransactionId`). O `messageId` é a chave da inbox: a mesma mensagem entregue duas vezes é processada uma só. O atributo de mensagem `correlationId` (String) é opcional. A fila é FIFO sem deduplicação por conteúdo: o `MessageDeduplicationId` é obrigatório, e o `MessageGroupId` recomendado é o `walletId`, que mantém em ordem as mensagens da mesma wallet.

Com a aplicação no ar e a wallet do roteiro (`PLAYER`, `WALLET` e `RUN` ainda definidos), envie uma BET de 10.00:

```bash
MSG=$(cat <<EOF
{
  "messageId": "msg-$RUN",
  "type": "WagerTransactionRequested",
  "occurredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "sqs-bet-$RUN",
    "playerId": "$PLAYER",
    "walletId": "$WALLET",
    "roundId": "round-sqs-$RUN",
    "gameId": "slots-1",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }
}
EOF
)

docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" \
  --message-deduplication-id "msg-$RUN" \
  --message-body "$MSG"
```

Dentro do contêiner, `localhost:4566` é o próprio LocalStack. A resposta traz `MD5OfBody`, `MessageId` e `SequenceNumber`. Para conferir o efeito, consulte a transação pela API (ela aparece em poucos segundos):

```bash
sleep 3
curl -s "$BASE/providers/provider-a/wagering/transactions/sqs-bet-$RUN" | jq '{status, balanceAfter}'
```

```json
{
  "status": "PROCESSED",
  "balanceAfter": { "amount": "115.00", "currency": "BRL" }
}
```

Para ler os eventos publicados (resumo por tipo e `aggregateId`; as mensagens não são apagadas e voltam a ficar visíveis em 30 s):

```bash
docker compose exec -T localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events.fifo \
  --max-number-of-messages 10 \
  | jq -r '.Messages[].Body | fromjson | "\(.eventType) \(.aggregateId)"'
```

Para ver a DLQ em ação, envie uma mensagem cujo corpo não é JSON. É uma falha permanente: a mensagem vai para a DLQ sem retry.

```bash
docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id bad-messages \
  --message-deduplication-id "bad-$RUN" \
  --message-body 'isto não é json'

sleep 3
docker compose exec -T localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --max-number-of-messages 10 | jq -r '.Messages[].Body'
```

Falha transitória (banco indisponível, lock) volta para a fila com backoff exponencial e vai para a DLQ no 5º recebimento. A mensagem só é apagada depois do commit. Detalhes em "Consumer SQS (§10, §5.3)" do [ARCHITECTURE.md](ARCHITECTURE.md).

## Health e métricas

```bash
curl -s localhost:3000/health/live | jq .       # {"status":"ok"}
curl -s localhost:3000/health/ready | jq .      # 200 se Postgres e SQS respondem, senão 503
curl -s localhost:3000/metrics | head -n 4      # formato Prometheus (a saída completa é longa)
```

Resposta de `/health/ready`:

```json
{
  "status": "ok",
  "checks": {
    "postgres": { "status": "up" },
    "sqs": { "status": "up" }
  }
}
```

`/health/live` só diz que o processo está de pé. `/health/ready` verifica Postgres e SQS e, se uma delas cair, responde 503 com `"status": "unavailable"` e marca `"down"` nessa dependência. As três rotas são públicas.

As métricas têm o label `instance_id` (a réplica). As de negócio mais úteis são `wager_transactions_total` (decisões por status, kind e origem), `wager_transaction_duplicates_total` (replays por idempotency key ou inbox), `sqs_consumer_messages_total` (desfecho de cada mensagem) e `outbox_publish_lag_seconds` (atraso entre o evento e a publicação). A tabela completa está em "Métricas (§12)" do [ARCHITECTURE.md](ARCHITECTURE.md).

```bash
curl -s localhost:3000/metrics | grep -E '^(wager_transactions_total|wager_transaction_duplicates_total)'
```

Os logs saem em JSON no stdout, com `correlationId`, `instanceId` e, quando há, `messageId`, `transactionId`, `walletId` e `providerId`. Nunca levam payload completo nem valores financeiros. O nível vem de `LOG_LEVEL`. Nas réplicas: `docker compose --profile app logs -f app`.

## Configuração

O `.env.example` é a referência, com todas as variáveis comentadas. A aplicação valida o ambiente no boot e falha rápido se algo estiver faltando ou inválido.

| Variável | Para que serve |
|---|---|
| `DATABASE_URL` | Conexão com o Postgres (`DATABASE_POOL_MAX` ajusta o pool por instância) |
| `AWS_REGION`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | SQS (no setup local, LocalStack com credenciais `test`) |
| `SQS_WAGER_QUEUE_URL`, `SQS_WAGER_DLQ_URL`, `SQS_EVENTS_QUEUE_URL` | URLs das três filas |
| `PORT`, `LOG_LEVEL`, `INSTANCE_ID` | Porta HTTP, nível de log e nome da instância nos logs e métricas |
| `SQS_CONSUMER_ENABLED` | Liga ou desliga o consumer SQS desta instância (padrão `true`) |
| `OUTBOX_PUBLISHER_ENABLED` | Liga ou desliga o publisher da outbox (padrão `true`) |
| `PENDING_REFERENCE_WORKER_ENABLED` | Liga ou desliga o worker de `PENDING_REFERENCE` (padrão `true`) |

As réplicas do compose recebem a própria configuração no `docker-compose.yml` (Postgres e LocalStack pelos nomes de serviço), não o `.env`.

## Comandos úteis

```bash
bun run infra:up                          # sobe Postgres e LocalStack e espera ficarem healthy
bun run infra:down                        # derruba os contêineres e mantém o volume do Postgres
bun run infra:reset                       # derruba e apaga o volume do Postgres

bun run migration:up                      # aplica as migrations pendentes
bun run migration:down                    # desfaz a última
bun run migration:list                    # lista as aplicadas e as pendentes
bun run migration:create --name <nome>    # gera uma migration em src/infrastructure/database/migrations

docker compose --profile app up -d --build --wait   # 3 réplicas + nginx
docker compose --profile app stop app nginx         # para só a aplicação
docker compose --profile app down                   # derruba tudo, inclusive a infra
docker compose --profile app logs -f app            # logs das réplicas

docker compose exec postgres psql -U wagering -d wagering   # console SQL
```

Use sempre os scripts `bun run migration:*`: o bin `mikro-orm` chamado pelo nome não carrega o `.env` sob o Bun.

## Estrutura

```
src/
  main.ts, app.module.ts
  config/env.ts                 # validação do ambiente (zod)
  health/                       # /health/live e /health/ready
  shared/                       # Money, FailureCode, erros de domínio, portas Clock e IdGenerator
  modules/
    wallet/                     # Wallet, ledger, reconciliação
    wagering/                   # WagerTransaction, regras BET/WIN/LOSS/REFUND/ROLLBACK, idempotência
    messaging/                  # inbox, outbox, consumer SQS, publisher da outbox
  infrastructure/               # banco e migrations, HTTP, auth, observabilidade, runtime
test/
  unit/  integration/  concurrency/   # as três suítes
  load/                         # script de carga (test:load)
  support/                      # helpers: app de teste, reset do banco, fixtures
docker/                         # init das filas do LocalStack e nginx.conf
```

Cada módulo tem `domain/` (TypeScript puro), `application/` (casos de uso e portas), `infrastructure/` (adapters) e `presentation/` (controllers e DTOs). Mais detalhes na "Visão geral" do [ARCHITECTURE.md](ARCHITECTURE.md).

## Problemas comuns

- **Porta ocupada.** Mude a porta do lado do host: `POSTGRES_PORT`, `LOCALSTACK_PORT` ou `APP_PORT` no `.env` (o compose lê esse arquivo). Se mudar `POSTGRES_PORT` ou `LOCALSTACK_PORT`, ajuste também `DATABASE_URL`, `AWS_ENDPOINT_URL` e as três URLs de fila no `.env`. A porta da app local é o `PORT`.
- **LocalStack pede `LOCALSTACK_AUTH_TOKEN`.** As imagens novas do LocalStack exigem token. Por isso a tag está fixada em `4.14.0`: não troque.
- **`relation ... does not exist`.** Falta `bun run migration:up`.
- **Testes falham com contagens erradas.** Há um `bun run dev` ou as réplicas do compose no ar. Pare a aplicação e rode de novo (ver "Do clone aos testes verdes").
- **`test:integration` falha logo depois de parar as réplicas.** Espere cerca de 20 s (o `test:load` já espera 21 s no fim).
- **`too many connections`.** O Postgres do compose aceita 200 conexões. Com N réplicas, o uso é N x `DATABASE_POOL_MAX`, mais os testes de concorrência: reduza `DATABASE_POOL_MAX`.
- **O `docker compose --profile app down` derrubou a infra.** É esperado: rode `bun run infra:up`.
