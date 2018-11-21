# Getting started

```shell
# Start containers
docker-compose up -d

# Start serverless-offline
npm start

# Trigger events
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyFirstStream --partition-key "MyFirstMessage" --data "MyFirstMessage"
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MySecondStream --partition-key "MySecondMessage" --data "MySecondMessage"
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyThirdStream --partition-key "MyThirdMessage" --data "MyThirdMessage"
aws kinesis --endpoint-url http://localhost:4567 put-record --data "MyFourthMessage" --partition-key "MyFourthMessage" --stream-name MyFourthStream
```
