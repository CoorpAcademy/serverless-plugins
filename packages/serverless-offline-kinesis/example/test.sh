#!/bin/sh
trap "exit 1" INT

aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyFirstStream  --partition-key "MyFirstMessage"  --data "MyFirstMessage"  &
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MySecondStream --partition-key "MySecondMessage" --data "MySecondMessage" &
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyThirdStream  --partition-key "MyThirdMessage"  --data "MyThirdMessage"  &
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyFourthStream --partition-key "MyFourthMessage" --data "MyFourthMessage" &
wait

trap - INT