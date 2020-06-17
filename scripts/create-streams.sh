#!/bin/sh
trap "exit 1" INT

AWS_ENDPOINT_URL=${AWS_ENDPOINT_URL:-http://localhost:4567}

STREAMS="MyFirstStream MySecondStream MyThirdStream MyFourthStream";
for STREAM in $STREAMS
do 
    until aws kinesis --endpoint-url ${AWS_ENDPOINT_URL}  describe-stream --stream-name ${STREAM}  > /dev/null 2> /dev/null
    do
    echo "Creating stream $STREAM"
    aws kinesis --endpoint-url ${AWS_ENDPOINT_URL} create-stream \
        --stream-name ${STREAM} \
        --shard-count 1 \
        > /dev/null 2> /dev/null
    done &
done

wait

trap - INT
