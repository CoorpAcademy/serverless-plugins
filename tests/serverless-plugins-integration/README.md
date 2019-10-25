# Getting started

### Dynamodb Streams
```shell
# Start containers
docker-compose up -d

# Start serverless-offline
npm run start:dynamodb-streams

# Trigger events
aws dynamodb --endpoint-url http://localhost:8000 put-item --table-name MyFirstTable  --item '{"id": {"S": "MyFirstId"}}'  &
aws dynamodb --endpoint-url http://localhost:8000 put-item --table-name MySecondTable --item '{"id": {"S": "MySecondId"}}' &
aws dynamodb --endpoint-url http://localhost:8000 put-item --table-name MyThirdTable  --item '{"id": {"S": "MyThirdId"}}'  &
aws dynamodb --endpoint-url http://localhost:8000 put-item --table-name MyFourthTable --item '{"id": {"S": "MyFourthId"}}' &
wait
```

### Sqs
# Getting started

```shell
# Start containers
docker-compose up -d

# Start serverless-offline
npm run start:sqs

# Trigger events
aws sqs --endpoint-url http://localhost:9324 send-message --queue-url http://localhost:9324/queue/MyFirstQueue  --message-body "MyFirstMessage"  &
aws sqs --endpoint-url http://localhost:9324 send-message --queue-url http://localhost:9324/queue/MySecondQueue --message-body "MySecondMessage" &
aws sqs --endpoint-url http://localhost:9324 send-message --queue-url http://localhost:9324/queue/MyThirdQueue  --message-body "MyThirdMessage"  &
aws sqs --endpoint-url http://localhost:9324 send-message --queue-url http://localhost:9324/queue/MyFourthQueue --message-body "MyFourthMessage" &
wait
```

# How to run test suite

You need to install `docker` and `docker-compose`.

```
npm test
```

## Kinesis


```shell
# Start containers
docker-compose up -d

# Start serverless-offline
npm run start:kinesis

# Trigger events
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyFirstStream  --partition-key "MyFirstMessage"  --data "MyFirstMessage"  &
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MySecondStream --partition-key "MySecondMessage" --data "MySecondMessage" &
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyThirdStream  --partition-key "MyThirdMessage"  --data "MyThirdMessage"  &
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyFourthStream --partition-key "MyFourthMessage" --data "MyFourthMessage" &
wait
```
