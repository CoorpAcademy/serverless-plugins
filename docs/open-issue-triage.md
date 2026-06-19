# Open ISSUE triage — `serverless-plugins`

> **Date:** 2026-06-20 · **65 open issues** · **Status:** READ-ONLY analysis. No code changed.
> Companions: [`open-pr-triage.md`](./open-pr-triage.md) · [`serverless-v4-migration-review.md`](./serverless-v4-migration-review.md) · [`plans/00-goal.md`](./plans/00-goal.md)
>
> Each issue was judged against the **current code on `feat/serverless-v4-support`** (not against the
> title or the version the reporter was on). "Fixed" means the fix is present on this branch and ships
> the moment we `lerna publish`. Numbers in `()` after a verdict are related issue/PR refs.

## How to read this

Four buckets, exactly as requested:

1. **✅ FIXED — close on release** — our v4 branch already resolves it. Verify, reply, close when published.
2. **🐞 REAL BUG — we should fix** — genuine defect in *current* code. Has an action plan below.
3. **🧩 KEEP — valuable, can't ditch** — legitimate feature/bug we want, but bigger or deferred (Tier-2).
4. **🗑️ DITCH — close** — stale, environment/config, user error, out-of-scope, wontfix, or not our code.

Plus two **investigation clusters** (recurring symptoms that need a repro before we can bucket each one).

---

## Headline findings

1. **The v4 release alone closes a cluster.** `#263, #232, #182, #219, #165, #145, #169` are already fixed
   on this branch. `#263` (the `@serverless/utils/log` crash) is the most-active, most-recent issue in the
   tracker — publishing the v4 versions is the single highest-leverage action.
2. **`aws-sdk@^2` is the next big theme.** *All four* plugins still `require('aws-sdk/clients/...')`
   (v2, EOL). This is the root of `#248, #252, #260` and the noisy maintenance-mode warnings. A v3 migration
   is the natural Tier-2 epic after v4 lands.
3. **Two long-standing clusters dominate the bug tail:** SQS "lambda not triggered / only runs once"
   (`#210, #255, #198, #147, #132, …`) and DynamoDB-streams "shard iterator / replay / empty table"
   (`#54, #82, #84, #154, #163, #164, #178`). Most need a clean repro on the v4 base before we touch code.
4. **DLQ / autoCreate is a real feature gap** repeatedly reported (`#65, #133, #167, #87`) — the same need
   behind PR `#183`. Worth owning.
5. **`serverless-offline-ssm-provider` has no source in this monorepo** (only a `README.md` is tracked).
   `#105, #152, #186` may not be ours to fix here — confirm where that package lives before acting.
6. **`#259` is not our repo** (reporter uses none of our plugins) — close.

---

## Master table (all 65)

| # | Pkg | Title (short) | Bucket | One-line action |
|---|---|---|---|---|
| 263 | core/sqs | v4 `@serverless/utils/log` not found | ✅ FIXED | Close on release — log shim landed |
| 232 | sqs | `Cannot read property 'debug'` | ✅ FIXED | Close on release — `normalizeLog` defaults |
| 182 | sqs | undefined `this.region` | ✅ FIXED | Close — `this.options.region` |
| 219 | sqs | SQS event region undefined (dup 182) | ✅ FIXED | Close as dup of #182 |
| 165 | sqs | ReadCountOutOfRange w/ batchSize>1 | ✅ FIXED | Close — `MaxNumberOfMessages` capped at 10 |
| 145 | ddb | `this._waitFor is not a function` | ✅ FIXED | Close — catch now recurses `_describeTable` |
| 169 | ddb | prevents serverless exiting | ✅ FIXED | Close — `end()` now handles signal + exits |
| 226 | sqs | uncaught handler error kills process | ✅ FIXED? | Verify — `job()` now try/catches → `log.warning` |
| 250 | kinesis | CJS/ESM build error | ✅ FIXED? | Verify on v4 base — dynamic `import()` now used |
| 197 | ddb | ECONNREFUSED on SIGINT | ✅ FIXED? | Verify — tied to #169; mostly dynamodb-local env |
| 200 | sqs | Missing QueueName w/ `Fn::Join` arn | 🐞 BUG | Resolve `Fn::Join` arns; fix `switch` fallthrough |
| 262 | sqs | `queueName` extraction + array support | 🐞 BUG | Replace `switch('string')`; (opt) array of names |
| 225 | sqs | explicit queue create fails (AWS/sqslite) | 🐞 BUG | Omit `QueueName` from `Attributes` on `createQueue` |
| 159 | sqs | FIFO not honored on autoCreate | 🐞 BUG | Honor `FifoQueue`/`.fifo` when autocreating |
| 158 | sqs | idle CPU spin (`setTimeout(f, NaN)`) | 🐞 BUG | Add `functionCleanupIdleTimeSeconds` to defaults |
| 241 | ddb | hangs if table/stream missing | 🐞 BUG | Bound `_describeTable` retries; warn + continue |
| 103 | ddb | several stream-ARN gaps | 🐞 BUG | Add `arn` null-check; `Fn::ImportValue`/`Ref` (tableName already works) |
| 101 | apigw | `__unused_stage__` non-alphanumeric | 🐞 BUG | Fix stage-name templating in access-logs plugin |
| 160 | sqs | docs link 404 / can't follow setup | 🐞 BUG | Fix README integration link |
| 186 | ssm | default `Parameter.Type` missing | 🐞 BUG* | *Confirm we own ssm-provider source first |
| 65 | sqs | autoCreate DLQs + redrive | 🧩 KEEP | Feature — own PR #183 idea |
| 133 | sqs | DLQ autoCreate broken (NonExistentQueue) | 🧩 KEEP | Same root as #65/#167 |
| 167 | sqs | can't create queue w/ RedrivePolicy | 🧩 KEEP | Same root as #65/#133 |
| 87 | sqs | MessageRetentionPeriod/redrive offline | 🧩 KEEP | Partly ElasticMQ limit; tie to DLQ work |
| 221 | sqs | partial batch failure reporting | 🧩 KEEP | Implement `ReportBatchItemFailures` |
| 227 | sqs | `maximumBatchingWindow` ignored | 🧩 KEEP | Map to `WaitTimeSeconds` (now hard-coded 5) |
| 242 | ddb | `filterPatterns` ignored | 🧩 KEEP | Implement event-filtering locally |
| 64 | apigw | apply access-logs to existing stack | 🧩 KEEP | Support pre-existing stage |
| 248 | ddb | still aws-sdk v2 | 🧩 KEEP | v3 migration epic |
| 252 | sqs | still aws-sdk v2 | 🧩 KEEP | v3 migration epic |
| 260 | sqs | breaks on newer @aws-sdk (500/HTML) | 🧩 KEEP | Investigate w/ v3 migration |
| 127 | kinesis | ProvisionedThroughputExceeded | 🧩 KEEP | Add read backoff option |
| 54 | ddb | premature `end` (TRIM_HORIZON fires once) | 🔍 INVESTIGATE | Stream-iterator cluster (readable lib) |
| 82 | ddb | only 1st read interval | 🔍 INVESTIGATE | = #54 cluster |
| 84 | ddb | doesn't work for empty table | 🔍 INVESTIGATE | = #54 cluster |
| 163 | ddb | handler triggered only once | 🔍 INVESTIGATE | = #54 cluster |
| 178 | ddb | past events replayed each start / OOM | 🔍 INVESTIGATE | = #54 cluster (iterator persistence) |
| 154 | ddb | Invalid ShardId in ShardIterator | 🔍 INVESTIGATE | Iterator expiry on long sessions |
| 164 | ddb | Invalid ShardId in ShardIterator | 🔍 INVESTIGATE | = #154 |
| 238 | ddb | `serverless-offline/lambda` not found + tableName warn | 🔍 INVESTIGATE | Verify on v4 base; register `tableName` in schema |
| 210 | sqs | only runs jobs on first run | 🔍 INVESTIGATE | SQS-trigger cluster |
| 255 | sqs | doesn't trigger lambda (elasticMQ) | 🔍 INVESTIGATE | SQS-trigger cluster |
| 198 | sqs | event doesn't start lambda (`--useDocker`) | 🔍 INVESTIGATE | SQS-trigger cluster (docker) |
| 147 | sqs | stops triggering | 🔍 INVESTIGATE | SQS-trigger cluster |
| 132 | sqs | SQS + HTTP, only one lambda starts | 🔍 INVESTIGATE | Verify on v4 — `_createLambda` builds all |
| 161 | sqs | breaks on non-default port | 🔍 INVESTIGATE | Verify `_rewriteQueueUrl` + endpoint config |
| 123 | sqs | frequent 503 Service Unavailable | 🔍 INVESTIGATE | ElasticMQ timeout; verify on v4 |
| 170 | sqs | won't boot under `node --inspect` | 🔍 INVESTIGATE | Repro (Windows path in report) |
| 189 | sqs | Missing QueueName/QueueUrl (fifo arn) | 🔍 INVESTIGATE | = #200 arn-parsing family |
| 74 | sqs | breaks w/ serverless-pseudo-parameters | 🔍 INVESTIGATE | arn-resolution ordering; = #200 family |
| 143 | sqs | vars outside handler break (2nd msg) | 🔍 INVESTIGATE | Likely core serverless-offline; = #102 |
| 102 | sqs | `--useWorkerThreads` resets `process.env` | 🔍 INVESTIGATE | Likely core serverless-offline |
| 135 | sqs | queue URL env var = `[object Object]` | 🔍 INVESTIGATE | `Ref` not resolved offline; scope check |
| 146 | sqs | bundle ElasticMQ | 🗑️ DITCH | Already `wontfix` — keep closed stance |
| 130 | sqs | docker-compose http/https to elasticmq | 🗑️ DITCH | Config/support Q — answer & close |
| 156 | sqs | subscribe SQS→SNS offline | 🗑️ DITCH | Cross-plugin, out of scope |
| 195 | sqs | `variablesResolutionMode: 20210326` | 🗑️ DITCH | Serverless v2-era, obsolete |
| 222 | sqs | locally skip a plugin | 🗑️ DITCH | Low value — document "remove the plugin" |
| 239 | sqs | lift + localstack guide | 🗑️ DITCH | HOWTO; its fix (#211 queueName) already landed |
| 184 | ddb | doesn't work with Dynalite | 🗑️ DITCH | Dynalite lacks streams — not our bug |
| 259 | core | serverless runs forever | 🗑️ DITCH | Reporter uses none of our plugins |
| 254 | meta | still maintained? | 🗑️ DITCH | Reply "yes, v4 landing" & close |
| 105 | ssm | example config file | 🗑️ DITCH* | Docs Q — *ssm-provider source not in repo |
| 152 | ssm | clarify intended behavior | 🗑️ DITCH* | Docs Q — *ssm-provider source not in repo |

---

## ✅ FIXED — close on release (7 verified + 3 to verify)

These resolve the moment the v4 versions publish. Reply on each thanking the reporter, link the release.

- **#263 — `@serverless/utils/log` not found (v4).** Root cause of the whole v4 breakage. Branch replaces
  the hard `require('@serverless/utils/log')` with the injected `{log}` 3rd arg + `src/log.js`
  console-fallback shim. **The flagship close.**
- **#232 — `Cannot read property 'debug' of undefined`.** Same logger problem from the v3 era;
  `normalizeLog(log)` now defaults every level, so a missing logger can't crash.
- **#182 / #219 — `this.region` undefined.** `sqs.js` now passes `this.options.region` to `SQSEvent`
  (was `this.region`, never set). #219 is a duplicate — close both, credit zlalvani (PR #166).
- **#165 — ReadCountOutOfRange with `batchSize > 1`.** `getMessages` caps `MaxNumberOfMessages` at 10 and
  loops to fill `batchSize`, so SQS never sees an out-of-range count. Ask reporter to confirm on the new build.
- **#145 — `this._waitFor is not a function`.** `_describeTable`'s catch now recurses `_describeTable`
  (a real method), not the non-existent `_waitFor`. (See #241 for the *flip side* — it now retries forever.)
- **#169 — prevents serverless from exiting.** `_listenForTermination` now actually handles `SIGINT/SIGTERM`
  (`await this.end()` → `process.exit(0)`), instead of swallowing the first signal. Close.

**Verify before closing (likely fixed, confirm with a repro):**
- **#226 — uncaught handler error kills process.** `job()` wraps `runHandler()` in try/catch and logs via
  `this.log.warning`, so a throwing handler no longer tears down the process. Confirm, then close.
- **#250 — CJS/ESM kinesis build error.** Current code uses the deliberate dynamic `import('serverless-offline/lambda')`;
  the old mixed-module crash should be gone on the v4 base. Reproduce on a no-`"type"` package and close.
- **#197 — ECONNREFUSED on SIGINT.** Largely the `serverless-dynamodb-local` child process; the #169 fix
  should make shutdown clean. Verify against the sample repo.

---

## 🐞 REAL BUG — we should fix (current-code defects)

Small, well-scoped, high signal-to-noise. Good candidates for the next PR after v4 lands.

- **#200 — Missing QueueName with `Fn::Join` ARN.** `index.js#_resolveFn` only unwraps `Fn::GetAtt`/`Arn`;
  a `Fn::Join` ARN stays an object, so `SQSEventDefinition`'s `switch('string')` falls through and the ARN
  becomes `…:undefined`. **Fix:** resolve `Fn::Join` (and `Ref AWS::AccountId`) in `_resolveFn`, and make
  `sqs-event-definition.js` guard non-string arns. Same family as #189, #74.
- **#262 — `queueName` extraction (and array support).** The `switch('string')` construct is fragile and
  misses object/array shapes (overlaps #200). **Fix:** replace with explicit `if/else` + missing-prop guard.
  *Optionally* let `queueName` be an array → one listener per queue (the reporter's ask, niche).
- **#225 — explicit queue creation fails on real AWS / sqslite.** `_createQueue` builds `Attributes` from the
  *entire* `Properties` block, which includes `QueueName` → `InvalidAttributeName: Unknown Attribute QueueName`.
  ElasticMQ tolerates it; AWS/sqslite don't. **Fix:** `omit(['QueueName'], properties)` before `mapValues`.
- **#159 — FIFO queues not honored on autoCreate.** Autocreate ignores `FifoQueue`/the `.fifo` suffix, so a
  FIFO queue is created as standard and `MessageGroupId` is rejected. **Fix:** pass the `FifoQueue`
  (+ `ContentBasedDeduplication`) attributes through, or derive from a `.fifo` name. Overlaps the #225 fix.
- **#158 — idle CPU spin.** `defaultOptions` omits `functionCleanupIdleTimeSeconds`, so serverless-offline's
  `LambdaFunctionPool` does `setTimeout(f, NaN)` → busy loop. **Fix:** add `functionCleanupIdleTimeSeconds: 60`
  to `defaultOptions` in each `index.js`. Cheap, broad win.
- **#241 — hangs if table/stream missing.** Flip side of the #145 fix: `_describeTable` now recurses forever
  when the table doesn't exist, so serverless-offline never finishes booting. **Fix:** bound the retries and,
  on exhaustion, `log.warning` + skip that stream (don't block startup). Pairs with the #98 no-stream guard.
- **#103 — DynamoDB stream-ARN gaps.** `tableName` is now supported (`_resolveFn` checks `event.tableName`).
  Still missing: an `arn` null-check before `Fn::GetAtt`, and `Fn::ImportValue` / `Ref` ARN forms. **Fix:**
  add the guard + the two resolver branches. Update README example accordingly.
- **#101 — `__unused_stage__` non-alphanumeric** (serverless-apigateway-access-logs). Stage-name templating
  emits `ApiGatewayStage__unused_stage__`. **Fix:** correct the logical-id/stage derivation in that plugin's
  `src/index.js`. Self-contained.
- **#160 — broken docs.** The README "how it works" links to a removed `…-sqs-integration/docker-compose.yml`
  (404). **Fix:** point to the live `tests/serverless-plugins-integration/` setup. Trivial doc fix.
- **#186 — ssm-provider default `Parameter.Type`.** Real one-liner (default `Type: 'String'`), **but** the
  ssm-provider source is *not tracked in this monorepo* (only its README). Confirm where the package lives
  before doing anything; may belong to another repo / be unmaintained here.

---

## 🧩 KEEP — valuable, can't ditch (features / Tier-2)

Legitimate, repeatedly requested — keep open with a labelled roadmap. Don't close as "won't do".

- **DLQ + redrive cluster — #65, #133, #167, #87.** The most-requested SQS feature: on `autoCreate`, create
  dead-letter queues *first*, then the main queue with its `RedrivePolicy`. Today the redrive target doesn't
  exist → `NonExistentQueue`. This is exactly PR **#183**'s idea — own it. (#87 also touches
  `MessageRetentionPeriod`, partly an ElasticMQ limitation — set expectations there.)
- **#221 — partial batch failure reporting.** Support `FunctionResponseTypes: ReportBatchItemFailures`:
  only delete messages *not* in the handler's `batchItemFailures`. Modern, well-defined, high value.
- **#227 — `maximumBatchingWindow`.** `WaitTimeSeconds` is hard-coded to 5 in `getMessages`; map the event's
  `maximumBatchingWindow` onto it. Small, but currently a silent no-op.
- **#242 — DynamoDB `filterPatterns`.** Apply event-source filter patterns locally before invoking the
  handler. Larger (needs an AWS-compatible filter evaluator) but genuinely useful.
- **#64 — apply access-logs to an existing stack.** `ApiGatewayStage … already exists` when the stage
  predates the plugin. Support attaching to a pre-existing stage. apigateway-access-logs.
- **aws-sdk v3 epic — #248, #252, #260.** All plugins still use `aws-sdk@^2` (EOL, maintenance warnings).
  Migrate to modular `@aws-sdk/client-*`. #260 (deserialization 500/HTML) likely shakes out here too.
  Big, coordinated, post-v4. The natural next milestone.
- **#127 — Kinesis `ProvisionedThroughputExceededException`.** Local reads are too aggressive against a
  shared dev stream. Add a configurable read interval / backoff. Question-flavoured but actionable.

---

## 🔍 Investigation clusters (need a repro on the v4 base before bucketing)

These share symptoms; chasing them individually wastes effort. Build one repro harness per cluster on the
v4 branch, then split into FIX / KEEP / DITCH.

**A — SQS "lambda not triggered / only runs once": #210, #255, #198, #147, #132, #161, #123, #170, #135.**
Current `_sqsEvent` re-adds `job` to a `PQueue` after each poll, so steady-state polling *should* work.
Most reports are old and smell of config (ElasticMQ `receiveMessageWait`, `autoCreate:false` against a
missing queue, `--useDocker`, non-default port + endpoint mismatch). Reproduce against ElasticMQ on the v4
build; several likely close as fixed/config. `#132` (SQS + HTTP) specifically should be re-tested — current
`_createLambda` builds *all* lambdas, not just SQS ones.

**B — DynamoDB-streams iterator/replay: #54, #82, #84, #163, #178, #154, #164, #238.** Two sub-themes:
(1) `dynamodb-streams-readable` emits `end` prematurely so `TRIM_HORIZON` only fires on boot (#54 → #82, #84,
#163); (2) shard-iterator expiry on long sessions (#154, #164) and replay/OOM on restart (#178). These point
at the `dynamodb-streams-readable` package and the `startingPosition` handling — the real engineering work in
this repo. Needs a DynamoDB-Local + stream repro. `#238`'s `tableName` schema warning is separable (register
the property in the plugin schema).

**C — env/runtime edge cases: #143, #102.** "Variables outside the handler break on the 2nd message",
`--useWorkerThreads` resets `process.env`. These are most likely **core `serverless-offline`/Lambda-pool**
behavior, not ours. Confirm against a vanilla serverless-offline setup; if it reproduces without our plugin,
redirect upstream and close.

---

## 🗑️ DITCH — close (with a short, kind rationale)

- **#146 — bundle ElasticMQ** — already `wontfix`; out of scope (keep the plugin thin). Close.
- **#130 — docker-compose http/https to ElasticMQ** — config (use `http://…:9324`, not implicit https). Answer & close.
- **#156 — subscribe offline SQS to offline SNS** — cross-plugin orchestration, out of scope. Close with pointer.
- **#195 — `variablesResolutionMode: 20210326`** — Serverless v2-era resolver flag; obsolete under v3/v4. Close as stale.
- **#222 — locally skip a plugin** — low value; documented answer is "don't list the plugin for that run". Close.
- **#239 — lift + localstack guide** — a community HOWTO, not a bug; the modification it required (`queueName`
  override) already shipped as #211. Thank, optionally fold into docs, close.
- **#184 — Dynalite** — Dynalite doesn't implement DynamoDB Streams; not fixable here. Recommend DynamoDB-Local/LocalStack, close.
- **#259 — serverless runs forever** — reporter's plugin list contains *none* of ours; not this repo. Close/redirect.
- **#254 — still maintained?** — answer "yes — v4 support is landing now", link the branch/PR, close.
- **#105 / #152 — ssm-provider docs questions** — answer if quick, but note ssm-provider source isn't in this
  monorepo; verify ownership. Close as docs/support.

---

## Suggested execution order (when we leave read-only)

1. **Publish the v4 versions.** Immediately reply+close the ✅ bucket (`#263, #232, #182, #219, #165, #145, #169`),
   and verify-then-close `#226, #250, #197`. Biggest, cheapest win.
2. **Quick-bug PR** (one branch): `#225`, `#159`, `#158`, `#200`/`#262`, `#241`, `#103`, `#160`. All small,
   current-code, low-risk, well-scoped.
3. **DLQ/autoCreate feature** (`#65/#133/#167/#87`, owning PR #183's idea).
4. **Investigation harnesses** for clusters A and B on the v4 base; re-bucket their issues from real repros.
5. **aws-sdk v3 epic** (`#248/#252/#260`) as the next milestone.
6. **Close the 🗑️ bucket** with rationale; convert `#239` to docs if useful.

> Net of 65 open issues: **~10 close on release**, **~10 real small bugs**, **~9 keep (features/Tier-2)**,
> **~24 need a repro (2 clusters + edge cases)**, **~12 ditch**. Counts overlap where issues are duplicates.
</content>
</invoke>
