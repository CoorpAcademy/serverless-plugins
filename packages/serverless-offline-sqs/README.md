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

We also need to setup actual queue in ElasticMQ server, we can use [AWS cli](https://aws.amazon.com/cli/) tools for that. In example, we spawn-up another container with `aws-cli` pre-installed and run initialization script, against ElasticMQ server in separate container. A full, runnable reference lives in [`tests/serverless-plugins-integration`](../../tests/serverless-plugins-integration/README.md#sqs) ([`docker-compose.yml`](../../tests/serverless-plugins-integration/docker-compose.yml), [`serverless.sqs.yml`](../../tests/serverless-plugins-integration/serverless.sqs.yml)).

Once ElasticMQ is running and initialized, we can proceed with the configuration of the plugin.

Note that starting from version v3.1 of the plugin, it supports autocreation of SQS fifo queues that are specified in the cloudformation `Resources`.

### ElasticMQ quickstart (#160)

The fastest local setup is a single ElasticMQ container. Create these two files next to your
`serverless.yml` and you have an SQS-compatible endpoint that runs out of the box — nothing else to
install.

`docker-compose.yml`:

```yml
services:
  elasticmq:
    image: softwaremill/elasticmq-native:latest
    ports:
      - '9324:9324' # SQS API
      - '9325:9325' # ElasticMQ web UI (optional)
    volumes:
      - ./elasticmq.conf:/opt/elasticmq.conf:ro
```

`elasticmq.conf` (HOCON) — binds the node address so the host/port you point the SDK at is reachable,
and optionally pre-declares queues so you don't even need `autoCreate`:

```hocon
include classpath("application.conf")

# `*` lets the container answer on whatever host you use in the endpoint
# (localhost from the host, or the compose service name from another container).
node-address {
    protocol = http
    host = "*"
    port = 9324
    context-path = ""
}

rest-sqs {
    enabled = true
    bind-port = 9324
    bind-hostname = "0.0.0.0"
}

# Optional: declare queues up-front (otherwise set `autoCreate: true`, see below).
queues {
    MyFirstQueue {}
}

# Keep these aligned with your plugin config (see the SQS section).
aws {
    region = eu-west-1
    accountId = 000000000000
}
```

Start it with `docker compose up elasticmq`, then run `serverless offline` on the host pointing at
`http://localhost:9324` (see the [SQS](#sqs) config below). If you'd rather not write a config file,
the bare `docker run -p 9324:9324 -p 9325:9325 softwaremill/elasticmq-native` works too.

### Dead-letter queues & redrive (`#167`, `#133`, `#65`, `#87`)

When `autoCreate: true`, the plugin now creates **every** `AWS::SQS::Queue` declared in
`resources.Resources` — not only the queues wired to a lambda `sqs` event. This means a dead-letter
queue (DLQ) that exists purely to back another queue's `RedrivePolicy.deadLetterTargetArn`, and is
never itself bound to a function, is created too (#65, #133).

Queues are created in dependency order: a DLQ is always created **before** the queue that redrives to
it, so `createQueue` no longer fails offline with `AWS.SimpleQueueService.NonExistentQueue` (#167,
#133). Chained DLQs (`A → B → C`) are ordered `C, B, A`, and self/cyclic references are tolerated
without looping. The `RedrivePolicy` (including `maxReceiveCount`) and `MessageRetentionPeriod`
attributes are forwarded to `createQueue`, so a message that exceeds `maxReceiveCount` is moved to the
DLQ by the local queue system instead of being redelivered forever (#87).

```yml
resources:
  Resources:
    MainQueue:
      Type: AWS::SQS::Queue
      Properties:
        QueueName: MainQueue
        MessageRetentionPeriod: 1209600
        RedrivePolicy:
          deadLetterTargetArn:
            Fn::GetAtt:
              - MainDlq
              - Arn
          maxReceiveCount: 5
    MainDlq: # never referenced by a function — still autocreated, before MainQueue
      Type: AWS::SQS::Queue
      Properties:
        QueueName: MainDlq
```

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

The `arn` of an `sqs` event may be a plain string or a CloudFormation intrinsic — `Fn::GetAtt`,
`Fn::Join`, `Fn::Sub`, and `Ref` to the `AWS::Region` / `AWS::AccountId` pseudo-parameters are
resolved locally. The `#{AWS::AccountId}` syntax from
[`serverless-pseudo-parameters`](https://www.npmjs.com/package/serverless-pseudo-parameters) is
supported too (#74, #200). The queue name is taken from the last `:`-delimited segment of the
resolved ARN, so a `.fifo` suffix is preserved.

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
    waitTimeSeconds: 5               # optional: default ReceiveMessage long-poll wait, 0-20s (#123)
```

#### `endpoint` and custom ports (#161)

`custom.serverless-offline-sqs.endpoint` is the **only** thing that decides where the plugin talks to
SQS — the value is passed straight through to the AWS SDK client and is also copied onto every queue
URL the plugin resolves (host, scheme **and** port). There is nothing special about `9324`: **any
port is honored**, as long as the port in `endpoint` matches the port your ElasticMQ container
actually publishes.

```yml
custom:
  serverless-offline-sqs:
    endpoint: http://0.0.0.0:9325   # any port works — must match the published container port
    accessKeyId: root
    secretAccessKey: root
```

```yml
# docker-compose.yml — publish the SAME port you put in `endpoint`
services:
  elasticmq:
    image: softwaremill/elasticmq-native:latest
    ports:
      - '9325:9324' # host 9325 -> container 9324; endpoint above uses 9325
```

If you see `UnknownEndpoint: Inaccessible host` on a non-default port, the port in `endpoint` and the
port your container exposes are out of sync — align them and the plugin connects.

#### Inside docker-compose: networking & the `http://` scheme (#130)

When the plugin runs in its **own** container alongside ElasticMQ (rather than on the host), three
things must hold:

1. **Same network.** Both services must be on a shared compose network so they can resolve each other
   (compose puts services on a default network automatically; don't isolate them).
2. **Host = the service name, not `localhost`.** From inside a container, `localhost` is that
   container itself. Use the ElasticMQ **service name** as the host — e.g. if the service is
   `elasticmq`, the endpoint is `http://elasticmq:9324`.
3. **The `http://` scheme is mandatory.** If you drop it (`elasticmq:9324`), the AWS SDK defaults to
   **HTTPS** and ElasticMQ — which speaks plain HTTP — rejects the handshake with
   _"Perhaps this was an HTTPS request sent to an HTTP endpoint?"_. Always keep the explicit
   `http://`.

```yml
# docker-compose.yml — app and ElasticMQ on the shared compose network
services:
  app:
    build: .
    command: npm run offline
    depends_on:
      - elasticmq
  elasticmq:
    image: softwaremill/elasticmq-native:latest
    ports:
      - '9324:9324'
```

```yml
# serverless.yml — host is the service name, scheme is explicit http://
custom:
  serverless-offline-sqs:
    autoCreate: true
    endpoint: http://elasticmq:9324
    accessKeyId: root
    secretAccessKey: root
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

#### `waitTimeSeconds` long-poll default (#123)

By default the plugin polls each queue with a `ReceiveMessage` `WaitTimeSeconds` of **5s** (SQS long
polling). Set `custom.serverless-offline-sqs.waitTimeSeconds` (or pass `--waitTimeSeconds <n>`) to
change that default — e.g. `0` for an instant short-poll, or up to `20` for the maximum long poll.
The value is coerced from a string (YAML/CLI may deliver it as text) and clamped to the SQS-supported
range `[0, 20]`. A function event that sets its own `maximumBatchingWindow` still wins over this
default for that queue.

```yml
custom:
  serverless-offline-sqs:
    waitTimeSeconds: 0   # instant short-poll locally; or up to 20 for full long polling
```
