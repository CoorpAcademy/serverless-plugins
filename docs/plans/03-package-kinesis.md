# TODO — `serverless-offline-kinesis` (v4 migration + #166 + #100 + #249 + event-def fix)

> **Agent:** `serverless-plugin-author` · **Skill:** `serverless-plugin-dev` · **Goal:** `[[00-goal]]`
> **Refs:** `[[architecture]]`, `[[conventions]]`, `[[testing-and-ci]]` · **Scope:** ONLY `packages/serverless-offline-kinesis/`.

## Changes

### `src/index.js` — v4 migration (same pattern as `[[01-package-s3]]`)
1. Drop `@serverless/utils/log` require; add `const {normalizeLog} = require('./log');`.
2. Constructor 3rd arg `{log} = {}` → `this.log = normalizeLog(log)`; drop redundant `this.x = null;`.
3. All `this.serverless.cli.log(...)` → `this.log.notice(...)`.
4. `log.debug(...)` → `this.log.debug('kinesis options:', this.options)`.
5. `_createKinesis`: `new Kinesis(this.lambda, this.options, this.log)` (thread the logger — note Kinesis ctor is `(lambda, options)`).
6. **#249 (gabsong):** `_createLambda` currently does `this.lambda.create(lambdas)` without awaiting →
   `await this.lambda.create(lambdas);` (defensive; harmless if sync).

### `src/kinesis.js` (currently imports NO logger and swallows errors silently)
7. Add the logger: constructor → `(lambda, options, log)`, `this.log = require('./log').normalizeLog(log)`.
8. **#166 (zlalvani):** event built with `this.region` → use `this.options.region` (this.region is undefined).
9. **#100 (dolsem) + silent-swallow fix:** the handler retry loop currently recurses **forever** with **no
   logging** on failure. Mirror DynamoDB's bounded retry: read `maximumRetryAttempts` from the kinesis event
   definition (default consistent with `dynamodb-streams-event-definition.js`), cap the retries, and
   `this.log.warning(...)` each failed attempt. Preserve current success behavior.

### `src/kinesis-event-definition.js`
10. The `Object.assign`/omit currently omits `tableName` (copy-paste from dynamodb) — Kinesis has no
    `tableName`. Change the omit list to `streamName` so extra props merge correctly.

### `src/log.js` (NEW) — canonical shim from `[[00-goal]]`.

### `package.json`
11. Add `"src/log.js"` to `files`. Bump `version` 7.0.0 → **7.1.0**. Keep peer `"^10.0.2 || >=11"`.

### `README.md`
12. Add the "## Serverless Framework v4" note. Document `maximumRetryAttempts` if you expose it.

## Tests (NEW — `test/index.js`, AVA, docker-free)
- `normalizeLog`.
- `KinesisEvent` mapper — maps records → `aws:kinesis` Lambda event shape with **correct `awsRegion`** (#166 guard).
- `kinesis-event-definition` — extra props (incl. `streamName` handling) merge as intended (regression guard for the omit fix).
- Retry-cap helper if you extract one (pure attempt-counter logic): stops after N attempts.

## Gating
- `npm run eslint` green. `npx ava` green. `grep -rn '@serverless/utils/log\|serverless.cli.log' packages/serverless-offline-kinesis` → empty.

## Acceptance
- v4-clean; `awsRegion` correct; retries bounded **and logged**; event-def omit fixed; `lambda.create` awaited; tests pass; 7.1.0.

## Credits — zlalvani (#166), dolsem (#100), gabsong (#249).
</content>
