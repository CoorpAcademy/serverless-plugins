# serverless-offline-dynamodb-streams

This Serverless-offline-dynamodb-streams plugin emulates AWS λ and DynamoDBStreams on your local machine. To do so, it listens DynamoDBStreams stream and invokes your handlers.

*Features*:
- [Serverless Webpack](https://github.com/serverless-heaven/serverless-webpack/) support.
- DynamoDBStreams configurations: batchsize and startingPosition.
- Restart checkpoint: records already processed before a restart are not re-delivered (#178).

## Serverless Framework v4

This plugin is compatible with both Serverless Framework **v3** and **v4**. Serverless v4 removed the global `@serverless/utils/log` and `serverless.cli.log` APIs; the plugin now reads the structured logger from the third constructor argument injected by the framework (`{log}`) and falls back to `console` when run standalone, so no configuration change is required on either version.

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

## Restart checkpoint (#178)

To match production DynamoDB-stream semantics, the plugin persists a per-shard restart
checkpoint. After each handler invocation **resolves**, the sequence number of the last
record in that batch is written to a small state file. On the next start the plugin
resumes **after** the saved sequence number (`AFTER_SEQUENCE_NUMBER`) for each shard, so
records already processed before a restart are **not** re-delivered — even with
`startingPosition: TRIM_HORIZON`. With no saved checkpoint (cold start) the configured
`startingPosition` (`LATEST` / `TRIM_HORIZON`) is honored as before.

The state file defaults to `.serverless-offline-dynamodb-streams.json` in the working
directory and is gitignored. Override its path with the `checkpointFile` custom option
(absolute, or relative to the working directory):

```yml
custom:
  serverless-offline-dynamodb-streams:
    checkpointFile: .cache/ddb-streams-checkpoint.json
```

A missing parent directory is created automatically, and a missing or malformed state
file is treated as a clean cold start (no error).

**Delivery boundary (at-most-once across a restart).** The checkpoint advances *only
after* the handler resolves, so a record is never marked done before it has been
processed. The trade-off is at-most-once **for the in-flight batch across a hard crash**:
if the process is killed *after* the handler ran but *before* its checkpoint reached
disk, that batch is re-delivered on restart (at-least-once); if it is killed *while* the
handler is running, that batch is also re-delivered. Handlers should therefore be
idempotent, exactly as AWS recommends for real stream consumers.
