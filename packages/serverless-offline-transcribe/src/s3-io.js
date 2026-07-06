const fs = require('fs');
const {isNil} = require('lodash/fp');
const {S3Client, GetObjectCommand, PutObjectCommand} = require('@aws-sdk/client-s3');
const {buildClientConfig} = require('./client-config');

// serverless-offline-transcribe — S3 (local Minio) media read / transcript write.
//
// Pure URI/key helpers (exported for unit test) + a thin set of side-effecting S3 calls. The local
// S3 is this repo's Minio convention (`minio/minio`, port 9000, path-style addressing). Pure helpers
// are total (G2/G3/G12): a malformed URI returns null rather than throwing.

// Parse an `s3://{bucket}/{key}` URI (key may contain slashes). Total — returns null on a bad URI.
const parseS3Uri = uri => {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri || '');
  return match ? {bucket: match[1], key: match[2]} : null;
};

// Resolve the transcript object key from OutputKey (verified AWS rules, replicated exactly):
//   • ends `.json` → used verbatim
//   • ends `/`     → `{OutputKey}{jobName}.json` (OutputKey is a prefix)
//   • absent       → `{jobName}.json`
//   • otherwise    → used verbatim as the object key (AWS treats OutputKey as the literal key)
const resolveOutputKey = ({outputKey, jobName}) => {
  if (isNil(outputKey) || outputKey === '') return `${jobName}.json`;
  if (outputKey.endsWith('.json')) return outputKey;
  if (outputKey.endsWith('/')) return `${outputKey}${jobName}.json`;
  return outputKey;
};

// Resolve where the transcript is written. OutputBucketName is preferred; when absent (AWS would use
// a service-managed bucket), fall back to the media bucket so a local job still has a home.
const resolveOutputLocation = ({outputBucketName, outputKey, jobName, fallbackBucket}) => {
  const bucket = outputBucketName || fallbackBucket;
  return {bucket, key: resolveOutputKey({outputKey, jobName})};
};

// Build the path-style Minio HTTP URL the job descriptor exposes as Transcript.TranscriptFileUri.
// The SDK is verified to accept an `http://` URI here (lowest friction for a fetch consumer); Minio
// requires bucket-in-path (path-style). Endpoint's trailing slash is trimmed.
const buildTranscriptFileUri = ({endpoint, bucket, key}) =>
  `${(endpoint || '').replace(/\/$/, '')}/${bucket}/${key}`;

// Normalize the two credential spellings (Minio's accessKey/secretKey and the AWS
// accessKeyId/secretAccessKey used by client-config) into a v3 client config, forcing path-style
// addressing (mandatory for Minio's bucket-in-path). Pure.
const buildS3Config = options => {
  const opts = options || {};
  const accessKeyId = isNil(opts.accessKeyId) ? opts.accessKey : opts.accessKeyId;
  const secretAccessKey = isNil(opts.secretAccessKey) ? opts.secretKey : opts.secretAccessKey;
  return {
    ...buildClientConfig({
      region: opts.region,
      endpoint: opts.endpoint,
      accessKeyId,
      secretAccessKey
    }),
    // forcePathStyle is MANDATORY for Minio (it addresses buckets in the path, not the host).
    forcePathStyle: true
  };
};

const createS3Client = options => new S3Client(buildS3Config(options));

// Side effect: download an s3://bucket/key object to a local file (Whisper reads a real file path).
const downloadToFile = async (client, {bucket, key}, filePath) => {
  const response = await client.send(new GetObjectCommand({Bucket: bucket, Key: key}));
  const bytes = await response.Body.transformToByteArray();
  await fs.promises.writeFile(filePath, Buffer.from(bytes));
  return filePath;
};

// Side effect: upload the AWS-shaped transcript JSON to the resolved output location.
const uploadJson = (client, {bucket, key}, body) =>
  client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json'
    })
  );

module.exports = {
  parseS3Uri,
  resolveOutputKey,
  resolveOutputLocation,
  buildTranscriptFileUri,
  buildS3Config,
  createS3Client,
  downloadToFile,
  uploadJson
};
