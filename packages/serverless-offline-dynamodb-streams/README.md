# serverless-offline-dynamodb-streams

This Serverless-offline-dynamodb-streams plugin emulates AWS λ and DynamoDBStreams on your local machine. To do so, it listens DynamoDBStreams stream and invokes your handlers.

*Features*:
- [Serverless Webpack](https://github.com/serverless-heaven/serverless-webpack/) support.
- DynamoDBStreams configurations: batchsize and startingPosition.

## Serverless Framework v4

This plugin is compatible with both Serverless Framework **v3** and **v4**. Serverless v4 removed the global `@serverless/utils/log` and `serverless.cli.log` APIs; the plugin now reads the structured logger from the third constructor argument injected by the framework (`{log}`) and falls back to `console` when run standalone, so no configuration change is required on either version.

## AWS SDK v3

As of this release the plugin uses the modular [AWS SDK for JavaScript **v3**](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/welcome.html) (`@aws-sdk/client-dynamodb` and `@aws-sdk/client-dynamodb-streams`) instead of the end-of-support `aws-sdk` v2 package, which removes the AWS-SDK-v2 maintenance-mode warning ([#248](https://github.com/CoorpAcademy/serverless-plugins/issues/248)). The plugin options are unchanged: it still accepts the flat `region`/`endpoint`/`accessKeyId`/`secretAccessKey` keys and normalizes them into the v3 client config internally, so existing `custom.serverless-offline-dynamodb-streams` configuration keeps working as-is.

## Installation

First, add `serverless-offline-dynamodb-streams` to your project:

```sh
npm install serverless-offline-dynamodb-streams
```

Then inside your project's `serverless.yml` file, add following entry to the plugins section before `serverless-offline` (and after `serverless-webpack` if present): `serverless-offline-dynamodb-streams`.

```yml
plugins:
  - serverless-webpack
  - serverless-offline-dynamodb-streams
  - serverless-offline
```

[See example](../../tests/serverless-plugins-integration/README.md#dynamodb-streams)

## Configure

### Functions

Ths configuration of function of the plugin follows the [serverless documentation](https://serverless.com/framework/docs/providers/aws/events/streams/).

```yml
functions:
  myKinesisHandler:
    handler: handler.compute
    events:
      - stream:
          enabled: true
          type: dynamodb
          arn: arn:aws:dynamodb:eu-west-1:XXXXXX:table/myStream/stream/2018-07-02T19:48:31.121
          batchSize: 10
          startingPosition: TRIM_HORIZON
```


### DynamoDB

The configuration of [`aws.DynamoDBStreams`'s client](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDBStreams.html#constructor-property) of the plugin is done by defining a `custom: serverless-offline-dynamodb-streams` object in your `serverless.yml` with your specific configuration.

You could use [mhart's Dynalite](https://github.com/mhart/dynalite) with the following configuration:

```yml
custom:
  serverless-offline-dynamodb-streams:
    apiVersion: '2013-12-02'
    endpoint: http://0.0.0.0:8000
    region: eu-west-1
    accessKeyId: root
    secretAccessKey: root
    skipCacheInvalidation: false
    readInterval: 500
```

> `arn` could be deduce from `tableName` if your add the key `tableName` in your function's configuration. Useful if your use dynalite and regularly recreate a new DynamoDBStreams.

```yml
functions:
  myKinesisHandler:
    handler: handler.compute
    events:
      - stream:
          enabled: true
          type: dynamodb
          tableName: myTable
```
