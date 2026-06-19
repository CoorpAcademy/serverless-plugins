const fs = require('fs');
const path = require('path');

const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const S3Event = require('../src/s3-event');

const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'success'];

test('normalizeLog exposes every log level as a function', t => {
  const log = normalizeLog({});
  LOG_LEVELS.forEach(level => {
    t.is(typeof log[level], 'function', `expected log.${level} to be a function`);
  });
});

test('normalizeLog merges a partial logger and keeps it', t => {
  const notice = () => 'noticed';
  const log = normalizeLog({notice});

  t.is(log.notice, notice);
});

test('normalizeLog falls back to defaults for missing levels', t => {
  const notice = () => 'noticed';
  const log = normalizeLog({notice});

  t.is(log.debug, defaultLog.debug);
  t.is(log.warning, defaultLog.warning);
  t.is(log.error, defaultLog.error);
});

test('normalizeLog(undefined) is safe and returns the defaults', t => {
  const log = normalizeLog(undefined);

  LOG_LEVELS.forEach(level => {
    t.is(typeof log[level], 'function');
  });
  t.is(log.debug, defaultLog.debug);
});

test('normalizeLog(null) is safe', t => {
  const log = normalizeLog(null);

  LOG_LEVELS.forEach(level => {
    t.is(typeof log[level], 'function');
  });
});

test('normalizeLog default debug is a quiet noop', t => {
  t.is(defaultLog.debug(), undefined);
});

test('normalizeLog does not mutate the injected logger', t => {
  const injected = {notice: () => {}};
  normalizeLog(injected);

  t.deepEqual(Object.keys(injected), ['notice']);
});

// A representative Minio notification record — Minio already emits AWS-shaped
// S3 records, so S3Event only has to wrap a single record in `Records`.
const minioRecord = {
  eventVersion: '2.0',
  eventSource: 'aws:s3',
  awsRegion: 'eu-west-1',
  eventTime: '2024-01-01T00:00:00.000Z',
  eventName: 's3:ObjectCreated:Put',
  s3: {
    s3SchemaVersion: '1.0',
    configurationId: 'config',
    bucket: {
      name: 'my-bucket',
      ownerIdentity: {principalId: 'minio'},
      arn: 'arn:aws:s3:::my-bucket'
    },
    object: {
      key: 'path/to/file.txt',
      size: 42,
      eTag: 'abc123',
      sequencer: '0001'
    }
  }
};

test('S3Event wraps a single record into the AWS S3 Lambda event shape', t => {
  const event = new S3Event(minioRecord);

  t.true(Array.isArray(event.Records));
  t.is(event.Records.length, 1);
  t.is(event.Records[0].eventSource, 'aws:s3');
  t.is(event.Records[0].s3.bucket.name, 'my-bucket');
  t.is(event.Records[0].s3.object.key, 'path/to/file.txt');
  t.is(event.Records[0].awsRegion, 'eu-west-1');
});

test('S3Event preserves the original record reference', t => {
  const event = new S3Event(minioRecord);

  t.is(event.Records[0], minioRecord);
});

// Regression guards: the v4 migration must not reintroduce the removed APIs.
const SRC_DIR = path.join(__dirname, '..', 'src');
const readSource = file => fs.readFileSync(path.join(SRC_DIR, file), 'utf8');

test('src/index.js does not use removed Serverless v4 logging APIs', t => {
  const source = readSource('index.js');

  t.false(source.includes('@serverless/utils/log'));
  t.false(source.includes('serverless.cli.log'));
});

test('src/s3.js does not use removed APIs and uses log.warning (not log.warn)', t => {
  const source = readSource('s3.js');

  t.false(source.includes('@serverless/utils/log'));
  t.false(source.includes('serverless.cli.log'));
  t.false(/\blog\.warn\b/.test(source));
  t.true(source.includes('this.log.warning'));
});

test('src/s3.js no longer contains the dead _create / _s3Event methods', t => {
  const source = readSource('s3.js');

  t.false(source.includes('_s3Event'));
  t.false(/_create\s*\(/.test(source));
  t.false(source.includes("require('./s3-event-definition')"));
});

test('src/index.js takes the logger from the 3rd constructor argument', t => {
  const source = readSource('index.js');

  t.true(source.includes('constructor(serverless, cliOptions, {log} = {})'));
  t.true(source.includes('this.log = normalizeLog(log)'));
});
