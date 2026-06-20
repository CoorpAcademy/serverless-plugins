const {spawn} = require('child_process');

const delay = duration =>
  new Promise(resolve => {
    setTimeout(resolve, duration);
  });

// Lambda invocations are detected from the handler's own marker (see lambda/handler.js):
//   __INVOKED__ <functionName> <source> <recordCount>
// NOT serverless-offline's log format — that is version-dependent and unreliable. <source> is stable
// per (handler, source) so retries/split deliveries dedupe; <recordCount> enables batch assertions.
const INVOKED = /__INVOKED__ (\S+) (\S+)(?: (\d+))?/;

// When forbiddenKeys are set, wait this long after full coverage before declaring success, so a
// stray forbidden notification (which arrives out of order) can still surface and fail the test.
const FORBIDDEN_DRAIN_MS = 2000;

/**
 * Spawn `sls offline` and drive a robust integration test:
 *  - merges stdout+stderr so the readiness banner and handler output are both seen,
 *  - waits for readiness, then runs `onReady` (send the events) — a rejection fails fast,
 *  - asserts EXACT COVERAGE: succeeds only once every `expectedKeys` "<fn> <source>" marker has
 *    fired (a count threshold could let surplus markers mask a handler that never fired) AND every
 *    `expectBatch` entry has been delivered in a single invocation of at least N records,
 *  - hard-fails if any `forbiddenKeys` marker appears (e.g. an S3 prefix/suffix rule over-matching),
 *  - always exits: success on full coverage, failure on a forbidden key, onReady error, early exit,
 *    or timeout.
 *
 * @param {string[]} expectedKeys exact "<functionName> <source>" markers that must all fire.
 * @param {string[]} [forbiddenKeys] markers that must NOT fire.
 * @param {Object<string,number>} [expectBatch] map of expected key -> min records in one invocation.
 */
const runOfflineTest = ({
  config,
  expectedKeys,
  forbiddenKeys = [],
  expectBatch = {},
  onReady,
  readyPattern,
  timeout = 120000,
  label
}) => {
  const name = label || config;
  const expected = new Set(expectedKeys);
  const forbidden = new Set(forbiddenKeys);
  const seen = new Set();
  const maxRecords = {};
  let started = false;
  let settled = false;
  let draining = false;

  // detached so the child is its own process-group leader: killing -pid tears down sls AND the
  // lambda/http servers it spawns, releasing their ports before the next test in the suite starts.
  const serverless = spawn('sh', ['-c', `exec sls offline start --config ${config} 2>&1`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: __dirname,
    detached: true
  });

  const killGroup = () => {
    try {
      process.kill(-serverless.pid);
    } catch (err) {
      serverless.kill();
    }
  };

  const finish = (code, reason) => {
    if (settled) return;
    settled = true;
    killGroup();
    const missing = expectedKeys.filter(k => !seen.has(k));
    const detail = code === 0 || missing.length === 0 ? '' : ` — missing: ${missing.join(', ')}`;
    const line = `[${name}] ${reason} (${seen.size}/${expected.size} expected invocations)${detail}`;
    if (code === 0) console.log(line);
    else console.error(line);
    process.exit(code); // terminates immediately, so the pending timeout needs no clearing
  };

  setTimeout(() => finish(1, `TIMED OUT after ${timeout}ms`), timeout);

  const coverageComplete = () =>
    expectedKeys.every(k => seen.has(k)) &&
    Object.entries(expectBatch).every(([k, min]) => (maxRecords[k] || 0) >= min);

  const maybeFinish = () => {
    if (!coverageComplete()) return;
    if (forbiddenKeys.length === 0) return finish(0, 'all expected invocations covered');
    // Coverage is met but a forbidden notification may still be in flight — drain, then succeed.
    if (draining) return;
    draining = true;
    setTimeout(() => finish(0, 'all expected invocations covered'), FORBIDDEN_DRAIN_MS);
  };

  const ready = readyPattern || /Offline \[http for lambda\] listening|Starting Offline/;

  const handleLine = line => {
    process.stdout.write(`[sls] ${line}\n`);

    if (!started && ready.test(line)) {
      started = true;
      Promise.resolve()
        .then(onReady)
        .catch(err => finish(1, `onReady failed: ${err && err.message}`));
    }

    const match = INVOKED.exec(line);
    if (match) {
      const key = `${match[1]} ${match[2]}`;
      const records = match[3] ? Number(match[3]) : 1;
      if (forbidden.has(key)) return finish(1, `forbidden invocation: ${key}`);
      if (!expected.has(key)) console.error(`[${name}] unexpected invocation (ignored): ${key}`);
      seen.add(key);
      maxRecords[key] = Math.max(maxRecords[key] || 0, records);
      maybeFinish();
    }
  };

  let pending = '';
  serverless.stdout.on('data', data => {
    pending += data.toString();
    const lines = pending.split('\n');
    pending = lines.pop();
    lines.forEach(handleLine);
  });

  serverless.on('close', code => finish(code || 1, `serverless exited (code ${code})`));

  return serverless;
};

module.exports = {delay, runOfflineTest};
