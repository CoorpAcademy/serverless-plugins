# serverless-offline-transcribe

This [Serverless-offline](https://github.com/dherault/serverless-offline) plugin emulates **Amazon
Transcribe** batch jobs on your local machine, so code that calls the Transcribe client runs fully
offline — no AWS account, no network, no cloud cost. Media is read from local S3
([Minio](https://min.io)), transcribed by a **developer-provided local engine**
([OpenAI Whisper](https://github.com/openai/whisper)), and written back to local S3 in the AWS
Transcribe JSON shape — exactly as `serverless-offline-sqs` translates SQS calls to ElasticMQ.

_Scope (MVP):_ asynchronous **batch** jobs (`StartTranscriptionJob` / `GetTranscriptionJob` /
`ListTranscriptionJobs`). Streaming transcription is out of scope for now.

## How it works

The plugin stands up a local HTTP server speaking AWS JSON 1.1 and, in `offline:start:init`, injects
`AWS_ENDPOINT_URL_TRANSCRIBE` **before** the offline Lambda runtime snapshots each function's
environment. Your **unmodified** Transcribe client therefore resolves to `localhost` with **no
application code change**.

`StartTranscriptionJob` registers the job `IN_PROGRESS`, returns the AWS job descriptor immediately,
and processes asynchronously: download the media from local S3 → run Whisper with word-level
timestamps → shape the result into the AWS Transcribe JSON (word `items[]`, punctuation split into
its own untimed items, `audio_segments`) → upload it to the resolved output location. `GetTranscriptionJob`
reports `COMPLETED` (with `Transcript.TranscriptFileUri`) or `FAILED` (with `FailureReason`).

## Prerequisites

- **[OpenAI Whisper](https://github.com/openai/whisper)** on your `PATH`:
  ```sh
  pip install -U openai-whisper      # also needs ffmpeg (e.g. `brew install ffmpeg`)
  which whisper                      # must resolve
  ```
  If `whisper` is missing, the plugin **fails fast at startup** naming the prerequisite.
- **Local S3 (Minio)** — the same local S3 this repo uses for `serverless-offline-s3`:
  ```sh
  docker run -p 9000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
    minio/minio server /data
  ```

Neither engine is bundled (developer prerequisites, like ElasticMQ for SQS).

## Installation

```sh
npm install --save-dev serverless-offline-transcribe
```

Add it to your `serverless.yml` plugins **before** `serverless-offline`:

```yml
plugins:
  - serverless-offline-transcribe
  - serverless-offline
```

## Configuration

```yml
custom:
  serverless-offline-transcribe:
    enabled: true                    # set false (or "false") to skip the emulator entirely
    host: 0.0.0.0
    port: 4569
    accountId: '000000000000'
    model: base                      # Whisper model: tiny | base | small | medium | large
    # Local S3 (Minio) — mirrors serverless-offline-s3 config keys
    endpoint: http://localhost:9000
    region: us-east-1
    accessKey: minioadmin
    secretKey: minioadmin
    # whisperBin: whisper            # optional: path to the whisper binary
    # whisperTimeout: 600000         # optional: per-job Whisper timeout (ms)
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | `false` / `"false"` skips standing up the server. |
| `host` / `port` | `0.0.0.0` / `4569` | Bind address of the local Transcribe endpoint. |
| `accountId` | `000000000000` | Emitted on the transcript document. |
| `model` | `base` | Whisper model size. |
| `endpoint` | `http://localhost:9000` | Local S3 (Minio) endpoint. Path-style addressing is forced (mandatory for Minio). |
| `region` | `us-east-1` | S3 region (Minio ignores the value but the v3 SDK requires one). |
| `accessKey` / `secretKey` | `minioadmin` | Minio credentials (`accessKeyId`/`secretAccessKey` also accepted). |
| `whisperBin` | `whisper` | Whisper executable (looked up on `PATH`). |
| `whisperTimeout` | — | Optional per-job Whisper timeout in ms. |

## Behavior notes

- **Lifecycle (AC-C1/C2):** `StartTranscriptionJob` returns `IN_PROGRESS` without blocking; processing
  runs asynchronously; `GetTranscriptionJob` reports the transition to `COMPLETED`/`FAILED`.
- **Output location (AC-C3):** resolved from `OutputBucketName` + `OutputKey` (ends `.json` → verbatim;
  ends `/` → `{OutputKey}{jobName}.json`; absent → `{jobName}.json`). `Transcript.TranscriptFileUri`
  is a path-style Minio `http://` URL. When `OutputBucketName` is absent it falls back to the media
  bucket.
- **Failures (AC-C4/C5):** an unsupported language/format, a run that recognizes no speech, or a bad
  media URI **fails the job** with a `FailureReason` (never a silently-empty transcript). A missing
  Whisper binary fails fast at startup.
- **Security:** Whisper is invoked via `execFile` (no shell) with the audio path as an argument.
- These are **local-development / CI** tools: the goal is a protocol-faithful substitute, not AWS
  Transcribe accuracy parity. Diarization / custom vocabularies / redaction are non-goals.

## Copy-paste example

```yml
service: my-service

plugins:
  - serverless-offline-transcribe
  - serverless-offline

provider:
  name: aws
  runtime: nodejs18.x

custom:
  serverless-offline-transcribe:
    model: base
    endpoint: http://localhost:9000
    accessKey: minioadmin
    secretKey: minioadmin

functions:
  transcribe:
    handler: handler.transcribe
    events:
      - httpApi: 'POST /transcribe'
```

```js
// handler.js — unchanged production code
const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand
} = require('@aws-sdk/client-transcribe');
const client = new TranscribeClient({}); // resolves to localhost:4569 offline

exports.transcribe = async event => {
  const {jobName, mediaUri} = JSON.parse(event.body);
  await client.send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      LanguageCode: 'en-US',
      Media: {MediaFileUri: mediaUri}, // s3://my-bucket/audio.wav in local Minio
      OutputBucketName: 'my-bucket',
      OutputKey: 'transcripts/'
    })
  );
  const {TranscriptionJob} = await client.send(
    new GetTranscriptionJobCommand({TranscriptionJobName: jobName})
  );
  return {statusCode: 200, body: JSON.stringify(TranscriptionJob)};
};
```

```sh
# with Minio + whisper running, and an audio object uploaded to s3://my-bucket/audio.wav
serverless offline
```

## License

MIT
