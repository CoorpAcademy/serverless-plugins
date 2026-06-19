# Testing & CI Guide

How tests and continuous integration work in the `serverless-plugins` monorepo: what each gate is, what it actually covers, what infrastructure it needs to run, and where the coverage holes are.

> TL;DR
> - **ESLint** is the only fully self-contained gate (no Docker, no AWS, no network).
> - The "**unit**" suite (AVA) is a single file that talks to a live `dynamodb-local` container — it is *not* Docker-free, and it is the *only* AVA test in the whole repo.
> - The four `serverless-offline-*` plugins have **zero unit tests**. Their behavior is exercised only by the Docker-based **integration harness**.
> - The integration harness has **no assertion framework**: pass/fail is the spawned `sls` exit code plus a hard-coded expected invocation count, detected by regex-matching `serverless-offline`'s stderr.
> - Travis runs the **full chain** (`eslint` -> unit -> integration) on Node 18 and 20.

---

## 1. The three test gates at a glance

The canonical entrypoint is `npm test` (`package.json:20`):

```jsonc
"test": "npm run eslint && npm run test:unit && npm run test:integration"
```

| Gate | Script | What it runs | Needs Docker? | Needs AWS / network? |
|---|---|---|---|---|
| Lint | `npm run eslint` (`package.json:12`) | `eslint .` | No | No |
| Unit | `npm run test:unit` (`package.json:17`) | `pretest:unit` = `docker-compose up -d`, then `nyc ava`, then `posttest:unit` = `docker-compose stop` | **Yes** | Local docker endpoints only |
| Integration | `npm run test:integration` (`package.json:19`) | `lerna run test --stream --scope serverless-offline-plugins-integration` | **Yes** | Local docker endpoints only |

There is no separate "e2e" script in the repo today; "v4 e2e" in the runnability matrix (section 8) means *running the integration harness against Serverless Framework v4*, which adds a licensing requirement on top of Docker.

---

## 2. ESLint — the only standalone gate

- Root script: `eslint .` (`package.json:12`).
- Config: `.eslintrc.js` extends the `@coorpacademy/coorpacademy` shareable config (core + es20xx + **prettier** + lodash-fp). There is **no standalone `.prettierrc`** — formatting is enforced *through* ESLint by the preset.
- `.eslintignore` excludes `node_modules`, `coverage`, `.nyc_output`, `.webpack`, and re-includes `.serverless_plugins` and `.eslintrc.js`.
- Needs no Docker, no AWS, no network. This is the gate you can always run locally.

**Caveat:** the shared plugin `@coorpacademy/eslint-plugin-coorpacademy` (`package.json:28`) must be installed (`npm install`) before `eslint .` will run; without installed deps it fails to resolve the preset.

---

## 3. The unit suite (AVA) — and the glob that excludes almost everything

### 3.1 AVA config

`ava.config.js`:

```js
module.exports = {
  files: ['packages/**/test/*.js'],
  cache: true,
  failFast: true,
  timeout: '30s'
};
```

The glob `packages/**/test/*.js` matches **exactly one file in the entire repo**:

```
packages/dynamodb-streams-readable/test/index.js
```

(Verified: it is the only `test/` directory and the only matching `.js` under `packages/`.) Tests must live in a `test/` directory to be picked up — files named `*.test.js`, or placed under `__tests__/` or `tests/`, are **silently ignored**.

AVA options worth knowing:
- `failFast: true` — the run aborts on the first failure.
- `timeout: '30s'` — per-test inactivity timeout.
- `cache: true`.

Coverage (`.nycrc`) only sets `exclude: ["**/test/**/*"]`, so `nyc` instruments source but not test files. Because only `dynamodb-streams-readable/src` is exercised by any AVA test, reported coverage is effectively meaningless for everything else.

### 3.2 The one "unit" test is actually an integration test

`packages/dynamodb-streams-readable/test/index.js` is **not** a pure unit test. Its `test.before` constructs real `aws-sdk` `DynamoDB` / `DynamoDBStreams` clients pointed at `http://localhost:8000` (`test/index.js:23-36`), and `test.beforeEach` creates a real table with a UUID name and `StreamSpecification.StreamEnabled = true` (`test/index.js:38-71`). The suite then exercises the readable stream against `dynamodb-local`: reads pre-existing records, ongoing records, the `LATEST` iterator, checkpoint emission, `limit` obeyance, `startAfter`, and `startAt`.

Consequence: `npm run test:unit` **requires Docker** (the `pretest:unit` hook does `docker-compose up -d`) and will hang/fail without the `dynamodb-local` container. There is no truly Docker-free unit suite in this repo.

### 3.3 The unit-test GAP (this is the important part)

These packages have **NO unit tests at all**:

| Package | Unit tests? |
|---|---|
| `serverless-offline-s3` | None |
| `serverless-offline-sqs` | None |
| `serverless-offline-kinesis` | None |
| `serverless-offline-dynamodb-streams` | None |
| `serverless-apigateway-access-logs` | None (no `scripts`/`test` in its `package.json`) |
| `serverless-offline-ssm-provider` | None (no `package.json` — README stub only) |
| `dynamodb-streams-readable` | Yes (the lone AVA file, Docker-backed) |

All four `serverless-offline-*` plugins carry elaborate logic — option merging, ARN / `Fn::GetAtt` resolution, event-shape mapping, event-definition normalization — and none of it is unit-tested. The only safety net is the Docker integration harness (section 4), which is coarse-grained and brittle. See section 9 for what to add.

---

## 4. The Docker integration harness

Location: `tests/serverless-plugins-integration/` (workspace name `serverless-offline-plugins-integration`, **private**, version `4.0.0`). This is the *real* test of the offline plugins.

### 4.1 No test framework — exit codes and a counter

There is no AVA/Jest here. Each `test-*.js` is a plain Node script that passes or fails via process exit code. The shared pattern (see `test-kinesis.js`):

1. **Spawn** Serverless offline:
   ```js
   const serverless = spawn('sls', ['offline', 'start', '--config', '<yml>'],
     {stdio: ['pipe', 'pipe', 'pipe'], cwd: __dirname});   // test-kinesis.js:50-53
   ```
2. **Split stderr into lines** with `pump(serverless.stderr, getSplitLinesTransform(), Writable)`. `getSplitLinesTransform` (`utils.js:3-11`) is a `Transform` that splits each chunk on `\n` and pushes one line at a time.
3. **Trigger the producer on the startup banner.** When a line matches the plugin's banner regex, the harness fires AWS writes against the faked local service:
   - Kinesis: `/Starting Offline Kinesis/` (`test-kinesis.js:61`)
   - S3: `/Starting Offline S3/`
   - SQS: `/Starting Offline SQS/`
   - DynamoDB Streams: `/Starting Offline Dynamodb Streams/` (`test-dynamodb-streams.js:65`)
4. **Count lambda invocations** by regex-matching `serverless-offline`'s stderr log line for each handler run:
   ```
   /\(λ: (.*)\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g
   ```
   (`test-kinesis.js:67`, `test-dynamodb-streams.js:71`). **Note the `{2}` — exactly two spaces are required before `Billed Duration`.**
5. **Stop when the expected count is reached** via `serverless.kill()`.
6. `onExit((code, signal) => { if (signal) serverless.kill(signal); })` (signal-exit) ensures the spawned `sls` is killed if the harness itself is terminated.

### 4.2 Expected-count assertions per service

| Service | Script | Assertion | Why |
|---|---|---|---|
| Kinesis | `test-kinesis.js:69` | `this.count === 4` | 4 streams, one handler each |
| S3 | `test-s3.js:34,55` | `EXPECTED_LAMBDA_CALL = 9` | picture files consumed twice (by `myPromiseHandler` and `myPythonHandler`) |
| SQS | `test-sqs.js:82` | `this.count === 5` | also `serverless.on('close', code => process.exit(code))` |
| SQS autocreate | `test-sqs-autocreate.js:63` | `this.count === 3` | logs every line; on close runs `cleanUp()` to prune the 3 autocreated queues (incl. the `.fifo`) then exits |
| DynamoDB Streams | `test-dynamodb-streams.js:80` | `set.size === 3 && invocationCount === 4` | `myPromiseHandler` is mapped to two tables |

The DynamoDB harness is the trickiest. `dynamodb-local` only creates a stream once a table is **non-empty**, so it (`test-dynamodb-streams.js:40-46,69`):
1. Sets `setupInProgress = true`.
2. `unemptyTables()` writes a stub item to each table.
3. `await delay(1200)` to let the streams come up.
4. Flips `setupInProgress = false`, then `putItems()` writes the real items.
5. While `setupInProgress`, invocation lines are ignored (`if (setupInProgress) return cb();`) so the priming writes don't pollute the count.

### 4.3 Serverless configs and handlers

- Each `serverless.<svc>.yml` lists the **local package path first**, then `serverless-offline` (e.g. `serverless.s3.yml:8-11`), and points the plugin at local Docker endpoints via `${file(./custom.yml):...}`. `custom.yml:1-16` holds endpoints + local creds for sqs/s3/dynamodb-streams/kinesis.
- Handlers: `lambda/handler.js` exports `promise`/`callback` styles; `lambda/handler.py` exports a `handler` — so the harness also exercises the **python3.7** runtime path, not just Node.
- **Dependency quirk:** `serverless-offline-s3` is **not** listed as a dependency in `tests/serverless-plugins-integration/package.json` (`:30-32` list dynamodb-streams/kinesis/sqs). The S3 config loads the plugin only via the relative path `../../packages/serverless-offline-s3`. The other three are pinned as deps *and* referenced by path.

### 4.4 Test ordering and per-service setup

`tests/serverless-plugins-integration/package.json:10`:

```jsonc
"test": "npm run test:dynamodb-streams && npm run test:kinesis && npm run test:s3 && npm run test:sqs && npm run test:sqs:autocreate"
```

Each test has a `pretest:*` hook -> `setup-service <svc>` -> `../../scripts/clean-start.sh` (`package.json:11-21`).

`clean-start.sh` (the per-service reset, against `docker-compose.test.yml`):
1. `stop` + `rm -f` of `<service>` and `<service>-create` (`clean-start.sh:9-12`).
2. `up -d <service>-create` (`clean-start.sh:13`).
3. `docker wait` on the sidecar container so the script **blocks until seeding completes** (`clean-start.sh:15-16`).

Integration deps (`tests/serverless-plugins-integration/package.json:23-34`): `aws-sdk ^2`, `lodash`, `minio ^7` (the S3 client used by the harness producer), `pump`, `signal-exit`, `serverless ^3.36.0`, `serverless-offline ^13`, plus the published plugin packages.

---

## 5. Docker services & seed scripts

There are **two compose files** and they are **not interchangeable**.

### 5.1 `docker-compose.yml` — used by the unit suite

Wired into `pretest:unit` / `posttest:unit` (`package.json:16-18`). Plain services, **no seeding sidecars**:

| Service | Image | Port |
|---|---|---|
| kinesis | `instructure/kinesalite` | 4567 |
| dynamodb | `amazon/dynamodb-local` | 8000 |
| sqs | `softwaremill/elasticmq-native` (`-Dnode-address.host="*"`) | 9324 |
| s3 | `minio/minio` (`server /data`) | 9000 |

**Gotcha:** minio here has **no credential env**, while the tests authenticate with `local`/`locallocal`. The unit DynamoDB test seeds its *own* tables via the SDK, so it doesn't need the seed scripts — but anyone assuming this single file works for integration will mis-provision.

### 5.2 `docker-compose.test.yml` — used by the integration harness

Used via `clean-start.sh`. Same four services **plus `*-create` sidecar containers** (`amazon/aws-cli`) that mount and run the seed scripts against the in-network endpoint (e.g. `dynamodb-create` runs `create-tables.sh` with `AWS_ENDPOINT_URL=http://dynamodb:8000`, `docker-compose.test.yml:8-20`). Here minio **does** set `MINIO_ACCESS_KEY=local` / `MINIO_SECRET_KEY=locallocal` (`docker-compose.test.yml:63-69`).

### 5.3 Seed scripts (`scripts/create-*.sh`)

Each idempotently loop-creates until the resource exists:

| Script | Creates |
|---|---|
| `create-buckets.sh` | buckets: `documents pictures files others` |
| `create-queues.sh` | queues: `MyFirstQueue MySecondQueue MyThirdQueue MyFourthQueue MyLargestBatchSizeQueue` |
| `create-streams.sh` | kinesis streams: `MyFirst..MyFourthStream` (shard-count 1) |
| `create-tables.sh` | dynamodb tables: `MyFirst..MyFourthTable` (`StreamEnabled=true, StreamViewType=NEW_AND_OLD_IMAGES`) |

---

## 6. Travis CI

`.travis.yml`:

```yaml
dist: jammy
language: node_js
node_js:
  - "20"
  - "18"
services:
  - docker
cache: npm
env:
  - DOCKER_COMPOSE_VERSION=v2.10.2
before_install:
  - sudo rm /usr/local/bin/docker-compose
  - curl -L .../docker-compose-${TRAVIS_OS_NAME}-`uname -m` > docker-compose
  - chmod +x docker-compose && sudo mv docker-compose /usr/local/bin
```

Key points:
- **Matrix: Node 20 and Node 18.** Both run the full chain.
- `before_install` pins `docker-compose` to `v2.10.2` (removes the preinstalled binary, downloads the GitHub release).
- There is **no `script:`, `install:`, or `before_script:`**. Travis's `node_js` default kicks in: `npm install` then `npm test` — i.e. the full `eslint -> unit -> integration` chain on both Node versions.
- No publish automation in CI (no `.github/`, no `.npmrc`, no semantic-release). Publishing is a manual laptop operation (`lerna publish`). Travis runs tests only.

The README still shows a v3 Serverless badge and a travis-ci.com build badge (`README.md:3-4`).

---

## 7. nyc coverage

- `nyc ava` (the `nyc` script, `package.json:14`) wraps the AVA run.
- `.nycrc` only excludes `**/test/**/*`. Source is instrumented; tests are not.
- Because the only AVA test exercises `dynamodb-streams-readable/src`, coverage numbers are effectively **only** about that package. Coverage for the four offline plugins is ~0 and reported numbers are not meaningful.

---

## 8. Runnability matrix — "what can I run and what does it need?"

| I want to run... | Command | Docker? | AWS / network? | Serverless v4 + `SERVERLESS_ACCESS_KEY`? |
|---|---|---|---|---|
| Lint / format check | `npm run eslint` | No | No | No |
| Unit suite (AVA) | `npm run test:unit` | **Yes** (`dynamodb-local` :8000) | Local endpoints only | No |
| Integration harness | `npm run test:integration` | **Yes** (all 4 services + seed sidecars) | Local endpoints only | No (on v3 as pinned) |
| Full local CI chain | `npm test` | **Yes** | Local endpoints only | No (on v3 as pinned) |
| Integration on Serverless v4 (v4 e2e) | `npm run test:integration` after upgrading sls/offline | **Yes** | Local endpoints only | **Yes** |

### Why v4 needs `SERVERLESS_ACCESS_KEY`

The repo as committed pins `serverless ^3.36.0` everywhere (`package.json:25`, `tests/serverless-plugins-integration/package.json:28`) and contains **no** reference to `SERVERLESS_ACCESS_KEY` or v4. Under Serverless Framework v4, the `sls offline start` spawned by every `test-*.js` requires a license/access key in the environment (`SERVERLESS_ACCESS_KEY`) to even boot. Without it:
- the spawned child exits before printing `Starting Offline ...`,
- the producer never fires (step 4.1.3),
- the invocation regex never matches, and
- since these scripts have **no timeout of their own**, the harness **hangs indefinitely**.

So any v4 migration must export `SERVERLESS_ACCESS_KEY` in CI/local before integration tests can pass.

---

## 9. The fragility checklist (read before touching CI)

- **AVA glob silently excludes the offline plugins.** `packages/**/test/*.js` (`ava.config.js:2`) only picks up files in a `test/` dir. New tests under `__tests__/`, `tests/`, or named `*.test.js` will not run.
- **The "unit" suite needs Docker.** `packages/dynamodb-streams-readable/test/index.js` hits `dynamodb-local` at :8000. There is no Docker-free suite.
- **Integration has no assertions** — only exit codes + hard-coded counts. If `serverless-offline` changes its stderr format, every count silently never completes.
- **The detection regex requires exactly two spaces** before `Billed Duration` (`{2}`). A single-space or formatting change in `serverless-offline` breaks all five integration tests at once.
- **No timeout on integration scripts.** A broken banner/regex makes them hang forever in CI (unlike the AVA 30s timeout, which does *not* apply here).
- **Two compose files, two credential setups.** `docker-compose.yml` (unit) gives minio no creds; `docker-compose.test.yml` (integration) does. Don't swap them.
- **`serverless-offline-s3` is loaded by path only** in the integration workspace; it is not a declared dep there.
- **DynamoDB harness depends on a `dynamodb-local` quirk** (streams appear only after a table is non-empty). Removing the `setupInProgress` flag or shrinking `delay(1200)` corrupts the count.
- **nyc coverage is misleading** — it reflects almost solely `dynamodb-streams-readable/src`.
- **Travis runs everything on both Node 18 and 20.** Don't assume a subset runs in CI.

---

## 10. Recommendation: add Docker-free unit tests for the pure logic

The biggest gap is that the four offline plugins' **pure transforms have no fast, dependency-free tests**. These are the parts that change most often in PRs (region bugs, `enabled` flag, ARN resolution, autocreate property handling) and are exactly where regressions have slipped in. They are pure functions over plain objects and need **no Docker and no AWS**.

### Where new tests should live

Put them in a `test/` directory per package so the existing AVA glob picks them up automatically:

```
packages/serverless-offline-sqs/test/index.js
packages/serverless-offline-kinesis/test/index.js
packages/serverless-offline-dynamodb-streams/test/index.js
packages/serverless-offline-s3/test/index.js
```

Use the existing AVA conventions (`const test = require('ava');`, one `index.js` per package). No `t.context` Docker clients — construct plain objects and assert.

### What to test (high-value, fully Docker-free)

**Event-definition normalizers** (`*-event-definition.js`) — pure object normalization:
- SQS / Kinesis / DynamoDB definitions accept all three input shapes: a string ARN, `{arn}`, and `{queueName}` / `{streamName}` / `{tableName}`, and each derives the correct name and synthesizes the right ARN (`arn:aws:<svc>:${region}:${accountId}:<name>`).
- **`enabled` flag** — assert that `enabled: false` in the raw def survives (this is the live #117 regression: `let enabled;` is never assigned and `enabled` is stripped by `Object.assign(this, omit([...,'enabled'], raw))`, so it always defaults to `true`). A test here would have caught it.
- Default option merging per definition (`batchSize`, `startingPosition`, `maximumRetryAttempts`).
- Kinesis definition's `omit(['arn','tableName','enabled'])` copy-paste bug (it should omit `streamName`).

**Event-shape mappers** (`*-event.js`) — pure record -> Lambda-event mapping:
- SQS: a raw SQS message maps to a record with `eventSource: 'aws:sqs'`, lower-first message attributes, correct `eventSourceARN`/`awsRegion`.
- Kinesis: `data` base64-encoded, `eventID = '${shardId}:${SequenceNumber}'`, fixed `kinesisSchemaVersion`/`eventName`.
- **`awsRegion` undefined bug** (live #166, generalized): construct the emulator-equivalent inputs and assert `awsRegion` is the configured region, not `undefined`. The drivers pass `this.region` (never assigned) instead of `this.options.region` at `sqs.js:119`, `kinesis.js:87`, `dynamodb-streams.js:101`.

**`_mergeOptions` precedence** (`index.js`) — pure `Object.assign` over `omitBy(isUndefined)`:
- Assert the precedence chain: `defaultOptions` < `provider` < `serverless-offline` (location/localEnvironment only) < `custom['serverless-offline-<svc>']` < `cliOptions`.
- Assert `undefined` values never override a lower-precedence defined value.

**`_resolveFn` / `_getEvents`** (`index.js`) — pure CloudFormation resolution against a fake `service`:
- SQS deep walker: `Fn::GetAtt: [name, 'Arn']` on an `AWS::SQS::Queue` resolves to the synthesized ARN; **unrelated GetAtt references are dropped** (document/lock in current behavior, or fix and test).
- Kinesis/DynamoDB shallow resolver: literal `streamName`/`tableName` passes through; `Fn::GetAtt` reads `Resources[name].Properties.{Name,TableName}`; a missing resource throws `No resource defined with name <name>` (fail-fast — assert the message).

**SQS autocreate property mapping** (`sqs.js` `_createQueue` / `_getResourceProperties`) — pure-ish given an injected client stub:
- Properties are `JSON.stringify`'d for objects, `toString`'d otherwise.
- **`RedrivePolicy` / CFN-intrinsic handling** (live #183): assert intrinsics like `{Ref: ...}` aren't blindly serialized and that a DLQ referenced by `RedrivePolicy.deadLetterTargetArn` is created first. This needs a small fake SQS client (resolve/record calls), still no Docker.

These tests run in milliseconds, run in CI with zero infrastructure, and would have caught the majority of the bugs currently only discoverable (if at all) by the brittle integration harness. Keep the Docker integration suite as the end-to-end smoke test; add the unit layer underneath it.
