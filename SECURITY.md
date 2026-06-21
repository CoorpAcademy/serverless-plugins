# Security Policy

## Supported versions

These packages are **local-development emulator plugins** for the Serverless
framework. They run on a developer's machine against local emulators
(LocalStack, DynamoDB Local, minio, …) and are **not** intended to run as
network-exposed production services.

| Package | Supported |
| ------- | --------- |
| Latest published major of each `packages/*` plugin | ✅ |
| Older majors | Best-effort only |

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
**GitHub Security Advisories** ("Report a vulnerability" on the repository
Security tab) rather than opening a public issue. We aim to acknowledge within
a few business days.

## Dependency triage

The repository's Dependabot dashboard lists alerts that are almost entirely
**dev- and release-tooling only**. We trace every alert to its direct
dependency and to whether it is reachable from *published, installed runtime
code*. The methodology: `npm audit` cross-checked with `npm ls <pkg>` to find
the importing chain.

### Key finding: published runtime trees are clean

Every published plugin's runtime (`dependencies`) tree resolves to:
`lodash`, `@aws-sdk/* v3`, `@smithy/node-http-handler`, `figures`, `minio`,
`p-queue`, and internal monorepo packages. **None of these carry an open
advisory.** The alerts on the dashboard come from elsewhere:

| Alert source (direct dep) | Role | Advisories pulled in | Ships to users? |
| ------------------------- | ---- | -------------------- | --------------- |
| `lerna` (root devDep) | Release/version tooling | `tar` (×8), `minimatch` (×3), `@octokit/*` (×3), `sigstore`, `pacote`, `node-gyp`, `js-yaml`, `nx` | ❌ No |
| `nyc` (root devDep) | Coverage | `js-yaml`, `istanbul-lib-processinfo → uuid` | ❌ No |
| `ava` (root devDep) | Test runner | `supertap → js-yaml` | ❌ No |
| `eslint` (root devDep) | Lint | `minimatch`, `js-yaml` | ❌ No |
| `tests/serverless-plugins-integration` | Private integration-test package (`"private": true`) | `aws-sdk@2` (region validation), `uuid` | ❌ No |
| `dynamodb-streams-readable` (devDep) | Dev-only since the v3 migration | `uuid@9` bounds check | ❌ No |

### Reachability verdict

- **High-severity `tar` / `minimatch` / `@octokit` / `sigstore` advisories** are
  pulled exclusively by `lerna` and execute only during `lerna publish` /
  `lerna version` on a **trusted maintainer machine** processing this repo's own
  source. They are **not reachable** by consumers of the published packages and
  **not reachable** by any attacker-controlled input. Practical risk ≈ none.
- **`js-yaml` / `uuid` / `minimatch` from `nyc`/`ava`/`eslint`** run only in the
  local test/lint pipeline. Not shipped.
- **The only runtime-reachable advisory** is `aws-sdk@2` (Low, region-parameter
  validation) pulled by `kinesis-readable@1.2.0`, a runtime dependency of
  `serverless-offline-kinesis`. This is being removed (see the remediation spec).

### Remediation status

Remediation carried out:

1. This document (triage record).
2. `kinesis-readable` (which pulled `aws-sdk@2` — the **only runtime-reachable**
   advisory) replaced by an in-house `@aws-sdk/client-kinesis` v3 reader.
   **The shipped runtime trees are now advisory-free.**
3. `lerna` `7 → 8`, `nyc` `15 → 17`, `ava` `4 → 6`; `uuid` forced to `^11.1.1`;
   integration-test package migrated off `aws-sdk@2` to `@aws-sdk/client-*` v3.

**Why some High advisories remain on the dashboard (and are accepted):** they all
live in `lerna`'s release-tooling tree and currently have **no compatible fix**:

- **`tar`** — every published version (`<= 7.5.15`) is flagged; there is no patched
  release to upgrade to yet.
- **`minimatch`** — cannot be pinned globally: `lerna`'s transpiled code needs the
  CommonJS default export (`minimatch@<=6`), while `glob@10`/`sigstore` need the
  named-export rewrite (`minimatch@>=9`). A single `override` breaks one or the other.

Forcing these via `overrides` was attempted and **breaks `lerna`** (`minimatch@9`
drops the default export → `lerna run`/`publish` crash). Since the code is not in
any shipped or attacker-reachable path, it is documented here and dismissed on the
dashboard rather than force-patched.

Dashboard alerts whose vulnerable code is not in any execution path may be
dismissed with the rationale **"vulnerable code is not in the execution path"**.
