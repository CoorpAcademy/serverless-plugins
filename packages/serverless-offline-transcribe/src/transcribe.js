const os = require('os');
const fs = require('fs');
const path = require('path');
const Hapi = require('@hapi/hapi');
const {get, getOr, isNil, last, split} = require('lodash/fp');

const {normalizeLog} = require('./log');
const {buildJob, completeJob, failJob, toJobSummary, JobRegistry} = require('./job-registry');
const {whisperJsonToTranscribe} = require('./transcript');
const {mapLanguageCode, runWhisper, isWhisperAvailable} = require('./whisper');
const {
  parseS3Uri,
  resolveOutputLocation,
  buildTranscriptFileUri,
  createS3Client,
  downloadToFile,
  uploadJson
} = require('./s3-io');

// serverless-offline-transcribe — local Transcribe HTTP server (thin orchestrator).
//
// Speaks AWS JSON 1.1 — a single `POST /` route (the v3 serializer force-appends the trailing slash)
// dispatched on the `x-amz-target` header. All shaping/parsing lives in the pure helpers
// (job-registry, transcript, s3-io, whisper); this class wires them to the HTTP surface + the async
// Whisper pipeline. Transcribe (batch) uses the SDK's HTTP/1.1 NodeHttpHandler (verified), so
// @hapi/hapi is the right server here (contrast serverless-offline-bedrock's h2c requirement).

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 4569;
const CONTENT_TYPE = 'application/x-amz-json-1.1';

// Coerce a configured port to a number while honoring an explicit `0` (OS-assigned free port).
// `Number(port) || DEFAULT_PORT` would treat the valid 0 as unset and rebind DEFAULT_PORT. Pure/total.
const resolvePort = port =>
  port === undefined || port === null || port === '' ? DEFAULT_PORT : Number(port);

// The SDK sends `x-amz-target: Transcribe.<Op>` (some tooling uses the fully-qualified
// `com.amazonaws.transcribe.Transcribe.<Op>`); match the suffix after the last `.` so both work. Pure.
const parseTarget = header => (isNil(header) ? undefined : last(split('.', header)));

// Total JSON parse of the request body (Buffer/string) — a malformed body must not crash offline.
const parseBody = raw => {
  if (isNil(raw) || raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString());
  } catch (err) {
    return {};
  }
};

// Epoch-SECONDS integer — the verified CreationTime/StartTime/CompletionTime encoding (deserializes
// to a JS Date). Isolated side effect (clock).
const nowEpoch = () => Math.floor(Date.now() / 1000);

// AWS JSON 1.1 reply: JSON body + the protocol content-type. Module-level (no `this`).
const reply = (h, body, statusCode = 200) =>
  h.response(JSON.stringify(body)).code(statusCode).type(CONTENT_TYPE);

// AWS JSON 1.1 error envelope: {"__type": "<Exception>", "message": "..."}.
const errorReply = (h, statusCode, type, message) => reply(h, {__type: type, message}, statusCode);

class Transcribe {
  constructor(options, log) {
    this.options = options;
    this.log = normalizeLog(log);

    this.host = options.host || DEFAULT_HOST;
    this.port = resolvePort(options.port);
    this.accountId = getOr('000000000000', 'accountId', options);
    this.model = getOr('base', 'model', options);

    this.registry = new JobRegistry();
    this.s3 = createS3Client(options);

    this.server = Hapi.server({host: this.host, port: this.port});
    this.server.route({
      method: 'POST',
      path: '/',
      // x-amz-json-1.1 is not application/json, so hapi would not parse it; take the raw payload and
      // JSON.parse it ourselves (total parseBody).
      options: {payload: {parse: false, output: 'data'}},
      handler: this._onRequest.bind(this)
    });
  }

  _onRequest(request, h) {
    const target = parseTarget(request.headers['x-amz-target']);
    const body = parseBody(request.payload);

    try {
      switch (target) {
        case 'StartTranscriptionJob':
          return this._startJob(body, h);
        case 'GetTranscriptionJob':
          return this._getJob(body, h);
        case 'ListTranscriptionJobs':
          return this._listJobs(body, h);
        default:
          return errorReply(h, 400, 'UnknownOperationException', `Unknown x-amz-target: ${target}`);
      }
    } catch (err) {
      // Never crash offline (G5): an unexpected error becomes an AWS-shaped 500.
      this.log.warning(`serverless-offline-transcribe: ${err.stack}`);
      return errorReply(h, 500, 'InternalFailure', err.message);
    }
  }

  _startJob(body, h) {
    const jobName = get('TranscriptionJobName', body);
    const mediaFileUri = get(['Media', 'MediaFileUri'], body);

    if (isNil(jobName))
      return errorReply(h, 400, 'BadRequestException', 'TranscriptionJobName is required.');

    // Duplicate name → ConflictException (verified: HTTP 400 + __type ConflictException).
    if (this.registry.has(jobName))
      return errorReply(
        h,
        400,
        'ConflictException',
        `The requested job name (${jobName}) already exists.`
      );

    const created = nowEpoch();
    const job = buildJob({
      jobName,
      languageCode: get('LanguageCode', body),
      mediaFormat: get('MediaFormat', body),
      mediaFileUri,
      creationTime: created,
      startTime: created
    });
    this.registry.put(job);

    // AC-C1/C2: kick off processing asynchronously and return IN_PROGRESS immediately (never block
    // the caller). The floating promise is guarded so a failure FAILs the job, never rejects
    // unhandled (G5).
    this._processJob(job, body).catch(err => {
      this.log.warning(`serverless-offline-transcribe: job ${jobName} crashed: ${err.stack}`);
      this.registry.put(
        failJob(this.registry.get(jobName) || job, {
          failureReason: err.message,
          completionTime: nowEpoch()
        })
      );
    });

    return reply(h, {TranscriptionJob: job});
  }

  _getJob(body, h) {
    const jobName = get('TranscriptionJobName', body);
    const job = this.registry.get(jobName);
    if (isNil(job))
      return errorReply(
        h,
        400,
        'BadRequestException',
        `The requested job couldn't be found. Check the job name (${jobName}) and try again.`
      );
    return reply(h, {TranscriptionJob: job});
  }

  _listJobs(body, h) {
    const status = get('Status', body);
    const summaries = this.registry
      .list()
      .filter(job => isNil(status) || job.TranscriptionJobStatus === status)
      .map(toJobSummary);
    return reply(h, {TranscriptionJobSummaries: summaries});
  }

  // The async batch pipeline (all side effects). On any failure the job transitions to FAILED with a
  // real reason (AC-C4) rather than emitting a silently-empty transcript.
  async _processJob(job, body) {
    const jobName = job.TranscriptionJobName;
    const media = parseS3Uri(get(['Media', 'MediaFileUri'], body));
    if (isNil(media)) {
      this.registry.put(
        failJob(job, {
          failureReason: `Invalid Media.MediaFileUri (expected s3://bucket/key).`,
          completionTime: nowEpoch()
        })
      );
      return;
    }

    const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sls-transcribe-'));
    try {
      const audioPath = path.join(workDir, path.basename(media.key));
      await downloadToFile(this.s3, media, audioPath);

      const whisperJson = await runWhisper({
        audioPath,
        model: this.model,
        outputDir: workDir,
        language: mapLanguageCode(job.LanguageCode),
        bin: this.options.whisperBin,
        timeout: this.options.whisperTimeout
      });

      const transcript = whisperJsonToTranscribe(whisperJson, {jobName, accountId: this.accountId});

      // AC-C4: a run that recognized no words is a failure, not an empty success. Reuse the items we
      // just shaped rather than re-running the whole word→item pass a second time.
      if (!transcript.results.items.some(item => item.type === 'pronunciation')) {
        this.registry.put(
          failJob(job, {
            failureReason:
              'The transcription produced no recognizable speech for the requested language/format.',
            completionTime: nowEpoch()
          })
        );
        return;
      }

      const location = resolveOutputLocation({
        outputBucketName: get('OutputBucketName', body),
        outputKey: get('OutputKey', body),
        jobName,
        fallbackBucket: media.bucket
      });
      await uploadJson(this.s3, location, JSON.stringify(transcript));

      const transcriptFileUri = buildTranscriptFileUri({
        endpoint: this.options.endpoint,
        bucket: location.bucket,
        key: location.key
      });
      // AC-C3: expose the transcript URI on the (now COMPLETED) descriptor.
      this.registry.put(completeJob(job, {transcriptFileUri, completionTime: nowEpoch()}));
      this.log.notice(
        `serverless-offline-transcribe: job ${jobName} COMPLETED → ${transcriptFileUri}`
      );
    } finally {
      await fs.promises.rm(workDir, {recursive: true, force: true});
    }
  }

  async start() {
    // AC-C5: fail fast at startup when the Whisper prerequisite is missing.
    if (!(await isWhisperAvailable(this.options.whisperBin))) {
      throw new Error(
        'serverless-offline-transcribe: the "whisper" binary was not found on PATH. Install it with ' +
          '`pip install openai-whisper` (and ffmpeg) before starting serverless offline.'
      );
    }
    await this.server.start();
    // Honor `port: 0` end-to-end (Codex F1): after start() Hapi exposes the OS-assigned port on
    // server.info.port (NOT server.address()), so callers advertise the real port, not the 0.
    this.port = this.server.info.port;
    this.log.notice(`Transcribe emulator listening on http://${this.host}:${this.port}`);
  }

  async stop(timeout) {
    // AC-X2: release the port on shutdown; hapi drains in-flight requests up to `timeout` ms.
    await this.server.stop({timeout});
  }
}

module.exports = Transcribe;
module.exports.parseTarget = parseTarget;
module.exports.parseBody = parseBody;
module.exports.resolvePort = resolvePort;
module.exports.DEFAULT_HOST = DEFAULT_HOST;
module.exports.DEFAULT_PORT = DEFAULT_PORT;
