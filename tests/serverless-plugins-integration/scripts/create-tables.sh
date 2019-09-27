#!/bin/sh
trap "exit 1" INT

AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://localhost:8000}

TABLES="MyFirstTable MySecondTable MyThirdTable MyFourthTable";
for TABLE in $TABLES
do 
    until aws dynamodb  --endpoint-url ${AWS_ENDPOINT_URL} describe-table --table-name ${TABLE} > /dev/null 2> /dev/null
    do
    echo "Creating table $TABLE"
    aws dynamodb --endpoint-url ${AWS_ENDPOINT_URL} create-table \
        --table-name ${TABLE} \
        --attribute-definitions AttributeName=id,AttributeType=S \
        --key-schema AttributeName=id,KeyType=HASH \
        --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 \
        --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
        > /dev/null 2> /dev/null
    done &
done

wait

trap - INT