# serverless-offline-ssm-provider

Resolve `${ssm:/path}` variables from a **local map** during your configured offline stages,
with **zero AWS round-trips**. Real deploys (non-offline stages) are left completely untouched.

This is a first-party, maintained replacement for
[`janders223/serverless-offline-ssm`](https://github.com/janders223/serverless-offline-ssm).
Migration is a one-line dependency swap — see [Migration](#migration-from-serverless-offline-ssm).

## How it works

During a configured offline stage the plugin monkeypatches the `aws` provider's `request` method
and intercepts only `('SSM', 'getParameter', {Name})` calls. When the requested `Name` is found in
your local map, it returns a synthetic `{Parameter: {Value, Type}}` response and the **built-in
Serverless `ssm` resolver** does all the downstream `String` / `StringList` / `SecureString` /
`~raw` / `~noDecrypt` handling for free. Every other AWS call (CloudFormation, S3, deploy, etc.) is
passed straight through to the real provider.

> Note: the plugin does **not** register a `configurationVariablesSources.ssm` source. Under an
> `aws` provider the framework already reserves the `ssm` source name, and declaring it again throws
> `DUPLICATE_VARIABLE_SOURCE_CONFIGURATION`. Patching the provider request is the supported mechanism
> and keeps the existing `${ssm:...}` contract intact.

## Installation

```sh
npm install --save-dev serverless-offline-ssm-provider
```

Add the plugin to your `serverless.yml` **before** `serverless-offline`:

```yml
plugins:
  - serverless-offline-ssm-provider
  - serverless-offline
```

## Configure (#105)

Declare the offline stages and the local SSM map under `custom.serverless-offline-ssm`
(note: the key is `serverless-offline-ssm`, **not** `-ssm-provider`):

```yml
custom:
  serverless-offline-ssm:
    stages:
      - offline
      - dev
      - test
    ssm:
      /credentials/dev/bedrock-model-id: anthropic.claude-3            # -> String
      /api/v1/some-flag: 'a,b,c'                                       # -> StringList
      /credentials/dev/google-credentials: '{"type":"service_account"}' # -> SecureString (parsed)

functions:
  echo:
    handler: handler.promise
    environment:
      MODEL: ${ssm:/credentials/dev/bedrock-model-id}
```

You can also override the stages from the CLI (parity with `serverless-offline-ssm`):

```sh
sls offline --ssmOfflineStages dev,test,offline
```

If neither `custom.serverless-offline-ssm.stages` nor `--ssmOfflineStages` is set, the plugin
fails fast with a clear error.

## Precedence (#152)

The local map is an **override layer**, not a sandbox wall:

| Situation                          | Resolution                          |
| ---------------------------------- | ----------------------------------- |
| offline stage + key **present**    | local map value (no AWS call)       |
| offline stage + key **absent**     | falls through to **real AWS SSM**   |
| non-offline stage (e.g. `prod`)    | never patched — real AWS for everything |

Falling through on a miss means a typo'd path surfaces as a real SSM error instead of being
silently nulled, matching real-deploy behavior.

## Parameter types (#186)

The synthetic response always carries a valid `Type`, so the built-in resolver never throws
`Unexpected parameter type`. The `Type` is inferred from the map value:

| Map value                                   | Inferred `Type` | Resolved as                         |
| ------------------------------------------- | --------------- | ----------------------------------- |
| plain scalar (`anthropic.claude-3`)         | `String`        | literal string                      |
| array (`['a','b','c']`) or CSV (`'a,b,c'`)  | `StringList`    | array (built-in splits on `,`)      |
| `{`-prefixed JSON string                    | `SecureString`  | parsed object (built-in `JSON.parse`) |

The `~raw` and `~noDecrypt` modifiers (`${ssm:/p~raw}`) work out of the box — they are honored by
the built-in resolver on the `Type`/`Value` the plugin provides.

### Forcing a type (override)

Inference is best-effort and explicitly overridable with a per-value `{value, type}` object — for
example to keep a JSON-looking string as a literal `String`:

```yml
custom:
  serverless-offline-ssm:
    stages: [dev]
    ssm:
      /raw/json-literal:
        value: '{"a":1}'
        type: String   # keep it a literal string, do not JSON.parse
```

## Migration from `serverless-offline-ssm`

1. Replace the dependency:

   ```diff
   - "serverless-offline-ssm": "^6.2.0"
   + "serverless-offline-ssm-provider": "^1.0.0"
   ```

2. Add `serverless-offline-ssm-provider` to `plugins` **before** `serverless-offline`.
3. Keep your existing `custom.serverless-offline-ssm` block **unchanged** — the config key and
   `{stages, ssm}` shape are identical by design.
