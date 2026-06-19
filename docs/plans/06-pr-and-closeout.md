# TODO — PR & close-out

> **Owner:** main agent (final phase) · **Goal:** `[[00-goal]]` · **Branch:** `feat/serverless-v4-support`

## Commit strategy (reviewable history, one PR)
Commit per concern so the PR reads commit-by-commit:
1. `docs+tooling: architecture/conventions/testing/publishing docs, skill, agent, gitignore`
2. `feat(s3): serverless v4 logger support + remove dead code`
3. `feat(sqs): serverless v4 + fix awsRegion (#166) + distinct delete ids (#253) + queueName override (#211)`
4. `feat(kinesis): serverless v4 + fix awsRegion (#166) + bounded logged retry (#100) + await create (#249) + event-def fix`
5. `feat(dynamodb-streams): serverless v4 + fix awsRegion (#166) + clear no-streams error (#98)`
6. `test: docker-free unit tests for the four offline plugins`

Each commit message ends with the required `Co-Authored-By` trailer.

## PR
- `gh pr create --base master --head feat/serverless-v4-support` with the description below.
- Title: `feat: Serverless Framework v4 support + plugin hardening (offline s3/sqs/kinesis/dynamodb-streams)`

### PR description skeleton
- **What & why:** v4 removed `@serverless/utils/log` + `serverless.cli.log`; we adopt the injected `{log}` 3rd arg
  (back-compatible to v3). Plus correctness fixes and re-implemented community-PR ideas, owned by us.
- **Changes** (bulleted per package, link the original PRs/authors being credited).
- **Compatibility:** works on serverless v3 **and** v4; peers stay wide; minor version bumps.
- **Testing:** `npm run eslint` ✅; new AVA unit tests ✅; Docker integration + v4 e2e = how to run (not run here) + why.
- **Credits:** "Re-implements ideas from #166 (@zlalvani), #253 (@flipscholtz), #211 (@mfamilia), #98/#100 (@dolsem), #249 (@gabsong)."
- **Follow-ups:** CI v4 matrix; #183 DLQ autocreate; #168 host/start; publish (canary→stable); consumer bumps.

## Close-list (CONFIRM with Silou before executing — closing others' PRs is outward-facing)
Recommend closing with a courteous comment that links this PR and credits the author:
- **Superseded / done by this PR:** #166, #253, #211, #98, #100, #249 → close as "re-implemented in <PR link>, thank you @author".
- **Dead architecture / low value:** #99 (superseded by logger threading), #117, #137 → close with rationale.
- **Dependabot (mooted by lockfile regen):** #234, #240, #243, #244, #246 → close; let dependabot re-open vs the new tree.
- **Deferred (leave OPEN, comment with plan):** #183 (DLQ), #168 (host/start) → see `[[07-deferred-and-closed-prs]]`.

## Final report
- PR link, what shipped, gates run + results, what was deferred and why, the close-list status.
</content>
