# Coding Conventions & Style Guide

This is the house style for the `serverless-plugins` monorepo (a Lerna + npm-workspaces collection of Serverless Framework plugins). Follow it when editing existing code or adding a new plugin. Every rule below is grounded in the actual source — line references point at the canonical example.

> TL;DR: **CommonJS, one class per file, `lodash/fp` for pure transforms, classes for stateful side effects, mutation is allowed, prettier-via-eslint formatting, Node ≥16 CJS syntax (dynamic `import()` only for ESM-only deps).**

---

## 1. Module system & file layout

| Rule | Detail | Reference |
|---|---|---|
| **CommonJS only** | `require(...)` / `module.exports = X`. There is **no transpile step** — `package.json` `main` is `"src"` and the `files` allowlist ships raw `src/*.js`. | `packages/serverless-offline-sqs/package.json` |
| **ESM only via dynamic `import()`** | The only sanctioned ESM is `await import(...)` inside an `async` method, used to load ESM-only `serverless-offline`. | `serverless-offline-sqs/src/index.js` `_createLambda` |
| **One class per file** | Each module ends with a single `module.exports = ClassName;`. **No named/object exports.** | `serverless-offline-sqs/src/sqs.js:178`, `sqs-event.js` |
| **Filenames kebab-case** | File name matches the class: `sqs-event-definition.js` → `SQSEventDefinition`. | — |

### The plugin "quartet" — mirror this when adding a service

Every `serverless-offline-*` plugin is exactly four files. Replicate the shape:

| File | Responsibility |
|---|---|
| `index.js` | The Serverless plugin class: `hooks`, `_mergeOptions`, `_getEvents`, `_createLambda`. |
| `<svc>.js` | The worker/driver class: AWS client, polling/listening loop, lifecycle (`create`/`start`/`stop`). |
| `<svc>-event.js` | Maps AWS records → the Lambda event shape. Thin: constructor builds `this.Records` and stops. |
| `<svc>-event-definition.js` | Normalizes the user's raw event config (string ARN / `{arn}` / `{name}`) into a canonical object. |

### Import ordering

Node builtins → third-party npm → `@serverless/utils/log` → local `./` requires. `log` and the local requires are usually separated by blank lines. Canonical:

```js
const SQSClient = require('aws-sdk/clients/sqs');           // third-party

const {chunk, find, get /* ... */} = require('lodash/fp');  // third-party
const log = require('@serverless/utils/log').log;           // the log singleton
const {default: PQueue} = require('p-queue');
const SQSEventDefinition = require('./sqs-event-definition'); // local
const SQSEvent = require('./sqs-event');
```
(`serverless-offline-sqs/src/sqs.js:1-17`)

---

## 2. lodash/fp usage

**Always import from `lodash/fp`, never `lodash`.** The `lodash-fp` eslint preset enforces fp semantics (iteratee-first, data-last, curried, immutable).

### Do — destructured named imports, alphabetized

Prettier sorts the destructured object, so keep it alphabetical. Multi-line form:

```js
const {
  chunk, find, get, isPlainObject, mapValues, matches, pipe, toString, values
} = require('lodash/fp');
```
(`serverless-offline-sqs/src/sqs.js:3-13`)

Single-import form: `const {isNil, omit} = require('lodash/fp');` (`sqs-event-definition.js:1`).

### Do — point-free `pipe` for read pipelines

```js
return pipe(values, find(matches({Properties: {QueueName: queueName}})), get('Properties'))(this.resources);
```
(`serverless-offline-sqs/src/sqs.js:151-155`)

### Do — curried helpers as a standalone const, defined once at module top

```js
const omitUndefined = omitBy(isUndefined);
```
(`serverless-offline-sqs/src/index.js:32`, also kinesis/s3/dynamodb index)

### Do — `get` with array key-paths in driver code

```js
get(['service', 'resources', 'Resources'], this.serverless)
```
(`serverless-offline-sqs/src/index.js`)

### Don't — namespace import `const _ = require('lodash/fp')`

Only `serverless-apigateway-access-logs/src/index.js:1` does this (with dotted-string paths like `_.get('service.custom.serverless-apigateway-access-logs', serverless)`). It is the **outlier**, not the reference. New code destructures and uses array key-paths.

---

## 3. The FP-with-classes mix (intentional)

`fp/no-class` is **off** (`.eslintrc.js:20`). The pattern is deliberate:

> **Classes carry mutable state + side effects** (AWS clients, queues, listeners, the Serverless lifecycle). **`lodash/fp` handles the pure transforms inside methods.**

### The "declare-null-then-assign" constructor idiom — REQUIRED house style

Every field is set to `null` first, then assigned its real value. This documents the instance shape up front. **Do not "clean up" the redundant null-init — it is load-bearing convention, not dead code.**

```js
class SQS {
  constructor(lambda, resources, options) {
    this.lambda = null;
    this.resources = null;
    this.options = null;

    this.lambda = lambda;
    this.resources = resources;
    this.options = options;

    this.client = new SQSClient(this.options);
    this.queue = new PQueue({autoStart: false});
  }
}
```
(`serverless-offline-sqs/src/sqs.js:25-37`; plugin constructor at `index.js:35-43`)

### Public vs private API

| Visibility | Naming | Examples |
|---|---|---|
| **Public** = lifecycle/driver API | plain `camelCase` | `create`, `start`, `stop`, `ready`, `end` |
| **Private** | leading underscore `_camelCase` | `_create`, `_sqsEvent`, `_mergeOptions`, `_resolveFn`, `_getResources` |

Event-shape classes are thin — the constructor builds `this.Records` and that's it (`sqs-event.js`, `kinesis-event.js`, `s3-event.js`).

---

## 4. Immutability — guideline, not guarantee

Prefer immutable construction for transforms. But **mutation is sanctioned** and pervasive — `no-param-reassign` is off (`.eslintrc.js:25`). The linter will **not** stop you mutating; don't expect it to.

### Sanctioned mutation patterns

| Pattern | Example |
|---|---|
| `this`-mutation in state classes | throughout the driver classes |
| `Object.assign(this, omit([...], raw))` for passthrough config | `sqs-event-definition.js:38` |
| Param reassignment | `dynamodb-streams-readable/src/index.js:23-28` reassigns `options`/`arn` |
| Array push accumulation | `lambdas.push(...)`, `this.readables.push(...)`, `this.listeners.push(...)` |
| Direct CloudFormation template mutation | apigateway plugin mutates `template.Resources` in a `forEach` (`serverless-apigateway-access-logs/src/index.js:32-62`) |

### Immutable patterns also used

`Object.assign({}, ...sources)` to merge into a fresh object (`serverless-offline-sqs/src/index.js`), spread accumulation `[...messages, ...Messages]` (`sqs.js`), and lodash/fp `assign(obj, {...})` (pure, returns a new object) in drivers.

> **No hard rule:** `s3.js` uses both `this.listeners = [...this.listeners, listener]` (immutable, :74) and `this.listeners.push(listener)` (mutating, :124) in the same file. Pick immutable for new transform code; mutating `this` and accumulators is accepted.

---

## 5. Error handling

### Pattern A — swallow per-iteration failures so the worker loop keeps running

```js
try {
  // ... run handler, delete messages ...
} catch (err) {
  log.warning(err.stack);
}
```
(`serverless-offline-sqs/src/sqs.js:140-142`, `:170-174`)

- Error binding is **always** `err` (`catch (err)`).
- Diagnostics go through the serverless `log` (`log.debug('options:', this.options)` in every `_mergeOptions`), never `console.*` directly — even though `no-console` is off.

> **CANONICAL METHOD: `log.warning`, not `log.warn`.** `@serverless/utils/log` exposes `warning`. `s3.js` uses `log.warn` (`s3.js:69,117`) which is likely a silent no-op — a known bug, do not copy it. **kinesis.js and dynamodb-streams.js do not import `log` at all and silently swallow handler errors** — when touching those files, add the import and use `log.error`/`log.warning`.

### Pattern B — recursive retry-with-delay (not loops)

Define a module-level `delay` (identical in sqs/kinesis/s3/dynamodb), then `await delay(N); return this._method(...)` on failure:

```js
const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });
```
(`serverless-offline-sqs/src/sqs.js:19-22`)

Bounded retry uses a `remainingTry` / `remainingAttempts` counter decremented per recursion:

```js
async _createQueue({queueName}, remainingTry = 5) {
  try { /* ... */ }
  catch (err) {
    if (remainingTry > 0 && err.name === 'AWS.SimpleQueueService.NonExistentQueue')
      return this._createQueue({queueName}, remainingTry - 1);
    log.warning(err.stack);
  }
}
```
(`serverless-offline-sqs/src/sqs.js:158-175`)

> Retry semantics are inconsistent across packages — kinesis retries **infinitely** with no cap (`kinesis.js:91-94`), dynamodb retries a finite `maximumRetryAttempts-1` (`dynamodb-streams.js:106-109`), sqs does **not** retry the handler. Prefer **bounded** retry for new code.

### Pattern C — fail-fast `throw new Error(...)` for config / programmer errors

Use a descriptive message; reserve this for config/programmer errors, **not** runtime IO (which uses Pattern A/B).

```js
if (!this.configuration)
  throw new Error('Plugin serverless-apigateway-access-logs must be configured');
```
(`serverless-apigateway-access-logs/src/index.js:9-18`; also `_resolveFn` throws `No resource defined with name ${resourceName}`, kinesis `index.js`.)

---

## 6. Naming conventions

| Kind | Convention | Examples |
|---|---|---|
| Classes | PascalCase. Plugin classes descriptive; driver/event classes short | `ServerlessOfflineSQS`, `ExtendDeploymentWithAccessLogs`; `SQS`, `SQSEvent`, `SQSEventDefinition` |
| Functions / vars / methods | camelCase | `getMessages`, `_mergeOptions` |
| Private methods | `_camelCase` | `_resolveFn`, `_getResources` |
| Module-level config constants | UPPER_SNAKE_CASE | `OFFLINE_OPTION`, `CUSTOM_OPTION`, `SERVER_SHUTDOWN_TIMEOUT` (`serverless-offline-sqs/src/index.js:19-22`) |
| Serverless function identifier | `functionKey` | everywhere |
| Un-normalized user config arg | `raw<Service>EventDefinition` | `rawSqsEventDefinition` (`sqs-event-definition.js:9`) |

**AWS SDK field destructuring is renamed to camelCase via `Original: alias`:**

```js
({MessageId: messageId, ReceiptHandle: receiptHandle /* ... */})  // sqs-event.js
const {ShardId: shardId} = ...                                    // kinesis.js
```

AWS-PascalCase keys are kept when passing **back** to the SDK (`{QueueName: queueName}`, `{Entries, QueueUrl}`).

---

## 7. Prettier (enforced through eslint)

There is **no local `.prettierrc`**. Formatting comes entirely from `plugin:@coorpacademy/coorpacademy/prettier` (`.eslintrc.js:10`). Settings inferred from the preset + actual files:

| Setting | Value | Example |
|---|---|---|
| Quotes | single | `'lodash/fp'` |
| Bracket spacing | **none** | `{enabled, arn, queueName}` not `{ enabled }` |
| Trailing commas | **none** | multi-line objects/imports end without comma |
| Arrow parens | omitted for single param | `timeout =>`, `event =>`, `signal =>` |
| Print width | ~100 cols | long calls wrap one-arg-per-line |
| Indentation | 2 spaces | — |
| Semicolons | required | — |

---

## 8. ESLint rules that actually matter (`.eslintrc.js`)

| Rule | Setting | What it means for you |
|---|---|---|
| `fp/no-class` | **off** (`:20`) | Classes are first-class. Use them for stateful side effects. |
| `no-param-reassign` | **off** (`:25`) | Param mutation is allowed. |
| `no-console` | **off** (`:24`) | Still route diagnostics through `log`, not `console`. |
| `no-shadow` | `['error', {allow: ['toString']}]` (`:26`) | Shadowing is an **error** except `toString` (lodash/fp's `toString` shadows the global). If you import another fp helper colliding with a global, **add it to the allow list** rather than renaming — follow precedent. |
| `node/no-unsupported-features/es-syntax` | `['error', {version: '>=16.0.0', ignores: ['dynamicImport']}]` (`:33-36`) | Code must be **Node ≥16 CJS-compatible syntax**, but **dynamic `import()` is allowed**. (`engines.node` is `>=18` in package.json, so the lint floor is conservative.) |
| `node/no-extraneous-require` | `['error', {allowModules: ['ava', 'aws-sdk', '@serverless/utils']}]` (`:27-30`) | **Only** these three may be required without being declared deps. Anything else must be in `package.json`. |
| `import/no-extraneous-dependencies` | off (`:22`), re-disabled for tests (`:42-48`) | — |
| `import/no-unresolved`, `node/no-missing-require` | off (`:23,31-32`) | Unresolved imports won't fail lint (workspace/ESM mix). |
| `unicorn/consistent-function-scoping`, `unicorn/no-await-expression-member`, `unicorn/no-unreadable-array-destructuring` | off (`:38-40`) | Enables nested arrows, `(await x).foo`, and ARN destructuring `const [, , , , , queueName] = arn.split(':')` (`sqs-event-definition.js:4`). |
| `ava.config.js` override | `es-syntax` off (`:49-54`) | The config file may use ESM. |

> **Gotcha:** The `@coorpacademy/eslint-plugin-coorpacademy` package is not always installed in `node_modules`, so `yarn eslint` / `npm run eslint` fails until deps are installed. There is no readable prettier config file — formatting is entirely the preset.

---

## 9. Node syntax constraints

- Lint floor is **Node ≥16 CJS-compatible** syntax (`.eslintrc.js:35`); `engines.node` is `>=18`.
- **Static `import` / `require` of an ESM-only module will break under CJS.** ESM-only deps (`serverless-offline`) must be loaded via **dynamic `import()` inside an `async` method** — this is the sole reason `es-syntax` allows `dynamicImport`:

```js
async _createLambda(lambdas) {
  const {default: Lambda} = await import('serverless-offline/lambda');
  this.lambda = new Lambda(this.serverless, this.options);
  this.lambda.create(lambdas);
}
```
(`serverless-offline-sqs/src/index.js`)

- Everything else stays CJS / Node ≥16-compatible.

---

## 10. Event-definition normalizer idiom

The `<svc>-event-definition.js` classes branch on the runtime type of the raw config with an unusual but intentional `switch ('string')` trick:

```js
switch ('string') {
  case typeof rawSqsEventDefinition:       /* it's a string ARN */       break;
  case typeof rawSqsEventDefinition.arn:   /* {arn: '...'} */            break;
  case typeof rawSqsEventDefinition.queueName: /* {queueName: '...'} */  break;
  // No default
}
```
(`sqs-event-definition.js:13-30`)

> **Known latent bug — do not propagate:** `let enabled;` is declared but **never assigned** from the raw def, so `this.enabled = isNil(enabled) ? true : enabled` always resolves to `true`, and `Object.assign(this, omit([...,'enabled'], raw))` explicitly strips `enabled`. A config `enabled: false` is silently ignored. When editing these files, **read `enabled` from the raw definition.** Also note `kinesis-event-definition.js:42` omits `'tableName'` (a dynamodb field) instead of `'streamName'` — a copy-paste bug. Keep `Name`/`StreamName`/`TableName`/`QueueName` straight when copy-adapting between plugins.

---

## 11. Testing conventions (ava)

- Runner is **ava** (`ava.config.js`): glob `packages/**/test/*.js`, `failFast: true`, `timeout: '30s'`, coverage via `nyc`.
- Tests live in `test/` (sibling to `src/`), one `index.js` per package. **A test placed anywhere other than a `test/` directory (e.g. `__tests__/` or `*.test.js`) is silently NOT picked up by the glob.**
- Pattern: `const test = require('ava');`, shared state in `test.before` / `test.beforeEach` via `t.context.*`, `test.serial(...)` for stream/IO tests, `async t => {...}` bodies.
- Tests hit **real local docker endpoints** (`endpoint: 'http://localhost:8000'`); `docker-compose up -d` is a `pretest:unit` step. The only matching unit test (`dynamodb-streams-readable/test/index.js`) is effectively an integration test against dynamodb-local.
- `import/no-extraneous-dependencies` is off in tests; `ava` / `aws-sdk` are require-allowlisted.

---

## Checklist before commit

Run through this before every commit. Most items are silent footguns the linter won't catch.

- [ ] **`npm run eslint` passes** (`eslint .`). This is the only fully standalone gate — no docker, no AWS. Requires deps installed (`@coorpacademy/eslint-plugin-coorpacademy`).
- [ ] **Logging method is `log.warning` / `log.debug` / `log.error`, NOT `log.warn`.** `log.warn` is a silent no-op against `@serverless/utils/log`.
- [ ] **No dead / unused `@serverless/utils/log` import.** If you import `log`, you must call it. Conversely, if a file logs but does **not** import `log` (current state of kinesis.js / dynamodb-streams.js), add the import — don't leave handler errors silently swallowed.
- [ ] **No `console.*`** — diagnostics route through `log` even though `no-console` is off.
- [ ] **CommonJS only.** No static `import`/`export`. ESM-only deps loaded via `await import()` inside an `async` method only.
- [ ] **Syntax is Node ≥16 CJS-compatible** (lint floor), even though `engines.node` is `>=18`.
- [ ] **lodash imported from `lodash/fp`**, destructured + alphabetized. No `const _ = require('lodash/fp')` namespace import for new code.
- [ ] **One class per file, `module.exports = ClassName`** at the bottom. No named/object exports.
- [ ] **New constructor fields follow declare-null-then-assign.** Do not "optimize away" the null pre-init.
- [ ] **Private methods prefixed `_`**; public surface limited to lifecycle/driver API.
- [ ] **Any new require that is NOT `ava`/`aws-sdk`/`@serverless/utils` is declared in that package's `package.json`** (`node/no-extraneous-require`). Conversely, drop genuinely unused deps (e.g. `aws-sdk` in s3 / apigateway, which use minio / lodash respectively).
- [ ] **New fp helper colliding with a global?** Add it to `no-shadow` `allow`, don't rename.
- [ ] **`region` comes from `this.options.region`, not `this.region`** (the latter is never assigned and is `undefined`).
- [ ] **Event-definition `enabled` is read from the raw def**, and the `omit([...])` list names the correct service field (`streamName`/`tableName`/`queueName`).
- [ ] **Prettier-clean:** single quotes, no bracket spacing, no trailing commas, arrow parens omitted for single params, 2-space indent, ~100 col width. (Auto-enforced by eslint.)
- [ ] **Filename is kebab-case** matching the class name.
- [ ] **New tests live in a `test/` directory** (sibling to `src/`) or the ava glob skips them.
- [ ] **Adding a new plugin?** Ship the full quartet: `index.js`, `<svc>.js`, `<svc>-event.js`, `<svc>-event-definition.js`.
