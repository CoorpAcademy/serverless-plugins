# serverless-offline-kinesis

This Serverless-offline-kinesis plugin emulates AWS λ and Kinesis streams on your local machine. To do so, it listens Kinesis stream and invokes your handlers.

*Features*:
- [Serverless Webpack](https://github.com/serverless-heaven/serverless-webpack/) support.
- Kinesis configurations: batchsize and startingPosition.

## Installation

First, add `serverless-offline-kinesis` to your project:

```sh
npm install serverless-offline-kinesis
```

Then inside your project's `serverless.yml` file, add following entry to the plugins section before `serverless-offline` (and after `serverless-webpack` if present): `serverless-offline-kinesis`.

```yml
plugins:
  - serverless-webpack
  - serverless-offline-kinesis
  - serverless-offline
```

[See example](../../tests/serverless-plugins-integration/README.md#kinesis)

## Serverless Framework v4

This plugin is compatible with both Serverless Framework **v3** and **v4**. Serverless v4 removed the global `@serverless/utils/log` and `serverless.cli.log` APIs; the plugin now reads the structured logger from the third constructor argument injected by the framework (`{log}`) and falls back to `console` when run standalone, so no configuration change is required on either version.

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
          type: kinesis
          arn: arn:aws:kinesis:eu-west-1:XXXXXX:stream/polls
          batchSize: 10
          startingPosition: TRIM_HORIZON
          maximumRetryAttempts: 10
```

When a handler invocation throws, the plugin retries it (500ms backoff) up to `maximumRetryAttempts` times (default `10`) and logs each failed attempt, instead of retrying forever silently.

### Kinesis

The configuration of [`aws.Kinesis`'s client](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Kinesis.html#constructor-property) of the plugin is done by defining a `custom: serverless-offline-kinesis` object in your `serverless.yml` with your specific configuration.

You could use [mhart's Kinesalite](https://github.com/mhart/kinesalite) with the following configuration:

```yml
custom:
  serverless-offline-kinesis:
    apiVersion: '2013-12-02'
    endpoint: http://0.0.0.0:4567
    region: eu-west-1
    accessKeyId: root
    secretAccessKey: root
    skipCacheInvalidation: false
    readInterval: 500
```
