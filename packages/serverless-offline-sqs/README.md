# serverless-offline-sqs

This Serverless-offline plugin emulates AWS λ and SQS queue on your local machine. To do so, it listens SQS queue and invokes your handlers.

_Features_:

- [Serverless Webpack](https://github.com/serverless-heaven/serverless-webpack/) support.
- SQS configurations: batchsize.

## Serverless Framework v4

This plugin supports **both Serverless Framework v3 and v4**. Serverless v4 removed the
`@serverless/utils/log` module and `serverless.cli.log`; the plugin now takes the logger from the
plugin constructor's 3rd argument (`{log}`) and falls back to `console` when it is absent, so it keeps
working under v3 as well. No configuration change is required when upgrading.

## Installation

First, add `serverless-offline-sqs` to your project:

```sh
npm install serverless-offline-sqs
```

Then inside your project's `serverless.yml` file, add following entry to the plugins section before `serverless-offline` (and after `serverless-webpack` if present): `serverless-offline-sqs`.

```yml
plugins:
  - serverless-webpack
  - serverless-offline-sqs
  - serverless-offline
```

[See example](../../tests/serverless-plugins-integration/README.md#sqs)

## How it works?

To be able to emulate AWS SQS queue on local machine there should be some queue system actually running. One of the existing implementations suitable for the task is [ElasticMQ](https://github.com/adamw/elasticmq).

[ElasticMQ](https://github.com/adamw/elasticmq) is a standalone in-memory queue system, which implements AWS SQS compatible interface. It can be run either stand-alone or inside Docker container. See [example](../../tests/serverless-plugins-integration/serverless.sqs.yml) `sqs` service setup.

We also need to setup actual queue in ElasticMQ server, we can use [AWS cli](https://aws.amazon.com/cli/) tools for that. In example, we spawn-up another container with `aws-cli` pre-installed and run initialization script, against ElasticMQ server in separate container.

Once ElasticMQ is running and initialized, we can proceed with the configuration of the plugin.

Note that starting from version v3.1 of the plugin, it supports autocreation of SQS fifo queues that are specified in the cloudformation `Resources`.

## Configure

### Functions

The configuration of function of the plugin follows the [serverless documentation](https://serverless.com/framework/docs/providers/aws/events/sqs/).

```yml
functions:
  mySQSHandler:
    handler: handler.compute
    events:
      - sqs: arn:aws:sqs:region:XXXXXX:MyFirstQueue
      - sqs:
          arn: arn:aws:sqs:region:XXXXXX:MySecondQueue
      - sqs:
          queueName: MyThirdQueue
          arn:
            Fn::GetAtt:
              - MyThirdQueue
              - Arn
      - sqs:
          arn:
            Fn::GetAtt:
              - MyFourthQueue
              - Arn
      - sqs:
          arn:
            Fn::GetAtt:
              - MyFifthQueue
              - Arn
resources:
  Resources:
    MyFourthQueue:
      Type: AWS::SQS::Queue
      Properties:
        QueueName: MyFourthQueue

    MyFifthQueue: # Support for Fifo queue creation starts from 3.1 only
      Type: AWS::SQS::Queue
      Properties:
        QueueName: MyFifthQueue.fifo
        FifoQueue: true
        ContentBasedDeduplication: true
```

### SQS

The configuration of [`aws.SQS`'s client](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SQS.html#constructor-property) of the plugin is done by defining a `custom: serverless-offline-sqs` object in your `serverless.yml` with your specific configuration.

You could use [ElasticMQ](https://github.com/adamw/elasticmq) with the following configuration:

```yml
custom:
  serverless-offline-sqs:
    autoCreate: true                 # create queue if not exists
    apiVersion: '2012-11-05'
    endpoint: http://0.0.0.0:9324
    region: eu-west-1
    accessKeyId: root
    secretAccessKey: root
    skipCacheInvalidation: false
    queueName: my-local-queue        # optional: override every sqs event's queue name locally
    enabled: true                    # optional: set false to skip the SQS emulator locally (#222)
```

#### Disabling the plugin locally (#222)

Set `custom.serverless-offline-sqs.enabled: false` (or pass `--enabled false`) to skip the SQS
emulator entirely while still running your HTTP lambdas under `serverless-offline`. This is handy when
you only want to test a few HTTP functions and don't want to start ElasticMQ/Docker. The plugin is
enabled by default when the flag is absent.

#### `queueName` override

Setting `custom.serverless-offline-sqs.queueName` overrides the queue name resolved from each `sqs`
event definition. This is handy when your local ElasticMQ queue is named differently from the one
declared in your `serverless.yml` events, without having to edit the function event configuration.
