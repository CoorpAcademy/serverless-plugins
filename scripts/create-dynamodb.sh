#!/bin/sh

AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://localhost:8000}

if aws dynamodb --endpoint-url ${AWS_ENDPOINT_URL} describe-table --table-name polls > /dev/null 2> /dev/null
then
  echo "Stream already exists"
else
  echo "Creating stream"
  aws dynamodb create-table \
    --table-name polls \
    --attribute-definitions AttributeName=Id,AttributeType=S \
    --key-schema AttributeName=Id,KeyType=HASH \
    --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 \
    --endpoint-url ${AWS_ENDPOINT_URL}
fi

