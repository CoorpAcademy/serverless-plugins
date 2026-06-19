# Publishing & Versioning Guide

This guide covers how the `serverless-plugins` monorepo is versioned, how the packages
are coupled to the Serverless Framework, and how to publish releases. It ends with the
**recommended Serverless v4 migration strategy** that enables v4 while preserving v3
compatibility, plus a **canary-first** publish playbook and the exact commands.

> Source of truth for the facts below: `lerna.json`, root `package.json`, each
> `packages/*/package.json`, `tests/serverless-plugins-integration/package.json`, the
> committed root `package-lock.json`, `.nvmrc`, and the per-package git tags.

---

## 1. TL;DR

- **Tooling:** Lerna 7 (`^7.4.2`) in **independent** versioning mode, on top of
  **npm workspaces** (`packages/*`, `tests/*`). Root is `private: true`.
- **Each package versions on its own cadence.** Never assume two packages share a version.
- **Plugins do NOT depend on `serverless` directly.** The Serverless major is pulled in
  transitively through `serverless-offline`'s own peer. The only coupling knob in the
  plugins is `peerDependencies.serverless-offline`.
- **Serverless 4 is enabled by allowing `serverless-offline@14`, not by adding a
  `serverless` dependency.** offline 13 peers `serverless ^3`, offline 14 peers
  `serverless 4`.
- **Recommended v4 strategy:** keep the wide peer (`"^10.0.2 || >=11"`), ship a **MINOR**
  bump (not a major) because compatibility is *expanded*, matrix-test both stacks, and
  publish via a **canary dist-tag first**, then promote to `latest`.
- **Publish command:** `npm run publish` (→ `lerna publish`). Canary: `lerna publish --canary` or `lerna publish --dist-tag next`.

---

## 2. Monorepo tooling

### 2.1 Lerna (independent) + npm workspaces

| Setting | Value | Where |
|---|---|---|
| Lerna version | `^7.4.2` | root `package.json:24` |
| `packages` glob | `["packages/*", "tests/*"]` | `lerna.json:2` |
| Versioning mode | `"version": "independent"` | `lerna.json:3` |
| Publish commit message | `"New release :zap:"` | `lerna.json:10` |
| Workspaces | `["packages/*", "tests/*"]` | `package.json:7-10` |
| Root visibility | `"private": true` | `package.json:3` |

**Independent mode** means every package has its own version line and gets bumped
independently at publish time. This is confirmed by the heterogeneous git tags:
`serverless-offline-sqs@8.0.0` while `serverless-offline-s3@7.0.0`,
`serverless-offline-kinesis@7.0.0`, `dynamodb-streams-readable@3.0.0`, etc.

### 2.2 The dead `bootstrap` block (Lerna 7 no-op)

```jsonc
// lerna.json:4-8 — legacy, DEAD under Lerna 7
"bootstrap": {
  "npmClientArgs": ["--no-package-lock"],
  "hoist": true
}
```

- `lerna bootstrap` was **removed in Lerna v7**. Installs now go entirely through the
  workspace package manager (`npm install`). The `bootstrap` block has **no effect**.
- The `--no-package-lock` intent is **contradicted by reality**: a ~1.08 MB
  `package-lock.json` **is committed at the repo root**. The project relies on this root
  lockfile.
- **Action item (pre-v4-release housekeeping):** either delete the dead `bootstrap`
  block from `lerna.json`, or formally accept the committed root `package-lock.json` as
  the source of truth (recommended). Do not leave the config and reality contradicting
  each other.

### 2.3 Hoisting & the workspace-linked internal dependency

- Workspaces hoist shared deps (lodash, aws-sdk, etc.) to the root `node_modules`.
- The one **internal** dependency is `dynamodb-streams-readable`, consumed by
  `serverless-offline-dynamodb-streams` (declared `"^3.0.0"`,
  `packages/serverless-offline-dynamodb-streams/package.json:30`).
  - **Locally** it resolves to a symlink:
    `node_modules/dynamodb-streams-readable → packages/dynamodb-streams-readable` (the
    in-repo `3.0.0`).
  - **At publish time** consumers get the **npm-published** `^3.0.0`.
  - **Publish-order consequence:** if you change `dynamodb-streams-readable` AND
    `serverless-offline-dynamodb-streams` in the same release, publish (or bump) the
    readable **first** so the dependent picks up a real published version.

---

## 3. Current package versions

State on disk at HEAD `640b2db` ("New release :zap:") — the **last v3-compatible
release**.

| Package | Version | Type | Path |
|---|---|---|---|
| `serverless-offline-s3` | **7.0.0** | public plugin | `packages/serverless-offline-s3/package.json:3` |
| `serverless-offline-sqs` | **8.0.0** | public plugin | `packages/serverless-offline-sqs/package.json:3` |
| `serverless-offline-kinesis` | **7.0.0** | public plugin | `packages/serverless-offline-kinesis/package.json:3` |
| `serverless-offline-dynamodb-streams` | **7.0.0** | public plugin | `packages/serverless-offline-dynamodb-streams/package.json:3` |
| `dynamodb-streams-readable` | **3.0.0** | public lib | `packages/dynamodb-streams-readable/package.json:3` |
| `serverless-apigateway-access-logs` | **2.0.0** | public plugin (deploy-time) | `packages/serverless-apigateway-access-logs/package.json:4` |
| `serverless-offline-plugins-integration` | **4.0.0** | **private** test harness | `tests/serverless-plugins-integration/package.json:4` |
| `serverless-offline-ssm-provider` | — | **stub** (README only, **no package.json**) | `packages/serverless-offline-ssm-provider/` |

Notes:
- **SQS is one major ahead** of the other three stream/object plugins (8.x vs 7.x). The
  versions are genuinely independent.
- `serverless-offline-ssm-provider` is listed in the root README but currently holds only
  a `README.md` (no `package.json`). It has **historical npm tags** up to
  `serverless-offline-ssm-provider@3.0.0`, but as committed it is **not buildable or
  publishable** — Lerna will skip it because it has no manifest. Treat it as deprecated /
  out-of-tree until a `package.json` is restored.
- **Branch caveat:** the working branch is `feat/serverless-v4-support`, but **HEAD still
  points at `640b2db`** — no v4 changes are committed yet. The `s3 → 8.0.0` /
  `sqs → 9.0.0` bumps exist only on the unrelated `agnusha-master` branch and are not part
  of this line of work.

---

## 4. The serverless ↔ serverless-offline coupling (read this before touching peers)

This is the single most important concept for releasing these plugins.

### 4.1 The plugins do not depend on `serverless`

- **None** of the four offline plugins declare a `serverless` dependency.
- They each declare the **same wide peer**:

  ```jsonc
  "peerDependencies": { "serverless-offline": "^10.0.2 || >=11" }
  ```

  - `serverless-offline-s3/package.json:30`
  - `serverless-offline-sqs/package.json:30`
  - `serverless-offline-kinesis/package.json:30`
  - `serverless-offline-dynamodb-streams/package.json:26`

- Each dev-depends on `serverless-offline: "^13"` for local development
  (s3/sqs/kinesis line 38–39, dynamodb line 34).
- Only the **root** (`package.json:25`, `serverless: ^3.36.0`) and the **integration
  workspace** (`tests/serverless-plugins-integration/package.json`, `serverless ^3.36.0`
  + `serverless-offline ^13`) pin `serverless` at all.

### 4.2 How the Serverless major actually flows in

```
plugin  ──peer──▶  serverless-offline  ──peer──▶  serverless
                       (13)                          (^3.2.0)     ← v3 stack
                       (14)                          (4.x)        ← v4 stack
```

Confirmed from the committed lockfile: `serverless-offline@13.2.0` declares
`peerDependencies: { "serverless": "^3.2.0" }`, `engines: { "node": ">=18.12.0" }`, and
resolved `serverless@3.36.0`.

**Therefore: enabling Serverless 4 = allowing `serverless-offline@14` to satisfy the
plugin's peer. You do NOT add a `serverless` dependency to the plugins.** The current
wide peer `">=11"` already admits 13 **and 14**, so technically no peer edit is even
required to *permit* v4 — the real work is making the source compatible with v4 + offline 14
(see the v4 source-break notes in the architecture docs) and proving it via tests.

### 4.3 Why you must NOT add a direct `serverless@^4` dep

Adding `serverless` (any version) to a plugin would force that major on **every**
consumer and instantly break the other stack's users. Always let `serverless-offline`'s
own peer resolve the Serverless major.

---

## 5. Node engines & `.nvmrc`

| Item | Value | Where |
|---|---|---|
| All package.json `engines.node` | `">=18"` | root + all 7 package manifests |
| `.nvmrc` | `v18.18.2` | repo root |
| CI Node matrix (Travis) | **20 and 18**, `dist: jammy` | `.travis.yml` |

Caveats:
- `>=18` is **looser** than `serverless-offline@13`'s own `>=18.12.0`.
- Serverless 4 / serverless-offline 14 push the real floor higher (toward node 18.20 /
  20). `.nvmrc` (`v18.18.2`) is **below** offline 13's stated `>=18.12.0` floor only
  marginally (18.18 > 18.12, so it's fine today) but is too low for the v4 toolchain.
- **v4 action item:** bump `engines.node` to `>=18.20` (ideally `>=20`) across all
  manifests, bump `.nvmrc` to a matching version, and confirm the Travis matrix.

---

## 6. aws-sdk surface (separate from v4 work)

aws-sdk **v2** (`^2.1234.0`) is declared by s3, sqs, kinesis, dynamodb-streams,
apigateway-access-logs, and the integration workspace. Two of these are **dead deps**:

| Package | Declares `aws-sdk` | Actually uses | Verdict |
|---|---|---|---|
| `serverless-offline-s3` | yes (`package.json:33`) | **minio** (`src/s3.js:1`), not aws-sdk | **unused — drop it** |
| `serverless-apigateway-access-logs` | yes (`package.json:23`) | only `lodash/fp` + provider hooks | **unused — drop it** |

- Dropping these two unused `aws-sdk` deps is a **low-risk patch/minor** and is
  **independent** of the v4 migration.
- A real aws-sdk **v2 → v3** migration changes client constructor shapes (documented in
  the package READMEs) and **is breaking** — keep it as its **own MAJOR** bump, not
  entangled with the (compatible) v4-enabling minor.

---

## 7. Recommended v4 migration: version & peer strategy (preserve v3)

Goal: a **single published artifact per plugin** that works on **both** Serverless 3
(via offline 13) **and** Serverless 4 (via offline 14).

### 7.1 Peer policy — widen, don't narrow

| Option | Peer value | When |
|---|---|---|
| **Recommended (compat-preserving)** | leave `"^10.0.2 || >=11"` as-is | one artifact serves both v3 (offline 13) and v4 (offline 14). The plugins are agnostic to the Serverless major. |
| Explicit / safe | `">=13"` or `"^13 || ^14"` | only if you **intend to drop** support for offline < 13. This narrows compatibility — treat as a breaking (major) change. |

- The current `">=11"` already admits 14, so the **default recommendation is to not
  touch the peer at all** and rely on tests to prove v4 works.
- **Do NOT add `serverless@^4`** to any plugin (see §4.3).

### 7.2 Semver — ship MINOR, not MAJOR

Because the v4 work **expands** compatibility (more allowed versions, no removed public
API, no removed supported-version floor), each plugin should take a **minor** bump:

| Package | From | To (recommended) |
|---|---|---|
| `serverless-offline-s3` | 7.0.0 | **7.1.0** |
| `serverless-offline-sqs` | 8.0.0 | **8.1.0** |
| `serverless-offline-kinesis` | 7.0.0 | **7.1.0** |
| `serverless-offline-dynamodb-streams` | 7.0.0 | **7.1.0** |

> If the v4 source migration also removes support for offline < 13 (narrowed peer in
> §7.1), that **is** breaking → take a **major** bump instead and document the dropped
> versions in the changelog.

Keep separate, independently-versioned bumps for the other concerns:
- **Drop unused `aws-sdk`** from s3 / apigateway → patch or minor (independent).
- **aws-sdk v2 → v3** → its own **major** (independent), later.
- **engines/.nvmrc bump** → fold into the same minor as the v4 work.

### 7.3 Integration workspace must matrix both stacks

`tests/serverless-plugins-integration/package.json` currently pins `serverless ^3.36`
+ `serverless-offline ^13` (single stack). Before publishing the v4-enabling minor, the
harness must **prove the wide peer on both majors**:

- Add (or matrix) a `serverless ^4` + `serverless-offline ^14` configuration alongside
  the existing v3 one.
- **Under Serverless v4, `sls offline start` requires `SERVERLESS_ACCESS_KEY` in the
  environment** (a license/access key). Every integration `test-*.js` spawns
  `sls offline start`; without the key the child exits before printing the
  "Starting Offline …" banner, producers never fire, and the harness hangs (these
  scripts have no timeout). Export `SERVERLESS_ACCESS_KEY` in CI/local before running v4
  integration tests.

---

## 8. Pre-publish checklist

Run from the repo root, on a clean tree, on the intended Node version (`nvm use`).

1. **Sync deps & lockfile:** `npm install` (regenerates the root `package-lock.json` to
   latest in-range versions; this also moots within-range dependabot bumps).
2. **Lint (the only docker-free gate):** `npm run eslint`
3. **Unit tests (needs docker):** `npm run test:unit`
   - Brings up `docker-compose.yml` services; the lone AVA suite
     (`dynamodb-streams-readable/test/index.js`) hits dynamodb-local at
     `http://localhost:8000`. **Not** docker-free despite the "unit" name.
4. **Integration tests (needs docker; needs `SERVERLESS_ACCESS_KEY` on v4):**
   `npm run test:integration`
5. **Full chain (what CI runs):** `npm test` → eslint → unit → integration.
6. **npm auth:** ensure you are logged in (`npm whoami`) with publish rights and 2FA/OTP
   ready (publishing is a manual laptop operation — there is **no** `.github/`, `.npmrc`,
   or semantic-release in the repo).
7. **Housekeeping (recommended before the v4 release):** resolve the
   `lerna.json` `bootstrap` / committed-lockfile contradiction (§2.2); drop the unused
   `aws-sdk` deps (§6); bump `engines`/`.nvmrc` (§5).

---

## 9. Publish commands

Publishing is **manual**. Lerna independent mode prompts per-package version bumps,
commits with `"New release :zap:"` (`lerna.json:10`), tags each changed package
`pkg@x.y.z`, and pushes to npm.

### 9.1 Standard release (promote to `latest`)

```bash
# from repo root, clean tree, correct node
nvm use                # honors .nvmrc
npm install            # sync workspaces + lockfile
npm test               # eslint + unit + integration (docker required)

npm run publish        # === lerna publish ===  (interactive per-package bumps)
```

`npm run publish` maps to `lerna publish` (`package.json:21`).

### 9.2 Canary-first (recommended for the v4 migration)

Publish a pre-release to a **non-`latest` dist-tag** first so existing v3 users are never
served the v4-enabling build until it is validated, then promote.

**Option A — Lerna canary (auto-generated `x.y.z-alpha.N+sha` versions):**

```bash
# publishes from the current commit under the "canary" dist-tag by default
lerna publish --canary --preid alpha
# or pick the bump level explicitly:
lerna publish --canary preminor --preid alpha
```

**Option B — explicit prerelease under a named dist-tag (`next`):**

```bash
# create prerelease versions (e.g. 7.1.0-next.0) without publishing yet
lerna version prerelease --preid next
# publish those versions under the "next" tag (NOT latest)
lerna publish from-package --dist-tag next
```

**Validate the canary** in a throwaway consumer against BOTH stacks:

```bash
# v3 stack
npm i serverless@3 serverless-offline@13 serverless-offline-sqs@next
# v4 stack (needs a license key)
SERVERLESS_ACCESS_KEY=... npm i serverless@4 serverless-offline@14 serverless-offline-sqs@next
```

**Promote the validated prerelease to `latest`** (no rebuild — just move the tag, or cut
the final version):

```bash
# move an existing prerelease build to latest:
npm dist-tag add serverless-offline-sqs@8.1.0-next.0 latest
# OR cut the final, clean version:
lerna version minor          # 8.1.0-next.0 -> 8.1.0 etc.
lerna publish from-package   # publishes to latest
```

### 9.3 Useful flags / recovery

| Goal | Command |
|---|---|
| Re-publish versions already bumped (e.g. after a failed network push) | `lerna publish from-package` |
| Re-publish from existing git tags | `lerna publish from-git` |
| Force-include a package Lerna thinks is unchanged | `lerna publish --force-publish=serverless-offline-sqs` |
| Dry-run the version plan | `lerna version --no-git-tag-version --no-push` (inspect, then discard) |

---

## 10. Gotchas (quick reference)

- **`lerna.json` `bootstrap` block is dead** under Lerna 7; `--no-package-lock` is a
  no-op and is **contradicted** by the committed ~1.08 MB root `package-lock.json`.
- **Independent versions:** a single `lerna publish` can bump different packages to
  different versions. SQS is already a major ahead (8.x vs 7.x). Never assume parity.
- **Enabling v4 = allowing `serverless-offline@14`**, NOT adding a `serverless` dep. The
  plugins never depend on `serverless` directly; offline 13 peers `serverless ^3.2.0`,
  offline 14 peers `serverless 4`.
- **Wide peer, minor bump.** Keep `"^10.0.2 || >=11"` and ship a minor — the v4 work
  *expands* compatibility. Narrowing the peer (dropping offline < 13) would be breaking.
- **Unused `aws-sdk`** in `serverless-offline-s3` (uses minio) and
  `serverless-apigateway-access-logs` (uses only lodash/fp + provider hooks) — drop them;
  they are **not** part of the aws-sdk v3 migration surface.
- **aws-sdk v2 → v3 is its own MAJOR** — keep it out of the v4-enabling minor.
- **`engines.node` `>=18` and `.nvmrc` `v18.18.2`** are tight for the v4 toolchain; bump
  toward 18.20 / 20.
- **`serverless-offline-ssm-provider`** has historical npm tags up to 3.0.0 but **no
  package.json on disk** — Lerna will skip it; it is not currently publishable.
- **Internal dep publish order:** publish/bump `dynamodb-streams-readable` before
  `serverless-offline-dynamodb-streams` (the dependent consumes the published `^3.0.0`,
  not the workspace symlink, once shipped).
- **v4 integration tests need `SERVERLESS_ACCESS_KEY`** or the spawned `sls offline
  start` exits before the banner and the harness hangs indefinitely (no timeouts).
- **Publishing is fully manual** — no `.github/`, no `.npmrc`, no semantic-release; 2FA /
  `NPM_TOKEN` handling is implicit and developer-laptop-driven.
