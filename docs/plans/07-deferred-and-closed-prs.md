# TODO — deferred & closed PRs (rationale)

> **Goal:** `[[00-goal]]` · Companion to `[[open-pr-triage]]`. Documents what we deliberately did NOT ship now.

## Deferred (keep OPEN, comment with a plan) — high value, needs integration to verify safely

### #183 — autocreate DLQ from `RedrivePolicy` (JeisonJHA)
- **Value:** real feature. Also exposes a live bug: `_createQueue` blindly `JSON.stringify`s ALL queue
  properties, including CloudFormation intrinsics (`Fn::GetAtt`, `Ref`) — these get sent to ElasticMQ as garbage.
- **Why deferred:** correct DLQ autocreation + intrinsic resolution must be validated against the Docker SQS
  emulator (ElasticMQ) and ideally serverless v4. We can't run that lane reliably from here; shipping it
  unverified risks breaking `autoCreate`.
- **Follow-up plan (Tier-2 PR):** (1) add a pure `resolveQueueProperties(props, resources, options)` that drops/
  resolves intrinsics; (2) create the DLQ before the main queue when `RedrivePolicy.deadLetterTargetArn` is a
  `Fn::GetAtt`; (3) unit-test the resolver; (4) extend `tests/serverless-plugins-integration` + run with Docker.

### #168 — start non-SQS lambdas / default host to localhost (russellpekala)
- **Value:** partial. The useful bit is defaulting `options.host` to `localhost`; the rest changes when the
  Lambda runner starts.
- **Why deferred:** behavior change to the start path; needs integration validation to avoid regressions.
- **Follow-up:** evaluate the host default in isolation with a Docker run; adopt only the safe part.

## Closed (recommend) — low value / dead / superseded

| PR | Author | Reason to close |
|---|---|---|
| #99 | dolsem | Logging function errors — **superseded** by threading the real `{log}` into kinesis/dynamodb (this PR). |
| #117 | fernyettheplant | `enabled` flag — targets removed architecture; fix would now live in the event-definition classes; low value. |
| #137 | umairnadeem | Avoid waiting for termination — references removed `_startWithExplicitEnd`; intent unclear; risks shutdown. |
| #234 | dependabot | `qs`/`formidable` bump — transitive dev dep, **mooted** by lockfile regen. |
| #240 | dependabot | `json5` bump — mooted by lockfile regen (already conflicting). |
| #243 | dependabot | `cookiejar` bump — mooted by lockfile regen. |
| #244 | dependabot | `simple-git` bump — mooted by lockfile regen (already conflicting). |
| #246 | dependabot | `http-cache-semantics` bump — mooted by lockfile regen. |

> ⚠️ Dependency caution for future bumps (NOT mooted by a regen): `p-queue` v7+ is pure ESM (breaks the
> `require('p-queue').default` in sqs.js); `aws-sdk` v2→v3 is a rewrite. Handle those deliberately, not via dependabot.

## Re-implemented & owned by us (close as done, credit author)
#166 (zlalvani), #253 (flipscholtz), #211 (mfamilia), #98 (dolsem), #100 (dolsem), #249 (gabsong) — shipped in
the v4 PR; close each with a thank-you + link.

## Authorization note
Closing community PRs is outward-facing — **confirm with Silou before executing** the close-list. Posting our
PR and the credits is fine; the bulk-close is the gated step.
</content>
