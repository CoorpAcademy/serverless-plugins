# TODO — `serverless-offline-dynamodb-streams` (v4 migration + #166 + #98 + cleanup)

> **Agent:** `serverless-plugin-author` · **Skill:** `serverless-plugin-dev` · **Goal:** `[[00-goal]]`
> **Refs:** `[[architecture]]`, `[[conventions]]`, `[[testing-and-ci]]` · **Scope:** ONLY `packages/serverless-offline-dynamodb-streams/`.

## Changes

### `src/index.js` — v4 migration (same pattern as `[[01-package-s3]]`)
1. Drop `@serverless/utils/log` require; add `const {normalizeLog} = require('./log');`.
2. Constructor 3rd arg `{log} = {}` → `this.log = normalizeLog(log)`; drop redundant `this.x = null;`.
3. All `this.serverless.cli.log(...)` → `this.log.notice(...)`.
4. `log.debug(...)` → `this.log.debug('dynamodb-streams options:', this.options)`.
5. `_createDynamodbStreams`: `new DynamodbStreams(this.lambda, this.options, this.log)` (thread logger; ctor is `(lambda, options)`).

### `src/dynamodb-streams.js` (currently imports NO logger and swallows errors silently)
6. Add the logger: constructor → `(lambda, options, log)`, `this.log = require('./log').normalizeLog(log)`.
7. **#166 (zlalvani):** event built with `this.region` → use `this.options.region` (undefined today).
8. **#98 (dolsem):** when resolving the table's `LatestStreamArn`, if it's missing/undefined throw a clear
   error **before** trying to read the stream: `Table <tableName> does not have streams enabled`.
   (Today it proceeds and fails cryptically.)
9. The error-swallowing `catch` in the retry path: add `this.log.warning(...)` so failures are visible
   (the package currently logs nothing). Keep the existing bounded retry (`maximumRetryAttempts`) behavior.

### `src/dynamodb-streams-event.js`
10. The exported event class is literally named `KinesisEvent` (copy-paste). Rename to `DynamodbStreamsEvent`
    for clarity (internal-only; keep the export shape identical).

### `src/log.js` (NEW) — canonical shim from `[[00-goal]]`.

### `package.json`
11. Add `"src/log.js"` to `files`. Bump `version` 7.0.0 → **7.1.0**. Keep peer `"^10.0.2 || >=11"`.

### `README.md`
12. Add the "## Serverless Framework v4" note.

## Tests (NEW — `test/index.js`, AVA, docker-free)
- `normalizeLog`.
- `DynamodbStreamsEvent` mapper — maps records → `aws:dynamodb` Lambda event shape with **correct `awsRegion`** (#166 guard).
- A pure "no-streams" guard helper if extracted: throws the clear error when `LatestStreamArn` is falsy (#98 guard).

## Gating
- `npm run eslint` green. `npx ava` green. `grep -rn '@serverless/utils/log\|serverless.cli.log' packages/serverless-offline-dynamodb-streams` → empty.

## Acceptance
- v4-clean; `awsRegion` correct; clear no-streams error; failures logged; event class renamed; tests pass; 7.1.0.

## Credits — zlalvani (#166), dolsem (#98).
</content>
