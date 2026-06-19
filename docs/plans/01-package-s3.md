# TODO — `serverless-offline-s3` (v4 migration + cleanup)

> **Agent:** `serverless-plugin-author` · **Skill:** `serverless-plugin-dev` · **Goal:** `[[00-goal]]`
> **Refs:** `[[architecture]]`, `[[conventions]]`, `[[testing-and-ci]]` · **Scope:** ONLY `packages/serverless-offline-s3/`.

## Changes

### `src/index.js`
1. Delete `const log = require('@serverless/utils/log').log;`. Add `const {normalizeLog} = require('./log');`.
2. Constructor → `constructor(serverless, cliOptions, {log} = {})`; set `this.log = normalizeLog(log)`.
   Drop the redundant `this.x = null;` pre-assignments while you're here (house cleanup).
3. Replace all `this.serverless.cli.log(...)` (in `start()`, `_listenForTermination()`, `end()`) → `this.log.notice(...)`.
4. `_mergeOptions`: `log.debug('options:', this.options)` → `this.log.debug('s3 options:', this.options)`.
5. `_createS3`: thread the logger → `new S3(this.lambda, resources, this.options, this.log)`.

### `src/s3.js`
6. Delete `const log = require('@serverless/utils/log').log;`.
7. Constructor → `constructor(lambda, resources, options, log) { ...; this.log = require('./log').normalizeLog(log); }`.
8. **Delete the dead methods** `_create` and `_s3Event` (the latter calls `listener.stop()` immediately after
   registering — orphaned). Remove the now-unused `require('./s3-event-definition')` import.
9. The live `start()` `catch`: `log.warn(err.stack)` → `this.log.warning(err.stack)` (note: `warning`, not `warn`).

### `src/log.js` (NEW)
10. Create it **verbatim** from `[[00-goal]]` (the canonical shim).

### `package.json`
11. Add `"src/log.js"` to `files`. Bump `version` 7.0.0 → **7.1.0** (back-compatible). Keep peer `"^10.0.2 || >=11"`.

### `README.md`
12. Add a short "## Serverless Framework v4" note: works on v3 and v4; logging now uses the framework-injected logger.

## Tests (NEW — `test/index.js`, AVA)

Offline plugins have zero unit tests today. Add docker-free tests:
- `normalizeLog` — returns all levels; merges a partial `{notice}`; uses defaults for missing levels; `normalizeLog(undefined)` is safe.
- `S3Event` — maps a representative Minio notification record into the AWS S3 Lambda event shape (`Records[0].s3.bucket.name`, `object.key`, `eventSource: 'aws:s3'`, etc.). Pure mapper, no client.

## Gating (must pass before done)
- `npm run eslint` green (lint + Prettier).
- `npx ava packages/serverless-offline-s3/test/*.js` (or root `npx ava`) green.
- Confirm `grep -rn '@serverless/utils/log\|serverless.cli.log' packages/serverless-offline-s3` returns nothing.

## Acceptance
- No dead `@serverless/utils/log` / `cli.log`; logger threaded; dead s3 methods removed; tests pass; version bumped.

## Credits — none (pure v4 + our cleanup).
</content>
