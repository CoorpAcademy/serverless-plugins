#!/bin/sh
trap "exit 1" INT

AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://localhost:8000}

TABLES="MyFirstTable MySecondTable MyThirdTable MyFourthTable";
for TABLE_NAME in $TABLES
do 
    until aws dynamodb  --endpoint-url ${AWS_ENDPOINT_URL} describe-table --table-name ${TABLE_NAME} > /dev/null 2> /dev/null
    do
    echo "Creating table $TABLE_NAME"
    aws dynamodb --endpoint-url ${AWS_ENDPOINT_URL} create-table \
        --table-name ${TABLE_NAME} \
        --attribute-definitions AttributeName=id,AttributeType=S \
        --key-schema AttributeName=id,KeyType=HASH \
        --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 \
        --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
        > /dev/null 2> /dev/null
    done
done

trap - INT