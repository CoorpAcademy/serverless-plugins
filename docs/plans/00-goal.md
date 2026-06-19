# GOAL — own the v4 migration & re-implement worthwhile community PRs

> **Owner:** CoorpAcademy (CLXP-103) · **Branch:** `feat/serverless-v4-support` · **Status doc.**
> This is the north star. Every plan doc in `docs/plans/` serves this goal. See `[[serverless-v4-migration-review]]`
> and `[[open-pr-triage]]` for the analysis this builds on.

## The one-sentence goal

Ship **our own** correct, tested, v3-compatible Serverless Framework **v4 support** across all four
`serverless-offline-*` plugins, folding in the worthwhile ideas from the open community PRs as code we
own — then push a clean PR (crediting original authors) and close the dead/stale/dependabot PRs with rationale.

## Done-state (measurable acceptance criteria)

**A — v4 migration (the must-do):**
- [ ] Zero `require('@serverless/utils/log')` anywhere in `packages/`.
- [ ] Zero `serverless.cli.log(...)` calls; all logging via the injected `{log}` 3rd arg (console-fallback).
- [ ] All 4 plugins load and run under **serverless v4 AND v3** (back-compatible by construction).
- [ ] Peers stay **wide** (`serverless-offline: ">=11"`); version bumps are **minor** (back-compatible).

**B — re-implemented community PRs (owned by us):**
- [ ] #166 — `this.region` → `this.options.region` in **all three** affected packages (sqs, kinesis, ddb).
- [ ] #253 — SQS delete-batch entry `Id`s are unique within a batch (index-based).
- [ ] #211 — SQS `queueName` override from `custom` config.
- [ ] #98 — DynamoDB "table does not have streams" explicit error.
- [ ] #100 — Kinesis bounded retry + error logging (mirror DynamoDB's bounded retry).
- [ ] #249 — Kinesis awaits `lambda.create(...)`.

**Quality / ownership:**
- [ ] Docker-free **AVA unit tests** added for the pure logic touched (offline plugins start with none).
- [ ] `npm run eslint` is **green** (lint + Prettier).
- [ ] Each changed package: README updated, `package.json` `files` updated if a file was added, version bumped.
- [ ] Foundation docs (`architecture`, `conventions`, `testing-and-ci`, `publishing-and-versioning`) + skill + agent committed.

**Close-out:**
- [ ] PR pushed to `CoorpAcademy/serverless-plugins` with a meticulous description + author credits.
- [ ] Close-list rationale recorded for #99, #117, #137 and the 5 dependabot PRs.
- [ ] Deferred (with reasons + follow-up plan): #183 (DLQ autocreate), #168 (start-without-events/host).

## Explicitly OUT of scope (and why)

- **#183 DLQ autocreate & #168 host/start changes** — high value but require Docker + serverless-v4
  integration to verify safely; shipping unverified SQS-autocreate changes risks regressions. Deferred to
  a Tier-2 PR once the integration lane is validated (`[[07-deferred-and-closed-prs]]`).
- **#117 enabled flag, #137 termination, #99 error logging** — low value / superseded / dead architecture.
- **Publishing to npm** — done by a human via `lerna publish` after review (canary first). Out of this PR.
- **Consumer-service bumps & deploys** (api-scorm/push) — separate CLXP-103 follow-up, not this repo.

## Canonical artifacts every package agent must use verbatim

**The log shim — create `packages/<pkg>/src/log.js` identically in each touched package:**

```js
const noop = () => {};

const defaultLog = {
  debug: noop,
  info: console.log.bind(console),
  notice: console.log.bind(console),
  warning: console.warn.bind(console),
  error: console.error.bind(console),
  success: console.log.bind(console)
};

const normalizeLog = log => ({...defaultLog, ...log}); // spread of null/undefined is a no-op

module.exports = {defaultLog, normalizeLog};
```

**Constructor contract (each `src/index.js`):**

```js
const {normalizeLog} = require('./log');
// ...
constructor(serverless, cliOptions, {log} = {}) {
  this.cliOptions = cliOptions;
  this.serverless = serverless;
  this.log = normalizeLog(log);
  this.hooks = { /* unchanged */ };
}
```

- Replace `this.serverless.cli.log(x)` → `this.log.notice(x)`.
- Replace `log.debug(...)` → `this.log.debug(...)`; `log.warn/warning(...)` → `this.log.warning(...)`.
- Thread the logger into the emulator sub-module: `new S3(this.lambda, resources, this.options, this.log)`,
  and in the sub-module `constructor(lambda, resources, options, log) { this.log = normalizeLog(log); }`.
- Add `src/log.js` to the package's `package.json` `files` array.

## Workflow shape (Step 4)

Parallel agents **partitioned by package** (no shared files → no conflicts):
`s3`, `sqs`, `kinesis`, `dynamodb-streams` — each follows its plan doc. Then a **cross-cutting** agent
(root `package.json`, `.travis.yml`, root README), then **adversarial review**, then gate + PR.

## Plan index

- `[[01-package-s3]]` · `[[02-package-sqs]]` · `[[03-package-kinesis]]` · `[[04-package-dynamodb-streams]]`
- `[[05-cross-cutting-peers-ci-docs]]` · `[[06-pr-and-closeout]]` · `[[07-deferred-and-closed-prs]]`
</content>
