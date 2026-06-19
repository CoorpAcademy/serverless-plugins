# Open PR triage — `serverless-plugins`

> **Date:** 2026-06-19 · **17 open PRs** (123 closed, all-time) · **Status:** read-only analysis.
> Companion: [`serverless-v4-migration-review.md`](./serverless-v4-migration-review.md).

## How to read this

Each PR was judged on its **actual diff against current `master`**, not on title. The recurring
theme: most community PRs are old (2019–2023) and target an **architecture that no longer exists**
(the plugins were rewritten — `functionHelper.createHandler` / `LambdaContext` / `this.service` /
`before:offline:start` hooks are gone; current code uses `offline:start:init` hooks,
`import('serverless-offline/lambda')`, `_getEvents`/`_resolveFn`). Their patches are dead even when
the *idea* is still good.

**Buckets:** `MERGE` (after v4 base) · `MERGE+` (small work) · `REIMPL` (good idea, dead patch — close & redo) · `CLOSE` (throw away).

## Summary table

| PR | Title | Pkg | Size | State | Verdict |
|---|---|---|---|---|---|
| #166 | fix undefined `this.region` | sqs | +1/-1 | conflict | **MERGE** — real bug, still on master |
| #264 | v4 support (s3 + sqs) | s3,sqs | +21k/-14k | clean | **MERGE+** — base, needs rework (see review doc) |
| #253 | distinct SQS delete-batch IDs | sqs | +14k/-3 | clean | **MERGE+** — strip lockfile, keep fix |
| #249 | kinesis: await lambda create | kinesis | +2/-2 | clean | **MERGE+** — take `await`, reject import change |
| #211 | sqs: queueName override from config | sqs | +7/-0 | clean | **MERGE+** — niche, fix param mutation |
| #98 | dynamodb: "table has no streams" error | ddb | +3/-0 | conflict | **REIMPL** — good DX, dead patch |
| #100 | dynamodb: retries option | ddb | +14/-1 | conflict | **REIMPL** — useful, dead patch |
| #183 | sqs: autocreate DLQ from resources | sqs | +57/-2 | conflict | **REIMPL** — real feature, dead + needs v4 |
| #168 | start non-SQS lambdas / default localhost | sqs | +13/-4 | conflict | **REIMPL** — partial, redo carefully |
| #99 | dynamodb: log function errors to console | ddb | +2/-1 | conflict | **CLOSE** — superseded by #264 logger |
| #117 | sqs: `enabled` flag | sqs | +17/-10 | conflict | **CLOSE** — dead arch, low value |
| #137 | kinesis: avoid waiting for termination | kinesis | +1/-2 | conflict | **CLOSE** — dead arch, unclear value |
| #234 | ⬆️ bump qs and formidable | dev | +14/-41 | clean | **CLOSE** — mooted by v4 lockfile regen |
| #243 | ⬆️ bump cookiejar | dev | +6/-3 | clean | **CLOSE** — mooted by v4 lockfile regen |
| #244 | ⬆️ bump simple-git | dev | +6/-3 | conflict | **CLOSE** — mooted by v4 lockfile regen |
| #246 | ⬆️ bump http-cache-semantics | dev | +6/-3 | clean | **CLOSE** — mooted by v4 lockfile regen |
| #240 | ⬆️ bump json5 | dev | +12/-6 | conflict | **CLOSE** — mooted by v4 lockfile regen |

---

## Details

### ✅ MERGE — real fix, do first

**#166 — fix undefined reference to `this.region`** (zlalvani)
> `sqs.js:119` on master: `new SQSEvent(messages, this.region, arn)`. The class stores `this.options`,
> never `this.region`, so **region is `undefined` today**. Fix: `this.region` → `this.options.region`.
> One line, genuine bug, still present. Rebase the one-liner onto the v4 base and ship.

### 🔧 MERGE+ — merge after small work

**#264 — v4 support** (agnusha) — the base. See [review doc](./serverless-v4-migration-review.md):
adopt core `{log}` fix, keep peers wide, finish kinesis+dynamodb, add v4 CI, fix tests. **Don't merge raw.**

**#253 — distinct SQS delete-batch IDs** (flipscholtz)
> AWS `deleteMessageBatch` requires entry `Id`s unique *within a batch*; current code reuses
> `MessageId` as `Id`. Real hardening (uuid per entry). The `+14,013` is a **brand-new per-package
> lockfile** committed by mistake — **drop the lockfile**, keep the ~3-line code change + `uuid` dep.

**#249 — kinesis await lambda create** (gabsong)
> Two changes: (a) `await this.lambda.create(...)` — **valid**, current code doesn't await; (b)
> swap dynamic `import('serverless-offline/lambda')` for `require('serverless-offline/src/lambda')`
> — **wrong** (reaches into `/src`, kills the deliberate ESM dynamic import). Take (a), reject (b).

**#211 — sqs queueName override** (mfamilia)
> Clean, targets current `_create`. Lets `custom.serverless-offline-sqs.queueName` override the event
> definition. Niche but harmless. Cleanup: it **mutates `rawSqsEventDefinition`** in place — make it
> non-mutating. Low priority.

### ♻️ REIMPL — keep the idea, close the PR

These patches no longer apply (dead architecture and/or v4-incompatible imports). Re-implement small
issues against current code; close the PR with a thank-you + link to the new work.

- **#98 — "table does not have streams" error** (dolsem): great DX (clear failure instead of a cryptic
  crash). Re-add an explicit guard in current dynamodb-streams flow.
- **#100 — retries option** (dolsem): default `Infinity` (current behavior), allow finite `retries`.
  Useful for local dev. Re-implement in current event loop + document.
- **#183 — autocreate DLQ from resources** (JeisonJHA): real feature (honor `RedrivePolicy` on
  autocreate). Patch uses dead `serverless-offline/dist/serverlessLog` import and old sqs.js shape —
  redo for current code **after** v4 base lands.
- **#168 — start lambdas without SQS events / default localhost** (russellpekala): partially valid
  (create the Lambda runner even when no SQS events). But the `this.options.host = 'localhost'`
  mutation and `lambda.start()` additions need scrutiny against current `_createLambda`. Redo cleanly.

### 🗑️ CLOSE — throw away

- **#99 — log function errors to console** (dolsem): **superseded** by #264 threading the real logger
  + the s3/sqs error-logging improvements. Obsolete.
- **#117 — `enabled` flag** (fernyettheplant): targets the old `before:offline:start` hook
  architecture and `this.streams`; none of it exists. Low value (just don't add the plugin). Close;
  re-implement only if a consumer actually needs it.
- **#137 — avoid waiting for termination signal** (umairnadeem): references `_startWithExplicitEnd`
  (gone; current is `_startWithReady`). Behavior intent is murky and risks breaking clean shutdown.
  Close.
- **#234 / #240 / #243 / #244 / #246 — dependabot bumps** (2023): all transitive/dev bumps against
  the **old** lockfile. The v4 work **regenerates the entire lockfile** (21k lines), mooting them;
  #240 and #244 already conflict. Close all five and let dependabot re-open against the new tree if
  anything is still flagged.

---

## Suggested execution order

1. **Land the v4 base** (reworked #264 across all 4 packages + wide peers + v4 CI). Everything else rebases on this.
2. **#166** (one-line region bug) and **#253** (delete-batch IDs, lockfile stripped) — quick, high-value correctness.
3. **#249(a)** await-create for kinesis while it's being v4-fixed anyway.
4. **#211** queueName override (optional, non-mutating).
5. **Re-implement** #98, #100, #183, #168 as fresh small PRs/issues against current code.
6. **Close** #99, #117, #137 and the 5 dependabot PRs with a short rationale.

> Net: of 17 open PRs — **1 to merge, 4 to merge after small work, 4 to re-implement, 8 to close**
> (3 stale-code + 5 dependabot).
</content>
