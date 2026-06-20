const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

// SSM variable resolution happens at config-parse time, BEFORE `serverless-offline` starts and
// with no lambda events — so the event-driven `runOfflineTest` harness does not apply here.
// We drive `sls print` (osls) directly and assert on its rendered config.
//
// "No AWS call was made" is proven structurally, not by mocking the SDK:
//   1. We run under a HOSTILE environment — no credentials, EC2 instance-metadata disabled,
//      shared-credentials/config files pointed at /dev/null. Any real SSM `getParameter` would
//      fail with "AWS provider credentials not found".
//   2. The MAIN config (all keys present in the local map) resolves cleanly under that env =>
//      the values came from the local map, not AWS.
//   3. A CONTROL config referencing a key ABSENT from the map is run under the SAME env and MUST
//      fail with the AWS-credentials error — proving the no-AWS guard is real, not vacuous (the
//      plugin genuinely falls through to AWS on a miss; we are not silently nulling everything).

const SLS = path.join(__dirname, '..', '..', 'node_modules', 'serverless', 'bin', 'serverless.js');
const STAGE = 'offline';

// Strip every AWS credential/region discovery channel so a real getParameter cannot succeed.
const HOSTILE_ENV = {
  ...process.env,
  AWS_ACCESS_KEY_ID: '',
  AWS_SECRET_ACCESS_KEY: '',
  AWS_SESSION_TOKEN: '',
  AWS_PROFILE: '',
  AWS_SDK_LOAD_CONFIG: '0',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_CONFIG_FILE: '/dev/null'
};
delete HOSTILE_ENV.AWS_ACCESS_KEY_ID;
delete HOSTILE_ENV.AWS_SECRET_ACCESS_KEY;
delete HOSTILE_ENV.AWS_SESSION_TOKEN;
delete HOSTILE_ENV.AWS_PROFILE;

const slsPrint = config => {
  const {stdout, stderr, status, error} = spawnSync(
    process.execPath,
    [SLS, 'print', '--config', config, '--stage', STAGE],
    {cwd: __dirname, env: HOSTILE_ENV, encoding: 'utf8'}
  );
  if (error) throw error;
  return {out: `${stdout || ''}${stderr || ''}`, status};
};

const failures = [];
const check = (label, condition) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.error(`  FAIL ${label}`);
    failures.push(label);
  }
};

// --- 1. MAIN run: every key is in the local map; must resolve under the hostile env ----------
console.log('[test-ssm] MAIN run (serverless.ssm.yml) under no-AWS env');
const main = slsPrint('serverless.ssm.yml');

// Resolution must NOT have errored / reached AWS / collided with the built-in source name.
check('no "Cannot resolve variable"', !/Cannot resolve variable/.test(main.out));
check(
  'no AWS credentials error (=> no AWS call made)',
  !/credentials not found|AWS_CREDENTIALS_NOT_FOUND/.test(main.out)
);
check(
  'no DUPLICATE_VARIABLE_SOURCE_CONFIGURATION',
  !/DUPLICATE_VARIABLE_SOURCE_CONFIGURATION/.test(main.out)
);
check('no "Unexpected parameter type"', !/Unexpected parameter type/.test(main.out));
check(
  'plugin patched for offline stage (notice printed)',
  /resolving ssm locally for offline stage/.test(main.out)
);

// String: ssm:/it/plain -> the local literal, in provider.environment AND function.environment.
check('String ssm /it/plain -> "hello-world"', /PLAIN:\s*hello-world/.test(main.out));
check('String resolved in custom.resolved.plain', /plain:\s*hello-world/.test(main.out));

// StringList: ssm:/it/list -> array (built-in split on ',').
check(
  'StringList ssm /it/list -> [a, b, c]',
  /list:\s*\n\s*-\s*a\s*\n\s*-\s*b\s*\n\s*-\s*c/.test(main.out)
);

// SecureString: ssm:/it/json -> parsed object (built-in JSON.parse).
check(
  'SecureString ssm /it/json -> object {type: service_account, ok: true}',
  /json:\s*\n\s*type:\s*service_account\s*\n\s*ok:\s*true/.test(main.out)
);

// --- 2. CONTROL run: a key ABSENT from the map MUST fall through to AWS and fail (no creds) ----
// This makes the "no AWS call" assertion non-vacuous: it proves the env truly blocks AWS, so the
// MAIN run succeeding can only mean the values came from the local map.
console.log('[test-ssm] CONTROL run (unmapped key) under the SAME no-AWS env');
// The control config must live in __dirname so its relative plugin path (`../../packages/...`)
// resolves exactly like the main config; a unique name avoids colliding with the suite.
const controlName = `serverless.ssm.control.${process.pid}.yml`;
const controlYml = path.join(__dirname, controlName);
fs.writeFileSync(
  controlYml,
  [
    'service: ssm-control',
    'provider:',
    '  name: aws',
    '  region: eu-west-1',
    '  runtime: nodejs22.x',
    '  stage: offline',
    'plugins:',
    '  - ../../packages/serverless-offline-ssm-provider',
    'custom:',
    '  serverless-offline-ssm:',
    '    stages: [offline]',
    '    ssm:',
    '      /it/present: yes',
    '  resolved:',
    // The SSM reference is assembled so the literal token does not appear in source (keeps the
    // `no-template-curly-in-string` lint clean); the written YAML still reads `${ssm:/...}`.
    `    missing: \${ssm:/it/key-that-is-not-in-the-map}`,
    ''
  ].join('\n')
);
try {
  const control = slsPrint(controlName);
  check(
    'unmapped key falls through to AWS and fails (no-creds env truly blocks AWS)',
    /credentials not found|AWS_CREDENTIALS_NOT_FOUND|Cannot resolve variable at "custom\.resolved\.missing"/.test(
      control.out
    )
  );
} finally {
  try {
    fs.unlinkSync(controlYml);
  } catch {
    /* best-effort temp cleanup */
  }
}

// --- verdict ---------------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('[test-ssm] PASS: ssm:/... refs resolved from the local map under osls, no AWS call');
  process.exit(0);
} else {
  console.error(`[test-ssm] FAIL: ${failures.length} assertion(s) failed: ${failures.join(' | ')}`);
  process.exit(1);
}
