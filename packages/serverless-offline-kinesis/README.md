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

Then inside your project's `serverless.yml` file, add following entry to the plugins section before `serverless-offline` (and after `serverless-webpack` if presents): `serverless-offline-kinesis`.

```yml
plugins:
  - serverless-webpack
  - serverless-offline-kinesis
  - serverless-offline
```

[See example](../../tests/serverless-plugins-integration/README.md#kinesis)

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
```

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
