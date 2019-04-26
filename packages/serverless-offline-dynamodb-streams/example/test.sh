#!/bin/sh
trap "exit 1" INT

aws dynamodb --endpoint-url http://localhost:8000 put-item --table-name MyFirstTable  --item '{"id": {"S": "MyFirstId"}}'  &
aws dynamodb --endpoint-url http://localhost:8000 put-item --table-name MySecondTable --item '{"id": {"S": "MySecondId"}}' &
aws dynamodb --endpoint-url http://localhost:8000 put-item --table-name MyThirdTable  --item '{"id": {"S": "MyThirdId"}}'  &
aws dynamodb --endpoint-url http://localhost:8000 put-item --table-name MyFourthTable --item '{"id": {"S": "MyFourthId"}}' &
wait

trap - INT