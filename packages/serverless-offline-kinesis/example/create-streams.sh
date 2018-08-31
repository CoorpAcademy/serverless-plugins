#!/bin/sh
trap "exit 1" INT

AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://localhost:9324}

STREAMS="MyFirstStream MySecondStream MyThirdStream MyFourthStream";
for STREAM_NAME in $STREAMS
do 
    until aws kinesis --endpoint-url ${AWS_ENDPOINT_URL}  describe-stream --stream-name ${STREAM_NAME}  > /dev/null 2> /dev/null
    do
    echo "Creating stream $STREAM_NAME"
    aws kinesis --endpoint-url ${AWS_ENDPOINT_URL} create-stream \
        --stream-name ${STREAM_NAME} \
        --shard-count 1 \
        > /dev/null 2> /dev/null
    done
done

trap - INT