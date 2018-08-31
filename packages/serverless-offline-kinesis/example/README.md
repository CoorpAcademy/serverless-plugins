# Getting started

```shell
# Start containers
docker-compose up -d

# Start serverless-offline
npm start

# Trigger events
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyFirstStream --data "MyFirstMessage" --partition-key "MyFirstMessage"
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MySecondStream --data "MySecondMessage" --partition-key "MySecondMessage"
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyThirdStream --data "MyThirdMessage" --partition-key "MyThirdMessage"
aws kinesis --endpoint-url http://localhost:4567 put-record --stream-name MyFourthStream --data "MyFourthMessage" --partition-key "MyFourthMessage"
```