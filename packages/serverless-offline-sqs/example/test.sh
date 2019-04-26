#!/bin/sh
trap "exit 1" INT

aws sqs --endpoint-url http://localhost:9324 send-message --queue-url http://localhost:9324/queue/MyFirstQueue  --message-body "MyFirstMessage"  &
aws sqs --endpoint-url http://localhost:9324 send-message --queue-url http://localhost:9324/queue/MySecondQueue --message-body "MySecondMessage" &
aws sqs --endpoint-url http://localhost:9324 send-message --queue-url http://localhost:9324/queue/MyThirdQueue  --message-body "MyThirdMessage"  &
aws sqs --endpoint-url http://localhost:9324 send-message --queue-url http://localhost:9324/queue/MyFourthQueue --message-body "MyFourthMessage" &
wait

trap - INT