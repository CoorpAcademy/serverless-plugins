const {Writable} = require('stream');
const {spawn} = require('child_process');
const Minio = require('minio');
const onExit = require('signal-exit');
const pump = require('pump');
const {delay, getSplitLinesTransform} = require('./utils');

const client = new Minio.Client({
  region: 'eu-west-1',
  endPoint: 'localhost',
  port: 9000,
  accessKey: 'local',
  secretKey: 'locallocal',
  useSSL: false
});

const path = './files/test.txt';
const uploadFiles = async () => {
  await delay(1000);

  await Promise.all([
    client.fPutObject('documents', 'first.txt', path),
    client.fPutObject('pictures', 'first.txt', path),
    client.fPutObject('files', 'first.txt', path),
    client.fPutObject('documents', 'second.txt', path),
    client.fPutObject('pictures', 'second.txt', path),
    client.fPutObject('files', 'second.txt', path),
    client.fPutObject('others', 'correct/test.txt', path),
    client.fPutObject('others', 'wrong/test.csv', path),
    client.fPutObject('others', 'correct/test.csv', path),
    client.fPutObject('others', 'wrong/test.txt', path)
  ]);
};
const EXPECTED_LAMBDA_CALL = 9; // pictures files are consumed twice, by myPromiseHandler and myPythonHandler

const serverless = spawn('sls', ['offline', 'start', '--config', 'serverless.s3.yml'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

pump(
  serverless.stderr,
  getSplitLinesTransform(),
  new Writable({
    objectMode: true,
    write(line, enc, cb) {
      if (/Starting Offline S3/.test(line)) {
        uploadFiles();
      }

      this.count =
        (this.count || 0) +
        (line.match(/\(λ: .*\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g) || [])
          .length;
      if (this.count === EXPECTED_LAMBDA_CALL) serverless.kill();
      cb();
    }
  })
);

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
