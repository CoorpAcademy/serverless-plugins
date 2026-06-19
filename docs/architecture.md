# Architecture Guide — `serverless-plugins` monorepo

> Definitive engineering reference for this repository. Every claim below is grounded in source with `path:line` references. Read this before touching any plugin.

---

## 1. What this repo is

A Lerna **independent**-versioned, npm-workspaces monorepo of Serverless Framework plugins. The headline products are four local-emulation plugins for the Serverless Framework `serverless-offline` ecosystem (S3, SQS, Kinesis, DynamoDB Streams), plus two standalone utility packages.

- Workspaces: `package.json:7-10` → `["packages/*", "tests/*"]`, root is `"private": true`.
- Lerna: `lerna.json:1-3` → `packages: ["packages/*","tests/*"]`, `version: "independent"`.
- Module system: **CommonJS only** (`main: "src"`, no transpile step). ESM is used **only** through dynamic `import()` (see §5).
- Node floor: `engines.node: ">=18"` in root (`package.json:4-6`) and every package; `.nvmrc` = `v18.18.2`.

---

## 2. Monorepo layout

| Path | Package name | Version | Kind |
|---|---|---|---|
| `packages/serverless-offline-s3` | `serverless-offline-s3` | 7.0.0 (`package.json:3`) | offline plugin (Minio/push) |
| `packages/serverless-offline-sqs` | `serverless-offline-sqs` | 8.0.0 (`package.json:3`) | offline plugin (ElasticMQ/poll) |
| `packages/serverless-offline-kinesis` | `serverless-offline-kinesis` | 7.0.0 (`package.json:3`) | offline plugin (kinesalite/stream) |
| `packages/serverless-offline-dynamodb-streams` | `serverless-offline-dynamodb-streams` | 7.0.0 (`package.json:3`) | offline plugin (dynamodb-local/stream) |
| `packages/dynamodb-streams-readable` | `dynamodb-streams-readable` | 3.0.0 (`package.json:3`) | utility lib (Node readable over DDB Streams) |
| `packages/serverless-apigateway-access-logs` | `serverless-apigateway-access-logs` | 2.0.0 (`package.json:4`) | deploy-time CloudFormation plugin |
| `packages/serverless-offline-ssm-provider` | — | — | **stub** — only `README.md`, **no `package.json`** (not buildable/publishable) |
| `tests/serverless-plugins-integration` | `serverless-offline-plugins-integration` | 4.0.0 | **private** docker-based integration harness |

### 2.1 The standard per-plugin file quartet

Every `serverless-offline-*` plugin ships the same four-file shape. Mirror this when adding a service:

| File | Role | Class |
|---|---|---|
| `src/index.js` | Serverless plugin shell: `hooks`, lifecycle, option merge, event extraction, ARN resolution | `ServerlessOffline<Service>` |
| `src/<svc>.js` | Emulator/driver: holds the AWS/Minio client + the listen/poll loop, invokes Lambda | `<Service>` (e.g. `SQS`, `Kinesis`, `S3`) |
| `src/<svc>-event.js` | Maps raw AWS records → the Lambda event shape (`this.Records = [...]`) | `<Service>Event` |
| `src/<svc>-event-definition.js` | Normalizes the user's `serverless.yml` event config (ARN / `{arn}` / `{name}`) | `<Service>EventDefinition` |

---

## 3. The shared 4-plugin lifecycle & hooks pattern

All four `index.js` files are near-identical. Line refs use **s3** as canonical unless a divergence is called out.

### 3.1 Constructor

Two-arg classic plugin signature — `constructor(serverless, cliOptions)` (`serverless-offline-s3/src/index.js:20`). It uses the house **declare-null-then-assign** idiom: every instance field is set to `null` first, then the two real args are reassigned (`index.js:21-28`). This is intentional house style documenting the instance shape — do not "clean it up".

> Note: the Serverless v3+ constructor 3rd argument `{log, writeText, progress, ...}` (the structured logger / `v3Utils`) is **never captured** (`s3/index.js:20`, `sqs:35`, `kinesis:19`, `ddb:19`). Logging is instead a module-global import (§3.6).

### 3.2 Hooks map (identical across all four)

`serverless-offline-s3/src/index.js:30-35`:

```js
this.hooks = {
  'offline:start:init':  this.start.bind(this),    // newer serverless-offline lifecycle
  'offline:start:ready': this.ready.bind(this),
  'offline:start':       this._startWithReady.bind(this),  // legacy single-event fallback
  'offline:start:end':   this.end.bind(this)
};
```

These are **`serverless-offline`'s own** lifecycle events — the plugin piggybacks on it (`serverless-offline` is a `peerDependency: "^10.0.2 || >=11"`, dev-depended at `^13`). Two code paths coexist:
- Modern: `offline:start:init` → `start()`, then `offline:start:ready` → `ready()`, then `offline:start:end` → `end()`.
- Legacy: `offline:start` → `_startWithReady()` (`index.js:78-81`), which just `await this.start(); this.ready();`.

⚠️ If an installed `serverless-offline` emits **both** families, `start()`/`ready()` can run twice — `_startWithReady` re-runs the whole pipeline.

### 3.3 `start()` sequence (`index.js:38-58`)

1. `process.env.IS_OFFLINE = true` — assigns a **boolean** (`index.js:39`); Node coerces env vars to strings, so readers see `'true'`. Harmless footgun.
2. `this._mergeOptions()` builds `this.options` (§4).
3. `const {<svc>Events, lambdas} = this._getEvents()` scans functions (§6).
4. `await this._createLambda(lambdas)` instantiates the runner & registers all functions (§5).
5. If `<svc>Events.length > 0`, push `this._create<Service>(...)` into an `eventModules` array, then `await Promise.all(eventModules)` (`index.js:47-53`). The array-of-promises is vestigial — there is only ever one service per plugin.
6. `this.serverless.cli.log('Starting Offline <Service> at stage ... (...)')`. Detail differs: **s3** logs `${endPoint}/${region}` (`s3/index.js:56`); sqs/kinesis/ddb log just `${region}` (e.g. `sqs/index.js:71`). The integration harness greps these exact banners (§9).

### 3.4 `ready()` & termination

`ready()` (`index.js:60-64`) registers SIGINT/SIGTERM handlers via `_listenForTermination()` **only** when `process.env.NODE_ENV !== 'test'`. `_listenForTermination` (`index.js:66-76`) logs `Got <signal> signal. Offline Halting...` and `await this.end()`.

### 3.5 `end(skipExit)` teardown (`index.js:83-105`)

1. Guard: `if (NODE_ENV === 'test' && skipExit === undefined) return;` — a hook-driven `end()` during tests is a **no-op**. To actually tear down in a test, call `end(true)` (cleanup, no exit) or `end(false)` (cleanup + exit).
2. `this.serverless.cli.log('Halting offline server')`.
3. Build `eventModules`: if `this.lambda` → `this.lambda.cleanup()`; if `this.<service>` → `this.<service>.stop(SERVER_SHUTDOWN_TIMEOUT)` where `SERVER_SHUTDOWN_TIMEOUT = 5000` (`index.js:10`).
4. `await Promise.all(eventModules)`.
5. `if (!skipExit) process.exit(0)` (`index.js:102-104`) — the deliberate hard kill (serverless-offline otherwise keeps the loop alive via readables/queues/listeners).

⚠️ The hard `process.exit(0)` will cut off any other plugin's `offline:start:end` hooks that run after this one. ⚠️ `SERVER_SHUTDOWN_TIMEOUT` is passed to every `stop(timeout)` but **ignored by every emulator** — there is no graceful drain (see §7).

### 3.6 Logging contract

Module-global import, not the injected logger: `const log = require('@serverless/utils/log').log;` (`s3/index.js:3`). Used at `log.debug('options:', this.options)` in `_mergeOptions` (`index.js:143`) plus `log.warn`/`log.warning` in the s3/sqs drivers.

⚠️ **Drift:** s3 uses `log.warn` (`s3/s3.js:69,117`); sqs uses `log.warning` (`sqs/sqs.js:141,173`). The `@serverless/utils/log` API method is `warning`; `warn` is likely a silent no-op. ⚠️ **Missing import:** `kinesis/kinesis.js` and `dynamodb-streams/dynamodb-streams.js` do **not** import `log` at all and silently swallow handler errors (kinesis.js:91-94, dynamodb-streams.js:105-110). ⚠️ `@serverless/utils` is **not declared** in any of the four `package.json` files — it resolves transitively via the `serverless`/`serverless-offline` peer (can break under strict/PnP installs; eslint allowlists it at `.eslintrc.js:27-30`).

> **v4 break:** `@serverless/utils/log` and `serverless.cli` were both removed in Serverless v4. Both are used pervasively (the require at the top of every file; `serverless.cli.log` at e.g. `sqs/index.js:70,86,103`). A v4 migration must replace the module-global `log` with the injected 3rd-arg `{log}` and replace `serverless.cli.log` with `log.notice`/`writeText`.

---

## 4. Option merging — `_mergeOptions` (`index.js:126-144`)

Identical across plugins. `omitUndefined = omitBy(isUndefined)` (`index.js:17`). Precedence, **lowest → highest** (later `Object.assign` source wins):

```js
this.options = Object.assign(
  {},
  omitUndefined(defaultOptions),                                         // 1. per-plugin constant
  omitUndefined(provider),                                               // 2. whole service.provider (region, stage, ...)
  omitUndefined(pick(['location','localEnvironment'], offlineOptions)),  // 3. custom['serverless-offline'] (webpack support)
  omitUndefined(customOptions),                                          // 4. custom['serverless-offline-<svc>']
  omitUndefined(this.cliOptions)                                         // 5. CLI flags (win over everything)
);
log.debug('options:', this.options);
```

`OFFLINE_OPTION = 'serverless-offline'` and `CUSTOM_OPTION = 'serverless-offline-<svc>'` are defined per file (`index.js:7-8`). `defaultOptions` differs per plugin:

| Plugin | `defaultOptions` | Ref |
|---|---|---|
| s3 | `{batchSize: 100, startingPosition: 'TRIM_HORIZON'}` | `s3/index.js:12-15` |
| sqs | `{batchSize: 100, startingPosition: 'TRIM_HORIZON', autoCreate: false, accountId: '000000000000'}` | `sqs/index.js:24-30` |
| kinesis | `{accountId: '000000000000'}` | `kinesis/index.js:12-14` |
| dynamodb-streams | `{accessKeyId: '000000000000'}` (note: **`accessKeyId`**, not `accountId`) | `ddb/index.js:12-14` |

---

## 5. The Lambda-runner dynamic import — `_createLambda` (`index.js:107-112`)

```js
async _createLambda(lambdas) {
  const {default: Lambda} = await import('serverless-offline/lambda');  // ESM-only subpath
  this.lambda = new Lambda(this.serverless, this.options);
  this.lambda.create(lambdas);
}
```

`serverless-offline/lambda` is a **native ESM** module in modern serverless-offline (v11/v13/v14), so it cannot be `require()`d from these CJS plugins. The dynamic `import()` is the interop bridge — hence `_createLambda` is `async` and the default export is destructured as `{default: Lambda}`. This is the **sole** reason `.eslintrc.js:33-36` allows `dynamicImport` in an otherwise Node-≥16-CJS codebase.

Invocation contract (identical everywhere): `const lambdaFunction = this.lambda.get(functionKey); lambdaFunction.setEvent(eventObject); await lambdaFunction.runHandler();` (e.g. `s3/s3.js:62-67`, `sqs/sqs.js:117-122`, `kinesis/kinesis.js:85-90`, `ddb/dynamodb-streams.js:99-104`). Teardown is `this.lambda.cleanup()` (in `end()`).

⚠️ `lambda.create(lambdas)` is **not awaited** in any of the four plugins (`index.js:111`/`126`/`110`/`110`). It happens to be synchronous in current serverless-offline.

---

## 6. Event extraction & ARN resolution — `_getEvents` / `_resolveFn`

`_getEvents()` (`index.js:146-178`) iterates `service.getAllFunctions()`. For each `functionKey`:
- `service.getFunction(functionKey)` → push `{functionKey, functionDefinition}` into `lambdas`. **Every** function is registered with the runner, regardless of events (this is why lambdas can run even without matching events).
- `service.getAllEventsInFunction(functionKey) || []` → for each event, match the plugin's event type and, if `functionDefinition.handler` exists, push the per-service event descriptor.

Matching differs per plugin:

| Plugin | Match | ARN resolution | Ref |
|---|---|---|---|
| s3 | `const {s3} = event; if (s3 && handler)` | none (literal bucket name) | `s3/index.js:162-170` |
| sqs | `const {sqs} = this._resolveFn(event)` — whole event run through resolver first | deep `Fn::GetAtt` walker | `sqs/index.js:177` |
| kinesis | `stream.type === 'kinesis' \|\| startsWith('arn:aws:kinesis', stream)`, push `kinesis: this._resolveFn(stream)` | shallow resolver | `kinesis/index.js:159-170` |
| dynamodb-streams | `stream.type === 'dynamodb' \|\| startsWith('arn:aws:dynamodb', stream)`, push `dynamodbStreams: this._resolveFn(stream)` | shallow resolver | `ddb/index.js:159-170` |

### 6.1 `_resolveFn` — two distinct implementations

**(a) sqs — recursive deep object walker** (`sqs/index.js:195-233`). Reads `service.resources.Resources`, walks every key/value via `pipe(toPairs, map(...), compact, fromPairs)`. When it finds `Fn::GetAtt: [resourceName, 'Arn']` on a resource of `Type === 'AWS::SQS::Queue'`, it synthesizes `arn:aws:sqs:${region}:${accountId}:${queueName}` from `Resources[resourceName].Properties.QueueName` (`sqs/index.js:203-217`). ⚠️ **Every other** `Fn::GetAtt` attribute/type resolves to `null` and is dropped by `compact` (`sqs/index.js:218-225`) — unrelated CloudFormation references inside the resources tree are silently deleted. `_getResources()` for sqs returns `this._resolveFn(Resources)` (`sqs/index.js:235-238`).

**(b) kinesis / dynamodb-streams — shallow single-purpose resolver** (`kinesis/index.js:181-198`, `ddb/index.js:181-198`). If the event already has a literal `streamName`/`tableName` string, return it as-is. Otherwise read `event.arn['Fn::GetAtt']`, take `resourceName`, look up `Resources[resourceName].Properties`, `throw new Error('No resource defined with name <resourceName>')` if missing, then mutate the event via `assign(event, {streamName: properties.Name})` (kinesis, reads **`Name`**) or `{tableName: properties.TableName}` (dynamodb).

⚠️ Property-name asymmetry across services: sqs uses `QueueName`, kinesis uses `Name`, dynamodb uses `TableName`. Easy to get wrong when copy-adapting.

s3 has **no** `_resolveFn`; `_getResources()` returns `Resources` verbatim (`s3/index.js:180-183`).

---

## 7. Emulator sub-modules (per package)

All drivers expose the same public surface: `create(events)`, `start()`, `stop(timeout)`. Private methods are `_`-prefixed. A module-level `const delay = timeout => new Promise(r => setTimeout(r, timeout))` recurs for retry-with-backoff (defined identically in s3.js/sqs.js/kinesis.js/dynamodb-streams.js).

### 7.1 S3 — `serverless-offline-s3/src/s3.js` (push-based)

- **Client:** Minio (`new Minio.Client(...)`, `s3.js:25-31`). Endpoint URL is parsed and split into `endPoint`/`port`/`useSSL` via `lodash/fp assign`; `useSSL = protocol !== 'http:'`. (S3 declares `aws-sdk` in its `package.json:33` but **uses minio, not aws-sdk** — dead dependency.)
- **Wait for resource:** `_waitFor(bucket)` (`s3.js:89-95`) recurses on `client.bucketExists(bucket)` with a fixed 1000ms `delay`, no cap. Called in `create()` (`s3.js:42`) **and again** in `start()` (`s3.js:51`).
- **Listen (server-push):** `start()` (`s3.js:47-77`) computes `prefix`/`suffix` from event `rules` (defaulting both to `'*'`), then `client.listenBucketNotification(bucket, prefix, suffix, [event])` and registers a `'notification'` handler that wraps each record in `S3Event` and runs the handler. The **only** event-driven (push) emulator; the others poll.
- **Stop:** `stop(timeout)` (`s3.js:79-82`) calls `listener.stop()` on each tracked listener and clears the array. `timeout` ignored.
- ⚠️ **Dead code:** `_create` (`s3.js:84-87`) and `_s3Event` (`s3.js:97-125`) are never called (the plugin calls the public `create()`). Worse, `_s3Event` calls `listener.stop()` immediately after registering (`s3.js:122`), which would deafen the listener. They are the **only** consumer of `S3EventDefinition`. Safe to delete.
- ⚠️ Mixed mutation style in one file: `this.listeners = [...this.listeners, listener]` (immutable, `s3.js:74`) coexists with `this.listeners.push(...)` (mutating, `s3.js:124`).

### 7.2 SQS — `serverless-offline-sqs/src/sqs.js` (poll + batch via p-queue)

- **Client:** aws-sdk **v2** `aws-sdk/clients/sqs` (`new SQSClient(this.options)`, `sqs.js:34`). Targets ElasticMQ.
- **Poll loop:** `p-queue` with `{autoStart:false}` (`sqs.js:36`). `start()` = `queue.start()`, `stop()` = `queue.pause()`. Each event schedules a `job` (`sqs.js:112-147`) that **re-enqueues itself** (`this.queue.add(job)`, `sqs.js:145`) — this is the polling loop. p-queue serializes jobs, so all SQS sources share one in-flight slot.
- **Batch read:** `getMessages(batchSize)` (`sqs.js:95-110`) recursively long-polls `receiveMessage` (MaxNumberOfMessages capped at 10, `WaitTimeSeconds:5`, `AttributeNames`/`MessageAttributeNames` = `['All']`) accumulating up to `batchSize` (default 10). After a successful handler it deletes in chunks of 10 via `deleteMessageBatch` (`sqs.js:124-139`). ⚠️ Delete is inside the same `try` as the handler, so a failed handler means messages are **not** deleted and will be re-polled.
- **autoCreate (unique to SQS):** when `this.options.autoCreate` (`sqs.js:89`), `_createQueue` (`sqs.js:158-175`) looks up CFN properties via `_getResourceProperties` (matches a resource whose `Properties.QueueName === queueName`, `sqs.js:150-156`), then `createQueue` with `Attributes` = each property `JSON.stringify`'d if object else `toString`. Retries up to 5× on `AWS.SimpleQueueService.NonExistentQueue`. ⚠️ It blindly stringifies **all** properties, including CFN intrinsics (`RedrivePolicy`, `Policy: {Ref:...}`) — DLQ-from-RedrivePolicy handling existed historically but was lost in a rewrite.
- **Endpoint rewrite:** `_rewriteQueueUrl` (`sqs.js:61-73`) rewrites the returned QueueUrl host/protocol/auth/port to the configured `endpoint`.
- ⚠️ **Dead helper:** `_getQueueUrl` (`sqs.js:75-82`, 10s retry loop) is never used — `_sqsEvent` calls `this.client.getQueueUrl(...).promise()` directly (`sqs.js:92`), so a transient queue-URL failure is unhandled.

### 7.3 Kinesis — `serverless-offline-kinesis/src/kinesis.js` (stream pipe per shard)

- **Client:** aws-sdk **v2** `aws-sdk/clients/kinesis` (`kinesis.js:2`) + 3rd-party `kinesis-readable` (`kinesis.js:3`). Targets kinesalite.
- **Wait for resource:** `_describeStream` (`kinesis.js:47-58`) `waitFor('streamExists')` then `describeStream`; recurses on **any** error with **no delay** (a persistent failure becomes a tight infinite loop).
- **Listen:** `_kinesisEvent` (`kinesis.js:60-108`) describes the stream, then **per shard** creates `KinesisReadable(client, streamName, {...event, shardId, limit:batchSize, iterator:startingPosition})` and pipes it into a `Writable({objectMode:true})` that builds a `KinesisEvent` and runs the handler; `readable.pause()` immediately so nothing flows until `start()`.
- **Start/stop:** `start()` resumes all readables, `stop()` pauses them (`kinesis.js:29-35`).
- ⚠️ **Retry:** on handler error it retries **infinitely** after 500ms (`task()` recursion, `kinesis.js:91-94`), with **no logging** (no `log` import). Failures are invisible.

### 7.4 DynamoDB Streams — `serverless-offline-dynamodb-streams/src/dynamodb-streams.js` (stream pipe per shard)

- **Clients (two):** `aws-sdk/clients/dynamodb` (`this.client`) + `aws-sdk/clients/dynamodbstreams` (`this.streamsClient`), `dynamodb-streams.js:22-23`. Targets dynamodb-local.
- **Wait for resource:** `_describeTable` (`dynamodb-streams.js:52-63`) `waitFor('tableExists')` then `describeTable`; recurses on any error (no delay). Then `_dynamodbStreamsEvent` reads `Table.LatestStreamArn` and calls `streamsClient.describeStream({StreamArn})` to enumerate shards (`dynamodb-streams.js:71-81`). ⚠️ If the table has no stream, `LatestStreamArn` is `undefined` → opaque AWS error (no guard).
- **Listen:** same per-shard pattern as Kinesis but using the **in-repo** `dynamodb-streams-readable` package (`dynamodb-streams.js:84-92`).
- ✅ **Retry (finite, unlike Kinesis):** `task(remainingAttempts)` honors `maximumRetryAttempts` (default 10, used as `maximumRetryAttempts - 1`) with 500ms backoff (`dynamodb-streams.js:97-113`).

### 7.5 Emulator quick-comparison

| Aspect | S3 | SQS | Kinesis | DynamoDB Streams |
|---|---|---|---|---|
| Driver file | `s3.js` | `sqs.js` | `kinesis.js` | `dynamodb-streams.js` |
| Client | Minio | aws-sdk v2 `clients/sqs` | aws-sdk v2 `clients/kinesis` + `kinesis-readable` | aws-sdk v2 `clients/dynamodb` + `/dynamodbstreams` + in-repo `dynamodb-streams-readable` |
| Local target | minio | ElasticMQ | kinesalite | dynamodb-local |
| Delivery model | **push** (`listenBucketNotification`) | poll (`p-queue` self-requeue) | stream pipe per shard | stream pipe per shard |
| Batching | 1 record / invocation | up to `batchSize` (default 10) | readable `limit` = `batchSize` | readable `limit` = `batchSize` |
| Wait-for | `bucketExists` recurse, 1s delay | `getQueueUrl` (direct, no retry) | `waitFor streamExists` recurse, no delay | `waitFor tableExists` recurse, no delay |
| Handler-error retry | none (logs `log.warn`) | none (logs `log.warning`, no delete) | **infinite** (no log) | **finite** `maximumRetryAttempts` (no log) |
| `stop(timeout)` honors timeout? | no | no | no | no |

### 7.6 Event-shape classes

| Class | Builds | Notable | Ref |
|---|---|---|---|
| `S3Event` | `this.Records = [record]` | trivial; relies on Minio emitting AWS-shaped records | `s3-event.js:1-5` |
| `SQSEvent` | full Lambda SQS record per message | `messageAttributes` lower-first-keyed; `eventSource:'aws:sqs'` | `sqs-event.js:3-26` |
| `KinesisEvent` | `{kinesis:{partitionKey, data(base64), sequenceNumber}, eventID:'${shardId}:${seq}', ...}` | `invokeIdentityArn:'arn:aws:iam::serverless:role/offline'` | `kinesis-event.js:1-19` |
| `DynamodbStreamsEvent` | `assign({eventSourceARN, awsRegion})` over each record | ⚠️ class is literally named `KinesisEvent` internally (copy-paste; functionally fine) | `dynamodb-streams-event.js:3-12` |

### 7.7 Event-definition normalizers

All use a `switch ('string') { case typeof x: ... }` runtime-type-branch trick to accept a string ARN, `{arn}`, or `{name}` form, then `Object.assign(this, omit([...], raw))` to merge passthrough config.

| Class | Defaults | ARN builds | Ref |
|---|---|---|---|
| `SQSEventDefinition` | `enabled` → always true (see bug below) | `arn:aws:sqs:${region}:${accountId}:${queueName}` | `sqs-event-definition.js:8-43` |
| `KinesisEventDefinition` | `batchSize:10, startingPosition:'LATEST'` | `arn:aws:kinesis:${region}:${accountId}:${streamName}` | `kinesis-event-definition.js:9-47` |
| `DynamodbStreamsEventDefinition` | `batchSize:100, maximumRetryAttempts:10, startingPosition:'LATEST'` | `arn:aws:dynamodb:${region}:${accountId}:${tableName}` | `dynamodb-streams-event-definition.js:9-48` |

⚠️ **`enabled` is broken in all three:** `let enabled;` is declared but **never assigned** from the raw def, then `this.enabled = isNil(enabled) ? true : enabled` (always `true`), and the `Object.assign(this, omit([...,'enabled'], raw))` **strips** `enabled` (e.g. `sqs-event-definition.js:10,32,38`). So `enabled: false` in config is silently ignored.

⚠️ **Copy-paste bug:** `kinesis-event-definition.js:42` omits `['arn','tableName','enabled']` — `tableName` is a DynamoDB field; it should omit `streamName`. Harmless today (the value matches) but wrong key.

### 7.8 The `this.region` bug (all three stream/queue drivers)

`this.region` is **read but never assigned**. Drivers build the emitted event with `this.region` — `sqs/sqs.js:119`, `kinesis/kinesis.js:87`, `ddb/dynamodb-streams.js:101` — but the constructors only set `this.options` (no `this.region = options.region` anywhere). Result: `awsRegion` in **every** emitted Lambda record is `undefined`. The fix is `this.options.region` at those three call sites. (The event-*definition* classes correctly use `this.options.region` for the ARN, so only the live event's `awsRegion` field is affected.)

---

## 8. The two utility packages

### 8.1 `dynamodb-streams-readable` (`src/index.js`, v3.0.0)

A standalone published library implementing a Node readable-stream client over an aws-sdk `DynamoDBStreams` client. `DynamoDBStreamReadable(client, arn, options)` returns `readable.pipe(checkpoint)` — a `Readable` feeding a `Transform`.

- `getShardIterator` (`index.js:48-73`) picks `ShardIteratorType` from `options.iterator` (`LATEST`/`TRIM_HORIZON`, validated at `index.js:30-31`), else `startAt`→`AT_SEQUENCE_NUMBER`, `startAfter`→`AFTER_SEQUENCE_NUMBER`, else `TRIM_HORIZON`.
- `describeStream` (`index.js:75-92`) selects the shard by `options.shardId` (or the first shard), errors if missing.
- `read` (`index.js:94-131`) calls `getRecords` with `Limit: options.limit`; on `TrimmedDataAccessException` re-describes and retries; empty result sets re-poll after `options.readInterval || 500`ms; absence of `NextShardIterator` sets `drain = true`.
- `checkpoint._transform` (`index.js:147-150`) emits a `checkpoint` event with the last record's `dynamodb.SequenceNumber`. `.close()` (`index.js:167-171`) sets drain and triggers a final read so `end` fires once drained.
- ⚠️ Reassigns its `options`/`arn` params and mutates closure-scoped `let iterator, drain, ended, pending` throughout (callback-style stream code; `no-param-reassign` is off).
- This is the **only** package with real tests — `test/index.js` is an ava suite that runs against **dynamodb-local at `http://localhost:8000`** (so even the "unit" suite needs docker). It is workspace-linked into `serverless-offline-dynamodb-streams` locally; consumers get the npm-published `^3.0.0`.

### 8.2 `serverless-apigateway-access-logs` (`src/index.js`, v2.0.0)

A **deploy-time** plugin (no emulation). Class `ExtendDeploymentWithAccessLogs`.

- **Constructor validation (fail-fast):** reads `custom['serverless-apigateway-access-logs']` and throws if missing, or if `format` / `log-group` are absent (`index.js:8-18`).
- **Hook:** `before:aws:package:finalize:mergeCustomProviderResources` → `bindDeploymentId` (`index.js:19-21`).
- **Behavior** (`bindDeploymentId`, `index.js:24-63`): finds the `AWS::ApiGateway::Deployment` in the compiled CloudFormation template, **mutates in place** to set its `StageName` to `'__unused_stage__'`, then injects a `CloudWatchLogsGroup` (`AWS::Logs::LogGroup`, retention from `log-group-retention` default 7) and an `ApiGatewayStage` (`AWS::ApiGateway::Stage`) wired with `AccessLogSetting` (`Format` + `Fn::GetAtt CloudWatchLogsGroup.Arn`) and `stageTags`. ⚠️ Forcibly replacing the deployment's stage with a separate managed Stage will surprise anyone expecting the framework's default stage resource.
- ⚠️ **Style outlier:** this is the only package that uses the namespace import `const _ = require('lodash/fp')` (`index.js:1`) and dotted-string `get` paths; the four offline plugins destructure and use array paths. Do **not** use it as the style reference. It also declares `aws-sdk` (`package.json:23`) but never uses it (dead dependency).

---

## 9. End-to-end lifecycle diagram (ascii)

```
serverless offline start
        │
        ▼
 serverless-offline emits its lifecycle  ───────────────────────────────┐
        │                                                               │
        │  'offline:start:init'                  (legacy: 'offline:start')
        ▼                                                  ▼
   ServerlessOffline<Service>.start()         _startWithReady() ─► start(); ready()
        │
        ├─ process.env.IS_OFFLINE = true                                  index.js:39
        ├─ _mergeOptions()                                                index.js:126
        │     defaults < provider < offline(location,localEnv) < custom-<svc> < cliOptions
        ├─ _getEvents()                                                   index.js:146
        │     getAllFunctions → {functionKey, functionDefinition}  ──► lambdas[]
        │     getAllEventsInFunction → match s3/sqs/stream  ──► <svc>Events[]
        │           (sqs/kinesis/ddb run through _resolveFn → ARN)        §6
        ├─ _createLambda(lambdas)                                         index.js:107
        │     const {default: Lambda} = await import('serverless-offline/lambda')   (ESM bridge)
        │     this.lambda = new Lambda(serverless, options)
        │     this.lambda.create(lambdas)        ◄── every function registered
        └─ if (<svc>Events.length) _create<Service>(<svc>Events)
                 new <Service>(lambda[, resources], options)
                 await emulator.create(events)   ◄── _waitFor / describe resource
                 await emulator.start()           ◄── begin push/poll/stream
        │
        ▼
 'offline:start:ready' ─► ready()                                         index.js:60
        └─ if NODE_ENV !== 'test': _listenForTermination()  (SIGINT/SIGTERM → end())

   ┌──────────────────────  RUNTIME (per record/message/batch)  ──────────────────────┐
   │  S3   : Minio 'notification' ─► new S3Event(record)                               │
   │  SQS  : p-queue job long-polls receiveMessage ─► new SQSEvent(batch) ─► delete    │
   │  Kin. : KinesisReadable per shard ─► Writable.write ─► new KinesisEvent(chunk)    │
   │  DDB  : DynamodbStreamsReadable per shard ─► Writable.write ─► DynamodbStreamsEvt │
   │                                                                                   │
   │  ALL  : lambdaFunction = lambda.get(functionKey)                                  │
   │         lambdaFunction.setEvent(event); await lambdaFunction.runHandler()         │
   └───────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼  SIGINT/SIGTERM  or  'offline:start:end'
   end(skipExit)                                                          index.js:83
        ├─ if NODE_ENV==='test' && skipExit===undefined: return (no-op)
        ├─ lambda.cleanup()
        ├─ emulator.stop(5000)        ◄── SERVER_SHUTDOWN_TIMEOUT IGNORED by every emulator
        └─ if (!skipExit) process.exit(0)   ◄── hard kill (cuts off later end hooks)
```

---

## 10. Per-package quick reference

| Package | Entry class | Hooks | Driver / behavior | Client | Key gotchas |
|---|---|---|---|---|---|
| `serverless-offline-s3` | `ServerlessOfflineS3` (`index.js:19`) | `offline:start:{init,ready,end}` + `offline:start` | `S3` push via Minio `listenBucketNotification` | Minio | dead `_create`/`_s3Event` (`s3.js:84-125`); `log.warn` (wrong method); `aws-sdk` dep unused |
| `serverless-offline-sqs` | `ServerlessOfflineSQS` (`index.js:34`) | same | `SQS` poll via self-requeuing `p-queue` job | aws-sdk v2 | `this.region` undefined (`sqs.js:119`); `enabled:false` ignored; autoCreate stringifies all props incl. intrinsics; dead `_getQueueUrl`; deep `_resolveFn` drops non-SQS GetAtts |
| `serverless-offline-kinesis` | `ServerlessOfflineKinesis` (`index.js:18`) | same | `Kinesis` per-shard `kinesis-readable` → `Writable` | aws-sdk v2 + `kinesis-readable` | `this.region` undefined (`kinesis.js:87`); **infinite** handler retry, no log; `_resolveFn` reads `properties.Name`; event-def omits wrong key `tableName` |
| `serverless-offline-dynamodb-streams` | `ServerlessOfflineDynamodbStreams` (`index.js:18`) | same | `DynamodbStreams` per-shard in-repo readable → `Writable` | aws-sdk v2 (×2) + in-repo readable | `this.region` undefined (`dynamodb-streams.js:101`); no guard for table w/o stream; finite retry but no log; default `accessKeyId` not `accountId` |
| `dynamodb-streams-readable` | `DynamoDBStreamReadable` fn (`index.js:22`) | n/a (library) | Readable→Transform over DDB Streams | aws-sdk `DynamoDBStreams` (caller-supplied) | only package with real tests; tests need dynamodb-local:8000; param reassignment idiom |
| `serverless-apigateway-access-logs` | `ExtendDeploymentWithAccessLogs` (`index.js:3`) | `before:aws:package:finalize:mergeCustomProviderResources` | deploy-time CFN template mutation | none (CFN only) | namespace `_` import outlier; mutates template in place; sets `StageName='__unused_stage__'`; `aws-sdk` dep unused |
| `serverless-offline-ssm-provider` | — | — | stub only (`README.md`) | — | **no `package.json`** — not buildable/publishable |

---

## 11. Conventions cheat-sheet (apply to new code)

- **CommonJS** `require`/`module.exports = ClassName`; one class per file; ESM only via dynamic `import()` inside `async` methods.
- **`lodash/fp` only** (never `lodash`); destructured named imports, alphabetized; define curried helpers once (`const omitUndefined = omitBy(isUndefined)`); point-free `pipe` for read pipelines; `get` with **array** key-paths.
- **FP-with-classes is intentional** (`fp/no-class` off): classes hold mutable state + side effects, lodash/fp does pure transforms. Follow the **declare-null-then-assign** constructor idiom.
- **Private methods** `_camelCase`; public surface = lifecycle/driver API (`create`/`start`/`stop`/`ready`/`end`).
- **Naming:** classes PascalCase, constants `UPPER_SNAKE_CASE`, AWS SDK keys destructured with `Original: alias`, `functionKey` for the SF function id, `raw<Service>EventDefinition` for un-normalized config. Filenames kebab-case matching the class.
- **Error handling:** `try/catch (err)` + `log.warning(err.stack)` to keep worker loops alive (use **`log.warning`**, the canonical method — `log.warn` is likely a no-op); recursive retry-with-`delay` instead of loops; `throw new Error(descriptive)` for config/programmer errors.
- **Prettier** (via `plugin:@coorpacademy/coorpacademy/prettier`, no local config): single quotes, no bracket spacing, no trailing commas, arrow parens omitted for single params, ~100 col, 2-space indent, semicolons.
- **Mutation is allowed** (`no-param-reassign` off) and inconsistent — don't expect the linter to block it.

> See `docs/open-pr-triage.md` and `docs/serverless-v4-migration-review.md` for the live-bug backlog and the Serverless v4 migration plan that build on this architecture.
