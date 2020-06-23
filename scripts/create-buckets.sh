#!/bin/sh
trap "exit 1" INT

AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://localhost:9000}

BUCKETS="documents pictures files"
for BUCKET in $BUCKETS
do 
    until aws --endpoint-url ${AWS_ENDPOINT_URL} s3 ls s3://${BUCKET} > /dev/null 2> /dev/null
    do
    echo "Creating bucket $BUCKET"
    aws --endpoint-url ${AWS_ENDPOINT_URL} s3 \
        mb s3://${BUCKET} \
        > /dev/null 2> /dev/null
    done &
done

wait

trap - INT
