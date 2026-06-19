# TODO — `serverless-offline-sqs` (v4 migration + #166 + #253 + #211)

> **Agent:** `serverless-plugin-author` · **Skill:** `serverless-plugin-dev` · **Goal:** `[[00-goal]]`
> **Refs:** `[[architecture]]`, `[[conventions]]`, `[[testing-and-ci]]` · **Scope:** ONLY `packages/serverless-offline-sqs/`.

## Changes

### `src/index.js` — v4 migration (same pattern as `[[01-package-s3]]`)
1. Drop `@serverless/utils/log` require; add `const {normalizeLog} = require('./log');`.
2. Constructor 3rd arg `{log} = {}` → `this.log = normalizeLog(log)`; drop redundant `this.x = null;`.
3. All `this.serverless.cli.log(...)` → `this.log.notice(...)`.
4. `log.debug(...)` → `this.log.debug('sqs options:', this.options)`.
5. `_createSqs`: `new SQS(this.lambda, resources, this.options, this.log)`.

### `src/sqs.js`
6. Drop `@serverless/utils/log` require; add logger via constructor 4th arg `log` → `this.log = normalizeLog(log)`.
7. Replace `log.warning(err.stack)` (both call sites) → `this.log.warning(err.stack)`.
8. **#166 (zlalvani):** the live SQS-event handler builds `new SQSEvent(messages, this.region, arn)` —
   `this.region` is **undefined** (constructor only sets `this.options`). Change to `this.options.region`.
9. **#253 (flipscholtz):** `deleteMessageBatch` entries currently use `MessageId` as the batch `Id`
   (`map(({MessageId: Id, ReceiptHandle}) => ({Id, ReceiptHandle}))`). `MessageId` is not guaranteed unique
   within a batch and can exceed the 80-char `Id` limit. **Extract a pure module-level helper** and use it:
   ```js
   const toDeleteEntries = messages =>
     (messages || []).map(({ReceiptHandle}, index) => ({Id: String(index), ReceiptHandle}));
   ```
   Export it (e.g. `module.exports.toDeleteEntries = toDeleteEntries`) so it's unit-testable.
10. **#211 (mfamilia):** allow `custom.serverless-offline-sqs.queueName` to override the event's queue name.
    Do it **non-mutating** — in `_create`, derive the effective definition without reassigning the input:
    ```js
    const def = this.options.queueName
      ? {...rawSqsEventDefinition, queueName: this.options.queueName}
      : rawSqsEventDefinition;
    ```
    (If extracting a pure `resolveQueueName(options, def)` helper is cleaner, do that and test it.)

### `src/log.js` (NEW) — canonical shim from `[[00-goal]]`.

### `package.json`
11. Add `"src/log.js"` to `files`. Bump `version` 8.0.0 → **8.1.0**. Keep peer `"^10.0.2 || >=11"`.

### `README.md`
12. Add the "## Serverless Framework v4" note. Document the new `queueName` override option under config.

## Tests (NEW — `test/index.js`, AVA, docker-free)
- `normalizeLog` (as in s3 plan).
- `toDeleteEntries` — Ids are **unique within a batch** and are short strings; `ReceiptHandle` preserved;
  handles `undefined`/empty input.
- `queueName` override helper (if extracted) — override wins when set, falls back to the event def otherwise,
  and does **not** mutate its input.
- `SQSEvent` mapper — maps SQS messages → the `aws:sqs` Lambda event shape with the **correct `awsRegion`**
  (regression guard for #166).

## Gating
- `npm run eslint` green. `npx ava` green. `grep -rn '@serverless/utils/log\|serverless.cli.log' packages/serverless-offline-sqs` → empty.

## Acceptance
- v4-clean; `awsRegion` correct; delete-batch Ids unique; `queueName` override works non-mutating; tests pass; 8.1.0.

## Credits — zlalvani (#166), flipscholtz (#253), mfamilia (#211).
</content>
