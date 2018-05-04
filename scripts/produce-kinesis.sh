#!/bin/sh

AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://localhost:4567}

if aws kinesis --endpoint-url ${AWS_ENDPOINT_URL} describe-stream --stream-name polls > /dev/null 2> /dev/null
then
  aws kinesis --endpoint-url ${AWS_ENDPOINT_URL} put-record --stream-name polls --partition-key "0000" --data "foo"
else
  echo "Stream dont exist"
fi
