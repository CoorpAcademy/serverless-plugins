# TODO — cross-cutting (peers, CI, root, docs)

> **Owner:** main agent (after the 4 package agents finish) · **Goal:** `[[00-goal]]`
> **Scope:** repo-root files that the per-package agents must NOT touch (avoids parallel-write conflicts).

## Peers & versioning (verify, don't widen by mistake)
- Each package keeps peer `"serverless-offline": "^10.0.2 || >=11"` (already wide → covers v3 *and* v4). ✅ no change.
- Version bumps are **minor** per package (s3 7.1.0, sqs 8.1.0, kinesis 7.1.0, ddb 7.1.0) — done in package docs.
- Confirm each touched `package.json` added `"src/log.js"` to `files`.

## Root `package.json`
- No change required. Root keeps `serverless: ^3.36.0` so the existing Docker integration suite still runs on v3.
- Do **not** bump root serverless to 4 here — that would break the v3 integration lane. v4 is validated per-consumer.

## CI (`.travis.yml`) — **documented follow-up, not in this PR**
- A true v4 lane needs a build matrix that installs `serverless@4` + `serverless-offline@14` in the integration
  workspace alongside the existing v3 lane. That is unverifiable from this environment and risks red CI.
- **Decision:** leave `.travis.yml` as-is (Node 18/20). Record the recommended matrix in `[[testing-and-ci]]`
  and call it out in the PR as a follow-up. Honesty over a green-looking-but-unproven check.

## Root `README.md`
- Optional: add a one-line note that the offline plugins now support Serverless Framework v4 (and remain v3-compatible).
- Keep the badge/table intact.

## Docs / tooling to commit (already authored)
- `docs/architecture.md`, `docs/conventions.md`, `docs/testing-and-ci.md`, `docs/publishing-and-versioning.md`
- `docs/serverless-v4-migration-review.md`, `docs/open-pr-triage.md`, `docs/README.md`, `docs/plans/*`
- `.claude/skills/serverless-plugin-dev/SKILL.md`, `.claude/agents/serverless-plugin-author.md`
- `.gitignore` (ignore `.claude/data/`, `logs/`)

## Gating (whole repo)
- `npm run eslint` green across the repo.
- `npx ava` green (new per-package unit tests + the existing `dynamodb-streams-readable` suite).
- Document what was NOT run (Docker integration, v4 e2e) and why.
</content>
