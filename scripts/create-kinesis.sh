#!/bin/sh

if aws kinesis --endpoint-url http://kinesis:4567 describe-stream --stream-name polls > /dev/null 2> /dev/null
then
  echo "Stream already exists"
else
  echo "Creating stream"
  aws kinesis create-stream --endpoint-url http://kinesis:4567 --stream-name polls --shard-count 5 > /dev/null
fi
