# @coorpacademy/serverless-offline-eventbridge

This Serverless-offline plugin emulates AWS λ and EventBridge on your local machine. It exposes a
local `PutEvents` endpoint, routes every published event through a real EventBridge **EventPattern**
matcher, and invokes the matching handlers through `serverless-offline`'s own Lambda runner.

_Features_:

- In-process `PutEvents` endpoint + in-memory event bus — **no extra container required**.
- Real EventBridge **EventPattern** matching (`source`, `detail-type`, nested `detail`, `resources`,
  `$or`, and the content filters `prefix`, `suffix`, `anything-but`, `exists`, `equals-ignore-case`,
  `numeric`, `wildcard`, `cidr`).
- Honors both function-level `eventBridge:` events **and** raw CloudFormation `AWS::Events::Rule`
  resources.
- Retry with backoff, and optional `destinations.onFailure` (DLQ) simulation against a local SQS
  endpoint.

## Serverless Framework v4

This plugin supports **both Serverless Framework v3 and v4**. It takes the logger from the plugin
constructor's 3rd argument (`{log}`) and falls back to `console` when it is absent, so no
configuration change is required when upgrading.

## Installation

First, add `@coorpacademy/serverless-offline-eventbridge` to your project:

```sh
npm install @coorpacademy/serverless-offline-eventbridge
```

Then inside your project's `serverless.yml` file, add the following entry to the plugins section
before `serverless-offline`:

```yml
plugins:
  - '@coorpacademy/serverless-offline-eventbridge'
  - serverless-offline
```

## How it works?

By default the plugin starts a tiny in-process HTTP server (Node core `http`, no extra dependency)
that accepts AWS `PutEvents` requests (`X-Amz-Target: AWSEvents.PutEvents`,
`Content-Type: application/x-amz-json-1.1`). Each published entry is turned into the canonical
EventBridge event envelope, matched against every subscriber's EventPattern, and the matching Lambda
handlers are invoked through `serverless-offline`. A target failure never fails the `PutEvents`
response (mirroring AWS), but is retried and, once retries are exhausted, optionally routed to the
function's `destinations.onFailure`.

Point your AWS SDK EventBridge client at `http://<host>:<port>` (default `http://127.0.0.1:4010`) to
publish events locally.

## Configure

### Functions

Function-level `eventBridge` events follow the
[serverless documentation](https://www.serverless.com/framework/docs/providers/aws/events/event-bridge).

```yml
functions:
  myHandler:
    handler: handler.compute
    events:
      - eventBridge:
          eventBus: default
          pattern:
            source:
              - my.app
            detail-type:
              - OrderPlaced
            detail:
              status:
                - CONFIRMED
```

### CloudFormation `AWS::Events::Rule` resources

Rules declared directly in `resources` are also honored: the plugin scans for `AWS::Events::Rule`
resources whose `Targets[].Arn` is `{Fn::GetAtt: [<FunctionLogicalId>, Arn]}`, maps the target back
to its function, and registers the rule's `EventPattern`.

```yml
resources:
  Resources:
    OrderPlacedRule:
      Type: AWS::Events::Rule
      Properties:
        EventBusName: default
        EventPattern:
          source:
            - my.app
          detail-type:
            - OrderPlaced
        Targets:
          - Id: myHandler
            Arn:
              Fn::GetAtt:
                - MyHandlerLambdaFunction
                - Arn
```

### EventBridge plugin options

Configure the plugin via a `custom: serverless-offline-eventbridge` object in your `serverless.yml`:

```yml
custom:
  serverless-offline-eventbridge:
    host: 127.0.0.1            # bind host for the PutEvents endpoint
    port: 4010                 # PutEvents endpoint port
    accountId: '000000000000'  # event `account` + event-bus ARN
    maximumRetryAttempts: 10   # dispatch retry budget
    retryDelayMs: 500          # delay between retries
    debug: false               # verbose logging of options + subscriptions
    mockServer: true           # run the in-process PutEvents endpoint
    simulateDestinations: true # route exhausted async failures to destinations.onFailure
    endpoint: http://localhost:9324  # AWS endpoint for the onFailure SQS / opt-in subscribe clients
    subscribe: false           # opt-in: poll a real `events` bus at `endpoint`
    pollInterval: 1000         # LocalStack opt-in poll cadence (ms)
```

| Option | Default | Purpose |
|--------|---------|---------|
| `host` | `127.0.0.1` | bind host for the PutEvents endpoint |
| `port` | `4010` | PutEvents endpoint port |
| `region` | from `provider.region` | event `region` field + ARN build |
| `accountId` | `000000000000` | event `account` + event-bus ARN |
| `maximumRetryAttempts` | `10` | dispatch retry budget |
| `retryDelayMs` | `500` | delay between retries |
| `debug` | `false` | verbose logging |
| `endpoint` | `undefined` | AWS endpoint for the onFailure SQS / opt-in subscribe clients |
| `subscribe` | `false` | opt-in: poll a real `events` bus at `endpoint` |
| `mockServer` | `true` | run the in-process PutEvents endpoint |
| `simulateDestinations` | `true` | route exhausted async failures to `destinations.onFailure` |
| `pollInterval` | `1000` | LocalStack opt-in poll cadence (ms) |

## Supported EventPattern content filters

`prefix` (including `{prefix: {equals-ignore-case}}`), `suffix`, `anything-but`, `exists`,
`equals-ignore-case`, `numeric` (multi-clause, e.g. `['>', 0, '<=', 100]`), `wildcard` (`*` glob),
and `cidr`. An **unknown** filter key is treated as a non-match (it never throws).

## Attribution

The EventPattern matching algorithm is adapted in spirit from
[`rubenkaiser/serverless-offline-aws-eventbridge`](https://github.com/rubenkaiser/serverless-offline-aws-eventbridge)
(MIT), rewritten as pure `lodash/fp` helpers. See [`NOTICE`](./NOTICE).
