---
name: serverless-plugin-dev
description: >-
  Use when modifying, fixing, testing, adding features to, or publishing any package in the
  CoorpAcademy/serverless-plugins monorepo — serverless-offline-s3, serverless-offline-sqs,
  serverless-offline-kinesis, serverless-offline-dynamodb-streams, dynamodb-streams-readable,
  serverless-apigateway-access-logs. Encodes the shared plugin lifecycle, the Serverless v4
  logger contract, the lodash/fp + FP-with-classes conventions, the gating commands
  (eslint/prettier + ava + docker integration), and the lerna publish flow. Load this BEFORE
  editing plugin source so changes match the house pattern and pass CI.
---

# serverless-plugins — developer skill

CoorpAcademy's own collection of Serverless Framework plugins. Lerna **independent**-versioned
monorepo, npm workspaces, AVA + Docker integration tests, Travis CI, ESLint (with Prettier baked
in via `@coorpacademy/coorpacademy/prettier`). We **own** this repo.

## Read these first (deep references)

- `docs/architecture.md` — the shared 4-plugin lifecycle, hooks, Lambda runner, event extraction.
- `docs/conventions.md` — lodash/fp, FP-with-classes, immutability, error handling, naming.
- `docs/testing-and-ci.md` — AVA gap, the Docker harness, "what can I run / what it needs".
- `docs/publishing-and-versioning.md` — lerna, peer coupling, v4 strategy, publish playbook.
- `docs/serverless-v4-migration-review.md` + `docs/open-pr-triage.md` — the v4 work + PR triage.

## The shared plugin shape (the 4 `serverless-offline-*` plugins)

Each is a class in `packages/<pkg>/src/index.js` with a tiny emulator sub-module
(`s3.js` / `sqs.js` / `kinesis.js` / `dynamodb-streams.js`) and `*-event.js` / `*-event-definition.js`.

```
constructor(serverless, cliOptions, {log} = {})   // v4 injects {log,writeText,progress} as 3rd arg
  hooks: offline:start:init → start()
         offline:start:ready → ready()
         offline:start → _startWithReady()
         offline:start:end → end()

start() → _mergeOptions() → _getEvents() → _createLambda() → _create<Service>() 
ready() → _listenForTermination()  (SIGINT/SIGTERM → end())
end()   → cleanup lambda + emulator → process.exit(0) unless skipExit
```

- **Lambda runner** is loaded lazily: `const {default: Lambda} = await import('serverless-offline/lambda')`
  (serverless-offline is ESM-only). Keep the dynamic import — do not convert to `require('.../src/lambda')`.
- **Option precedence** in `_mergeOptions` (lowest→highest): `defaultOptions`, `provider`,
  `serverless-offline` opts (`location`,`localEnvironment`), the plugin's `custom` opts, `cliOptions`.
- **Event extraction** `_getEvents()` walks `service.getAllFunctions()`; `_resolveFn` resolves
  CloudFormation `Fn::GetAtt` ARNs to concrete queue/stream/table names.

## ⚠️ Serverless v4 logger contract (the #1 rule)

v4 **removed** `@serverless/utils/log` and `serverless.cli.log`. **Never** `require('@serverless/utils/log')`.
Take the logger from the **3rd constructor arg** (works on v3.0+ AND v4) and console-fallback:

```js
// src/log.js (per package — published, so it must live inside the package)
const noop = () => {};
const defaultLog = {
  debug: noop,                              // quiet by default; serverless controls verbosity
  info:  console.log.bind(console),
  notice: console.log.bind(console),
  warning: console.warn.bind(console),
  error: console.error.bind(console),
  success: console.log.bind(console)
};
const normalizeLog = log => ({...defaultLog, ...log}); // spread of null/undefined is a no-op
module.exports = {defaultLog, normalizeLog};
```

- Constructor: `this.log = normalizeLog(log)` then **thread `this.log` into sub-modules**
  (`new S3(this.lambda, resources, this.options, this.log)`).
- Use `this.log.notice(...)` (was `serverless.cli.log`), `this.log.debug(...)`, `this.log.warning(...)`.
- The v4 logger uses **`warning`**, not `warn`. (Old code's `log.warn` was a latent bug.)

## Known live bugs / gotchas (verified against master)

- **`this.region` is undefined** in `sqs.js`, `kinesis.js`, `dynamodb-streams.js` (constructors only
  set `this.options`). Use `this.options.region`. Emitted events' `awsRegion` is wrong until fixed.
- `kinesis.js` / `dynamodb-streams.js` **swallow handler errors silently** (no logger). Thread `this.log`.
- `s3.js` has **dead methods** `_create`/`_s3Event` (the latter calls `listener.stop()` immediately). Safe to delete.
- `kinesis-event-definition.js` omits `tableName` (copy-paste) — should omit `streamName`.
- SQS delete-batch uses `MessageId` as the batch entry `Id` — not guaranteed unique/≤80 chars; use the array index.
- `_createQueue` blindly `JSON.stringify`s all queue properties incl. CFN intrinsics (`Fn::GetAtt`, `Ref`).
- Kinesis retries failed handlers **forever** with no cap (dynamodb has a bounded retry — mirror it).

## Conventions (house style)

- **CommonJS** (`require`/`module.exports`), Node ≥16 syntax (dynamic import allowed).
- **lodash/fp** everywhere (`get`, `pipe`, `omitBy`, `assign`, …). Prefer point-free, data-last.
- Classes are allowed (`fp/no-class` off) but keep logic in **small pure functions** with side effects
  (AWS clients, process.exit, listeners) at the edges — this also makes them unit-testable without Docker.
- `no-param-reassign` is **off** but avoid mutating inputs; prefer building new objects.
- `no-console` is off (the console fallback relies on it).

## Gating — run before every commit/PR

| Gate | Command | Needs |
|---|---|---|
| Lint **and** format (Prettier) | `npm run eslint` | nothing — always run this |
| Unit tests | `npx ava` (or `npm run test:unit`) | `nyc ava`'s pretest spins Docker; `npx ava` alone runs JS-only tests |
| Integration | `npm run test:integration` | Docker (minio/elasticmq/kinesalite/dynamodb-local) |
| v4 end-to-end | `sls package` / `sls offline` in a consumer | Docker + `serverless@4` + `SERVERLESS_ACCESS_KEY` |

**Always** make `npm run eslint` green. **Add docker-free AVA unit tests** for any pure logic you
touch (the offline plugins currently have none) — put them in `packages/<pkg>/test/*.js` (the AVA glob).

## Versioning & publishing (lerna independent)

- Preserve **v3 compatibility**: keep peer ranges wide (`serverless-offline: ">=11"`); the v4 fix is
  backward compatible, so prefer **minor** bumps over majors unless you truly drop old support.
- If you add a new file to a package (e.g. `src/log.js`), add it to that package's `package.json` `files` array.
- Publish: `npm run publish` (`lerna publish`). **Canary first**, smoke-test one consumer, then stable.
- v4 `deploy` needs `SERVERLESS_ACCESS_KEY`; `package`/`offline` do not.

## How to add a fix or feature (playbook)

1. Read the relevant `docs/*` + the package's `src/`.
2. Make the change in the house style; extract pure helpers for anything testable.
3. Add/extend `packages/<pkg>/test/*.js` AVA unit tests for the pure logic.
4. `npm run eslint` → green. Run AVA. Run integration if Docker available.
5. Bump the package version (minor for back-compatible) and update its README + `files` if needed.
6. PR with a clear description; credit any original community-PR author whose idea you re-implemented.
</content>
