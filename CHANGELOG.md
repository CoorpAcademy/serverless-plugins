# Changelog

This repo uses [lerna](https://lerna.js.org/) **independent** versioning; each package is published
on its own version. This file records notable, cross-cutting changes. Per-package version bumps are
in each package's `package.json`.

## 2026-06 — Serverless Framework v4 support

The four `serverless-offline-*` plugins now work on **Serverless Framework v4** while remaining
**fully backward-compatible with v3** (and the maintained [`osls`](https://github.com/oss-serverless/osls)
fork). Peer ranges stay wide (`serverless-offline: >=11`), engines stay `>=18`, and the version bumps
are **minor** — upgrading is transparent for existing consumers.

### `serverless-offline-s3` 7.0.0 → 7.1.0
- **Serverless v4 support:** stop importing the removed `@serverless/utils/log`; take the logger from
  the plugin constructor's 3rd argument (works on v3 and v4) with a console fallback.
- Replace the removed `serverless.cli.log` with the injected logger; fix `log.warn` → `log.warning`.
- Remove dead `_create`/`_s3Event` methods and the orphaned `s3-event-definition.js`.

### `serverless-offline-sqs` 8.0.0 → 8.1.0
- **Serverless v4 support** (as above).
- Fix `awsRegion` on emitted events (`this.region` was undefined). _Re-implements [#166](https://github.com/CoorpAcademy/serverless-plugins/pull/166) — thanks @zlalvani._
- SQS `deleteMessageBatch` entry `Id`s are now unique within a batch (index-based, ≤80 chars). _Re-implements [#253](https://github.com/CoorpAcademy/serverless-plugins/pull/253) — thanks @flipscholtz._
- New `custom.serverless-offline-sqs.queueName` override (non-mutating). _Re-implements [#211](https://github.com/CoorpAcademy/serverless-plugins/pull/211) — thanks @mfamilia._

### `serverless-offline-kinesis` 7.0.0 → 7.1.0
- **Serverless v4 support** (as above); handler errors are now logged instead of silently swallowed.
- Fix `awsRegion` on emitted events. _Re-implements [#166](https://github.com/CoorpAcademy/serverless-plugins/pull/166) — thanks @zlalvani._
- Replace the infinite, silent handler retry with a bounded, logged retry (default
  `maximumRetryAttempts: 10`). _Re-implements [#100](https://github.com/CoorpAcademy/serverless-plugins/pull/100) — thanks @dolsem._
- `await` the Lambda runner's `create(...)`. _Re-implements [#249](https://github.com/CoorpAcademy/serverless-plugins/pull/249) — thanks @gabsong._
- Fix `kinesis-event-definition` omit list (`tableName` → `streamName` copy-paste bug).

### `serverless-offline-dynamodb-streams` 7.0.0 → 7.1.0
- **Serverless v4 support** (as above); handler errors are now logged.
- Fix `awsRegion` on emitted events. _Re-implements [#166](https://github.com/CoorpAcademy/serverless-plugins/pull/166) — thanks @zlalvani._
- Throw a clear `Table <name> does not have streams enabled` error instead of failing cryptically.
  _Re-implements [#98](https://github.com/CoorpAcademy/serverless-plugins/pull/98) — thanks @dolsem._

### Tooling (not published)
- Integration tests rewritten to be robust and version-agnostic (marker-based exact-coverage
  invocation checks; no fixed sleeps; no port races; hard timeouts).
- CI test harness runs on `osls` (the license-free Serverless Framework v3 fork) on **Node 22 & 24**.
  Serverless Framework v4 requires a paid login for CI, so it is not used as the test runner; the
  plugins themselves remain v4-compatible (validated by unit tests and local runs).

### Deferred / follow-ups
- `serverless-offline-eventbridge` (new event-source plugin), local Transcribe & Bedrock emulators,
  and owning the SSM provider — see the internal roadmap.
- autoCreate of a DLQ from a `RedrivePolicy` CloudFormation intrinsic ([#183](https://github.com/CoorpAcademy/serverless-plugins/pull/183) — thanks @JeisonJHA) and the
  `enabled` flag ([#117](https://github.com/CoorpAcademy/serverless-plugins/pull/117)).
</content>
