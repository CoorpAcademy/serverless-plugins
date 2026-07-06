const fs = require('fs');
const net = require('net');
const path = require('path');
const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const {
  numToStr,
  splitWordPunctuation,
  wordToItems,
  whisperJsonToTranscribe,
  countPronunciations
} = require('../src/transcript');
const {
  buildJob,
  completeJob,
  failJob,
  toJobSummary,
  JobRegistry,
  STATUS
} = require('../src/job-registry');
const {
  parseS3Uri,
  resolveOutputKey,
  resolveOutputLocation,
  buildTranscriptFileUri,
  buildS3Config
} = require('../src/s3-io');
const {
  mapLanguageCode,
  buildWhisperArgs,
  whisperOutputPath,
  isWhisperAvailable
} = require('../src/whisper');
const Transcribe = require('../src/transcribe');
const {parseTarget, parseBody} = require('../src/transcribe');
const ServerlessOfflineTranscribe = require('../src');
const {defaultOptions, isPluginEnabled, resolveEndpointUrl} = require('../src');

// The SPIKE 2 fixture — a REAL `whisper base --word_timestamps True` run (see README/report). Words
// carry a leading space and glued trailing punctuation; the transform must match the AWS shape.
const WHISPER_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'whisper-word-timestamps.json'))
);

const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

// Bounded, loop-free poll of get-job until it leaves IN_PROGRESS (or the attempt budget runs out).
const pollJob = async (send, name, attempts) => {
  const got = await send(name);
  const job = got.TranscriptionJob;
  if (job.TranscriptionJobStatus !== 'IN_PROGRESS' || attempts <= 0) return job;
  await sleep(25);
  return pollJob(send, name, attempts - 1);
};

// ---------------------------------------------------------------------------
// log.js (copied byte-for-byte — regression guard)
// ---------------------------------------------------------------------------

test('normalizeLog exposes warning (not warn) and does not mutate the injected logger (G13)', t => {
  const injected = {notice: () => {}};
  const log = normalizeLog(injected);
  t.is(typeof log.warning, 'function');
  t.is(log.warn, undefined);
  t.deepEqual(Object.keys(injected), ['notice']);
});

// ---------------------------------------------------------------------------
// transcript.js — SPIKE 2 verified transform (AC-C3)
// ---------------------------------------------------------------------------

test('splitWordPunctuation strips the leading space and separates glued trailing punctuation', t => {
  t.deepEqual(splitWordPunctuation(' Hello'), {leading: [], word: 'Hello', trailing: []});
  t.deepEqual(splitWordPunctuation(' world,'), {leading: [], word: 'world', trailing: [',']});
  t.deepEqual(splitWordPunctuation(' transcription.'), {
    leading: [],
    word: 'transcription',
    trailing: ['.']
  });
});

test('splitWordPunctuation keeps internal apostrophes/hyphens inside the word', t => {
  t.deepEqual(splitWordPunctuation("don't"), {leading: [], word: "don't", trailing: []});
  t.deepEqual(splitWordPunctuation('well-known.'), {
    leading: [],
    word: 'well-known',
    trailing: ['.']
  });
});

test('splitWordPunctuation handles a pure-punctuation token and is total on bad input', t => {
  t.deepEqual(splitWordPunctuation('.'), {leading: ['.'], word: '', trailing: []});
  t.deepEqual(splitWordPunctuation(null), {leading: [], word: '', trailing: []});
});

test('wordToItems emits a timed pronunciation then an untimed punctuation for "world,"', t => {
  const items = wordToItems({word: ' world,', start: 0.26, end: 0.76, probability: 0.57});
  t.is(items.length, 2);
  t.deepEqual(items[0], {
    kind: 'pronunciation',
    content: 'world',
    word: {word: ' world,', start: 0.26, end: 0.76, probability: 0.57}
  });
  t.deepEqual(items[1], {kind: 'punctuation', content: ','});
});

test('whisperJsonToTranscribe produces the AWS shape with STRING numerics (AC-C3)', t => {
  const doc = whisperJsonToTranscribe(WHISPER_FIXTURE, {
    jobName: 'job-1',
    accountId: '000000000000'
  });
  t.is(doc.jobName, 'job-1');
  t.is(doc.accountId, '000000000000');
  t.is(doc.status, 'COMPLETED');
  t.is(doc.results.transcripts[0].transcript, 'Hello world, this is a test of transcription.');

  const items = doc.results.items;
  // Every item carries an integer id and typed alternatives.
  const first = items[0];
  t.is(first.id, 0);
  t.is(first.type, 'pronunciation');
  t.is(first.alternatives[0].content, 'Hello');
  // All numerics are STRINGS.
  t.is(typeof first.start_time, 'string');
  t.is(typeof first.end_time, 'string');
  t.is(typeof first.alternatives[0].confidence, 'string');

  // The comma after "world" is a standalone punctuation item that OMITS start_time/end_time.
  const comma = items.find(i => i.type === 'punctuation' && i.alternatives[0].content === ',');
  t.truthy(comma);
  t.is(comma.start_time, undefined);
  t.is(comma.end_time, undefined);
  t.is(comma.alternatives[0].confidence, '0.0');

  // audio_segments reference the item ids they contributed.
  t.is(doc.results.audio_segments.length, 1);
  t.deepEqual(
    doc.results.audio_segments[0].items,
    items.map(i => i.id)
  );
});

test('countPronunciations counts pronounceable words (0 → AC-C4 fail path)', t => {
  t.true(countPronunciations(WHISPER_FIXTURE) > 0);
  t.is(countPronunciations({segments: [{words: [{word: ' ...'}]}]}), 0);
  t.is(countPronunciations({}), 0);
  t.is(numToStr(1), '1');
});

// ---------------------------------------------------------------------------
// job-registry.js (AC-C1/C2)
// ---------------------------------------------------------------------------

test('buildJob builds an IN_PROGRESS descriptor and omits undefined fields (G12)', t => {
  const job = buildJob({
    jobName: 'j1',
    languageCode: 'en-US',
    mediaFileUri: 's3://b/k.wav',
    creationTime: 100,
    startTime: 100
  });
  t.is(job.TranscriptionJobStatus, STATUS.IN_PROGRESS);
  t.is(job.TranscriptionJobName, 'j1');
  t.deepEqual(job.Media, {MediaFileUri: 's3://b/k.wav'});
  t.false('MediaFormat' in job); // undefined omitted
  t.false('Transcript' in job);
});

test('completeJob / failJob transition immutably', t => {
  const job = buildJob({jobName: 'j1', creationTime: 1, startTime: 1});
  const done = completeJob(job, {transcriptFileUri: 'http://m/b/j1.json', completionTime: 5});
  t.is(done.TranscriptionJobStatus, STATUS.COMPLETED);
  t.deepEqual(done.Transcript, {TranscriptFileUri: 'http://m/b/j1.json'});
  t.is(job.TranscriptionJobStatus, STATUS.IN_PROGRESS); // original untouched (immutability)

  const failed = failJob(job, {failureReason: 'boom', completionTime: 6});
  t.is(failed.TranscriptionJobStatus, STATUS.FAILED);
  t.is(failed.FailureReason, 'boom');
});

test('toJobSummary picks the summary fields', t => {
  const job = completeJob(
    buildJob({jobName: 'j1', languageCode: 'en-US', creationTime: 1, startTime: 1}),
    {
      transcriptFileUri: 'http://m/b/j1.json',
      completionTime: 5
    }
  );
  const summary = toJobSummary(job);
  t.is(summary.TranscriptionJobName, 'j1');
  t.is(summary.TranscriptionJobStatus, 'COMPLETED');
  t.is(summary.OutputLocationType, 'CUSTOMER_BUCKET');
  t.false('Transcript' in summary); // not a summary field
});

test('JobRegistry stores and lists jobs by name', t => {
  const registry = new JobRegistry();
  t.false(registry.has('j1'));
  registry.put(buildJob({jobName: 'j1', creationTime: 1, startTime: 1}));
  t.true(registry.has('j1'));
  t.is(registry.get('j1').TranscriptionJobName, 'j1');
  t.is(registry.list().length, 1);
});

// ---------------------------------------------------------------------------
// s3-io.js — URI / OutputKey resolution (AC-C3)
// ---------------------------------------------------------------------------

test('parseS3Uri splits bucket and (slash-containing) key; null on bad input', t => {
  t.deepEqual(parseS3Uri('s3://my-bucket/path/to/audio.wav'), {
    bucket: 'my-bucket',
    key: 'path/to/audio.wav'
  });
  t.is(parseS3Uri('http://not-s3'), null);
  t.is(parseS3Uri(undefined), null);
});

test('resolveOutputKey follows the verified AWS rules', t => {
  t.is(resolveOutputKey({outputKey: 'out/result.json', jobName: 'j1'}), 'out/result.json'); // .json verbatim
  t.is(resolveOutputKey({outputKey: 'prefix/', jobName: 'j1'}), 'prefix/j1.json'); // trailing slash prefix
  t.is(resolveOutputKey({jobName: 'j1'}), 'j1.json'); // absent
  t.is(resolveOutputKey({outputKey: 'literal-key', jobName: 'j1'}), 'literal-key'); // verbatim
});

test('resolveOutputLocation falls back to the media bucket when OutputBucketName is absent', t => {
  t.deepEqual(
    resolveOutputLocation({outputKey: 'r.json', jobName: 'j1', fallbackBucket: 'media-b'}),
    {bucket: 'media-b', key: 'r.json'}
  );
  t.deepEqual(resolveOutputLocation({outputBucketName: 'out-b', jobName: 'j1'}), {
    bucket: 'out-b',
    key: 'j1.json'
  });
});

test('buildTranscriptFileUri builds a path-style http Minio URL', t => {
  t.is(
    buildTranscriptFileUri({endpoint: 'http://localhost:9000/', bucket: 'b', key: 'out/j1.json'}),
    'http://localhost:9000/b/out/j1.json'
  );
});

test('buildS3Config forces path-style and normalizes both credential spellings', t => {
  const minio = buildS3Config({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    accessKey: 'x',
    secretKey: 'y'
  });
  t.true(minio.forcePathStyle);
  t.deepEqual(minio.credentials, {accessKeyId: 'x', secretAccessKey: 'y'});
  const aws = buildS3Config({
    endpoint: 'http://localhost:9000',
    accessKeyId: 'a',
    secretAccessKey: 'b'
  });
  t.deepEqual(aws.credentials, {accessKeyId: 'a', secretAccessKey: 'b'});
});

// ---------------------------------------------------------------------------
// whisper.js (AC-C4/C5)
// ---------------------------------------------------------------------------

test('mapLanguageCode maps en-US→en and auto-detects on absent', t => {
  t.is(mapLanguageCode('en-US'), 'en');
  t.is(mapLanguageCode('fr-FR'), 'fr');
  t.is(mapLanguageCode(undefined), undefined);
  t.is(mapLanguageCode(''), undefined);
});

test('buildWhisperArgs always sets --word_timestamps True and json output', t => {
  const args = buildWhisperArgs({
    audioPath: '/tmp/a.wav',
    model: 'base',
    outputDir: '/tmp/out',
    language: 'en'
  });
  t.true(args.includes('--word_timestamps'));
  t.is(args[args.indexOf('--word_timestamps') + 1], 'True');
  t.is(args[args.indexOf('--output_format') + 1], 'json');
  t.is(args[args.indexOf('--language') + 1], 'en');
  // Absent language → auto-detect (no --language flag).
  t.false(
    buildWhisperArgs({audioPath: '/tmp/a.wav', outputDir: '/tmp/out'}).includes('--language')
  );
});

test('whisperOutputPath maps the audio basename to <name>.json in the output dir', t => {
  t.is(whisperOutputPath('/tmp/work/audio.wav', '/tmp/work'), path.join('/tmp/work', 'audio.json'));
});

test('isWhisperAvailable returns false for a missing binary (AC-C5)', async t => {
  t.false(await isWhisperAvailable('definitely-not-a-real-binary-xyz'));
});

// ---------------------------------------------------------------------------
// transcribe.js pure helpers + plugin (AC-X1)
// ---------------------------------------------------------------------------

test('parseTarget extracts the operation after the last dot', t => {
  t.is(parseTarget('Transcribe.StartTranscriptionJob'), 'StartTranscriptionJob');
  t.is(
    parseTarget('com.amazonaws.transcribe.Transcribe.GetTranscriptionJob'),
    'GetTranscriptionJob'
  );
  t.is(parseTarget(undefined), undefined);
});

test('parseBody is total', t => {
  t.deepEqual(parseBody(Buffer.from('{"a":1}')), {a: 1});
  t.deepEqual(parseBody(Buffer.from('bad')), {});
  t.deepEqual(parseBody(undefined), {});
});

test('isPluginEnabled honors enabled:false and the string "false" (AC-X1)', t => {
  t.true(isPluginEnabled({}));
  t.false(isPluginEnabled({enabled: false}));
  t.false(isPluginEnabled({enabled: 'false'}));
  t.is(defaultOptions.port, 4569);
  t.is(defaultOptions.model, 'base');
});

test('resolveEndpointUrl maps a 0.0.0.0 bind host to a connectable localhost URL', t => {
  t.is(resolveEndpointUrl({host: '0.0.0.0', port: 4569}), 'http://localhost:4569');
  t.is(resolveEndpointUrl({}), 'http://localhost:4569');
});

test('the plugin exposes the four offline hooks', t => {
  const plugin = new ServerlessOfflineTranscribe({}, {}, {log: defaultLog});
  t.deepEqual(Object.keys(plugin.hooks).sort(), [
    'offline:start',
    'offline:start:end',
    'offline:start:init',
    'offline:start:ready'
  ]);
});

// ---------------------------------------------------------------------------
// Integration (AC-C1/C2/C4 + endpoint injection): the UNMODIFIED TranscribeClient, with only the
// injected endpoint env var, drives the real job lifecycle over AWS JSON 1.1. An invalid Media URI
// makes the async pipeline FAIL fast (no Minio/network needed), proving Start→Get + the async
// transition without blocking the caller.
// ---------------------------------------------------------------------------

test.serial(
  'Integration: unmodified TranscribeClient runs Start→Get→FAILED via injected endpoint',
  async t => {
    // CI hermeticity: start() fails fast without the whisper binary (AC-C5, its own unit test
    // above) — on hosts without whisper (Travis) skip the lifecycle round-trip instead of failing.
    if (!(await isWhisperAvailable('whisper'))) {
      t.pass('whisper binary not installed — lifecycle covered by unit tests on this host');
      return;
    }
    // OS-assigned free port — a fixed port collides with other offline sessions on this machine.
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const freePort = probe.address().port;
        probe.close(() => resolve(freePort));
      });
    });
    const emulator = new Transcribe({host: '127.0.0.1', port, whisperBin: 'whisper'}, defaultLog);
    await emulator.start();

    const prev = process.env.AWS_ENDPOINT_URL_TRANSCRIBE;
    process.env.AWS_ENDPOINT_URL_TRANSCRIBE = resolveEndpointUrl({host: '127.0.0.1', port});
    process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'local';
    process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'local';

    const {
      TranscribeClient,
      StartTranscriptionJobCommand,
      GetTranscriptionJobCommand
    } = require('@aws-sdk/client-transcribe');
    const client = new TranscribeClient({});

    try {
      const started = await client.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: 'it-job-1',
          LanguageCode: 'en-US',
          Media: {MediaFileUri: 'invalid-not-s3-uri'} // → async pipeline FAILs immediately, no network
        })
      );
      t.is(started.TranscriptionJob.TranscriptionJobStatus, 'IN_PROGRESS');

      // Poll get-job (bounded, loop-free) until the async pipeline transitions the job (AC-C2).
      const job = await pollJob(
        name => client.send(new GetTranscriptionJobCommand({TranscriptionJobName: name})),
        'it-job-1',
        40
      );
      t.is(job.TranscriptionJobStatus, 'FAILED');
      t.true(job.FailureReason.includes('MediaFileUri'));
    } finally {
      client.destroy();
      if (prev === undefined) delete process.env.AWS_ENDPOINT_URL_TRANSCRIBE;
      else process.env.AWS_ENDPOINT_URL_TRANSCRIBE = prev;
      await emulator.stop(1000);
    }
  }
);
