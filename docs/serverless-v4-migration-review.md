# Serverless Framework v4 migration — critical review

> **Date:** 2026-06-19 · **Scope:** `CoorpAcademy/serverless-plugins` · **Context:** CLXP-103
> **Status:** read-only analysis. No code changed.
> Companion: [`open-pr-triage.md`](./open-pr-triage.md).

## TL;DR

agnusha's **PR #264** gets the *hard part* right — the v4 logger contract — and that saves us real
work. But it is **not safe to merge as-is**. Three things are weaker than they look: the **green CI
check** (it never runs serverless v4), the **peer range** (needlessly breaks gradual migration), and
the **test assertions** (silently weakened). Adopt the core fix, reject the peripheral churn, finish
the other two packages, and add a real v4 test lane.

---

## 1. What this repo is

Lerna + yarn-workspaces monorepo of 6 Serverless Framework plugins. The four `serverless-offline-*`
plugins (s3, sqs, kinesis, dynamodb-streams) are near-identical: a class with `offline:start:*` hooks
that spins up a local emulator (Minio / ElasticMQ / kinesalite) and routes events into
`serverless-offline`'s Lambda runner.

All four `require('@serverless/utils/log')` at module top — the **exact module v4 deleted**. That
single `require` throws on *every* `sls` command under v4. That is the whole bug.

## 2. The core bug & the correct fix

**Root cause:** v4 removed `@serverless/utils/log`.

```js
const log = require('@serverless/utils/log').log;   // ❌ "Cannot find module" under v4
```

**Correct fix (agnusha's direction — keep it):** stop importing the dead module; take `{log}` from
the **3rd constructor argument** (the framework injects it), thread it into sub-modules, with a
console fallback.

```js
constructor(serverless, cliOptions, {log} = {}) {
  this.log = log || { notice: console.log, debug: () => {}, warning: console.warn };
  ...
}
```

The PR also correctly swaps the **other** dead v4 API — `this.serverless.cli.log(...)` →
`this.log.notice(...)` — and fixes a latent bug (`log.warn` → `log.warning`; `.warn` never existed
on this logger).

> **Why this is backward-compatible:** the `{log}` 3rd arg has existed since **serverless v3.0**, and
> the code degrades to console when it's absent. So the plugin works on **both v3 and v4** by
> construction. This fact drives several decisions below.

## 3. What to challenge in PR #264

### 🔴 3.1 CI does not actually test serverless v4 — "Travis green" is a false signal
- Root `package.json` still pins `serverless: ^3.36.0`.
- `.travis.yml` only bumps node `20` → `20.18.1`. **No v4 lane.**
- Integration tests run `sls offline` against the **root's serverless v3**, while the workspace
  bumps `serverless-offline` to `^14` (which peers serverless `^4`).
- ⇒ Green proves *"works under v3 + offline@14"*, **not** the thing the PR claims. The dependency
  tree is internally inconsistent (offline@14 wants sls@4, root has sls@3) — that mismatch is most
  of the **21,305-line lockfile churn**.

**Action:** add a real `serverless@4` test matrix. That is the only thing that proves the fix.

### 🔴 3.2 Peer-range narrowing breaks the gradual-migration strategy
- PR sets `serverless-offline: "^14.4.0 || >=14"` (which is just `>=14`, redundantly written) and
  dev-dep `^14.4.0` — **dropping** offline 10–13 support.
- But the code is backward-compatible (§2). The handover **explicitly** wants v3+v4 support so
  services migrate one at a time.

**Action:** keep the peer **wide** (`serverless-offline: >=11`). If peer stays wide, these may not
even need to be **major** bumps.

### 🟠 3.3 The test rewrite silently weakens its own assertions
- s3 `EXPECTED_LAMBDA_CALL` drops **9 → 7**. The old test counted *lambda invocations*
  (`Billed Duration` lines) and expected pictures to be "consumed twice, by myPromiseHandler and
  myPythonHandler."
- The new test counts *unique events* via a `processedEvents` Set keyed `bucket-objectkey`, which
  **collapses those two handler invocations into one**. A regression where the second handler stops
  firing would now pass undetected.

**Action:** restore the per-handler invocation assertion; don't dedup it away.

### 🟠 3.4 Tests now lean on hardcoded sleeps + kill-on-count
- Rewritten tests use fixed `delay(1000/2000)` + process kill on a counter. Inherently racy; will
  flake in CI. Looks like "make the flaky test pass," not "validate behavior."

**Action:** poll for completion (or assert on emulator/queue state) instead of fixed sleeps.

### 🟡 3.5 DRY + inconsistent defensive code
- The console-shim `{debug, notice, warning}` is duplicated **3× per package** (inline in index.js,
  `defaultLog` in the sub-module, plus a `_safeLog` guard).
- In `s3.js` it's applied unevenly — `this.log.debug(...)` direct in `start()` but
  `_safeLog('warning', ...)` in `_s3Event`. Either normalize once in the constructor and trust it,
  or guard everywhere.
- The shim is also **incomplete** (no `error` / `info` / `success` levels).

**Action:** one shared `default-log` util across all four packages.

### ⚠️ 3.6 The PR is incomplete
- It fixes only **s3 + sqs**. **kinesis** and **dynamodb-streams** still
  `require('@serverless/utils/log')` (6 dead imports) and still call `serverless.cli.log` (12 dead
  calls). Merging #264 alone leaves the repo half-migrated with mismatched peer ranges across
  packages.

## 4. Recommended path (we own it now)

1. **Adopt agnusha's core `{log}` pattern, reject the peripheral churn** — cherry-pick the logging
   fix; drop the test rewrite and the peer narrowing.
2. **Factor one shared log-shim** (full level set) and apply it uniformly across **all four**
   packages in a single coherent change.
3. **Keep peers wide** (`serverless-offline: >=11`) so v3 services keep working; bump as **minor**
   unless we deliberately choose to drop old offline.
4. **Add a real v4 CI lane** (matrix install of `serverless@4` + `serverless-offline@14`).
5. **Fix tests properly** — restore per-handler assertions, replace fixed sleeps with polling.
6. **Canary-publish**, smoke-test one consumer, then stable (per handover).

## 5. Verified facts (grounding)

| Claim | Evidence |
|---|---|
| Dead import in all 4 plugins | `grep @serverless/utils/log packages/` → 6 hits (s3 ×2, sqs ×2, kinesis ×1, dynamodb ×1) |
| Dead `serverless.cli.log` in all 4 | `grep cli.log packages/` → 12 hits across the 4 index.js |
| PR diff size | `+21,750 / −14,290`, 15 files — **21,305/14,130 is the lockfile alone** |
| Peer change | `^10.0.2 \|\| >=11` → `^14.4.0 \|\| >=14` in s3 & sqs package.json |
| CI change | `.travis.yml`: node `"20"` → `"20.18.1"` only; no serverless@4 |
| Test weakening | `test-s3.js`: `EXPECTED_LAMBDA_CALL` 9 → 7; counting moved stderr→stdout w/ dedup Set |
| `{log}` exists on v3 too | serverless ≥3.0 plugin constructor 3rd arg `{log, writeText, progress}` |
</content>
