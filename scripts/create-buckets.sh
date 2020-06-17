#!/bin/sh
trap "exit 1" INT

AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://s3:9000}
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-local}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-local}
AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-eu-west-1}

echo  "here is ${AWS_ACCESS_KEY_ID} "

aws configure set aws_access_key_id ${AWS_ACCESS_KEY_ID}
aws configure set aws_secret_access_key ${AWS_SECRET_ACCESS_KEY}
aws configure set default.region ${AWS_DEFAULT_REGION}


aws --endpoint-url ${AWS_ENDPOINT_URL} s3 mb s3://documents
aws --endpoint-url ${AWS_ENDPOINT_URL} s3 mb s3://pictures
aws --endpoint-url ${AWS_ENDPOINT_URL} s3 mb s3://files

wait

trap - INT