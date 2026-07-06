const {isUndefined, omitBy, pick} = require('lodash/fp');

// serverless-offline-transcribe — job descriptors + in-memory registry.
//
// The descriptor builders are pure (G1/G2/G3): each returns a NEW AWS `TranscriptionJob` object,
// never mutating its input. `JobRegistry` is the thin stateful holder (a Map keyed by job name),
// mirroring how the sibling SQS plugin keeps its p-queue as the one piece of mutable state.

const omitUndefined = omitBy(isUndefined);

// AWS TranscriptionJobStatus enum. We skip QUEUED and go straight to IN_PROGRESS (verified: the SDK
// deserializes either; a local engine has no queue).
const STATUS = {IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED', FAILED: 'FAILED'};

// Build an IN_PROGRESS descriptor. Timestamps are EPOCH-SECONDS integers (verified to deserialize
// into a JS Date by the SDK); the caller injects them (keeps this pure). Unset fields are omitted so
// an `undefined` never reaches the wire (G11/G12).
const buildJob = ({jobName, languageCode, mediaFormat, mediaFileUri, creationTime, startTime}) =>
  omitUndefined({
    TranscriptionJobName: jobName,
    TranscriptionJobStatus: STATUS.IN_PROGRESS,
    LanguageCode: languageCode,
    MediaFormat: mediaFormat,
    Media: omitUndefined({MediaFileUri: mediaFileUri}),
    CreationTime: creationTime,
    StartTime: startTime
  });

// COMPLETED transition — adds Transcript.TranscriptFileUri + CompletionTime. Pure (new object).
const completeJob = (job, {transcriptFileUri, completionTime}) =>
  omitUndefined({
    ...job,
    TranscriptionJobStatus: STATUS.COMPLETED,
    Transcript: {TranscriptFileUri: transcriptFileUri},
    CompletionTime: completionTime
  });

// FAILED transition — sets FailureReason so a caller never sees a silently-empty transcript
// (AC-C4). Pure (new object).
const failJob = (job, {failureReason, completionTime}) =>
  omitUndefined({
    ...job,
    TranscriptionJobStatus: STATUS.FAILED,
    FailureReason: failureReason,
    CompletionTime: completionTime
  });

// TranscriptionJobSummary for ListTranscriptionJobs — the subset AWS returns per job. Pure.
const toJobSummary = job =>
  omitUndefined({
    ...pick(
      [
        'TranscriptionJobName',
        'TranscriptionJobStatus',
        'LanguageCode',
        'CreationTime',
        'StartTime',
        'CompletionTime',
        'FailureReason'
      ],
      job
    ),
    OutputLocationType: 'CUSTOMER_BUCKET'
  });

class JobRegistry {
  constructor() {
    this.jobs = new Map();
  }

  has(name) {
    return this.jobs.has(name);
  }

  get(name) {
    return this.jobs.get(name);
  }

  // Upsert a descriptor (keyed by its job name) and return it.
  put(job) {
    this.jobs.set(job.TranscriptionJobName, job);
    return job;
  }

  list() {
    return [...this.jobs.values()];
  }
}

module.exports = {
  STATUS,
  buildJob,
  completeJob,
  failJob,
  toJobSummary,
  JobRegistry
};
