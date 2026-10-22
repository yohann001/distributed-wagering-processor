#!/bin/bash
# Executado pelo LocalStack quando fica pronto (/etc/localstack/init/ready.d).
# Cria a fila FIFO de eventos de integração (publisher da outbox, T23), a fila FIFO principal e a DLQ com redrive policy.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"

# Destino do publisher da outbox. Sem DLQ: a outbox reenvia para sempre. Criada antes da fila de transações, porque o
# healthcheck do compose espera `wager-transactions.fifo` e significa "todas as filas existem".
awslocal --region "$REGION" sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

awslocal --region "$REGION" sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

DLQ_ARN=$(awslocal --region "$REGION" sqs get-queue-attributes \
  --queue-url "http://localhost:4566/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal --region "$REGION" sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"false\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}\"
  }"

echo "SQS queues ready: wagering-events.fifo; wager-transactions.fifo -> wager-transactions-dlq.fifo (maxReceiveCount=${MAX_RECEIVE_COUNT})"
