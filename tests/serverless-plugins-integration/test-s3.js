const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const Minio = require('minio');
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
    client.fPutObject('files', 'second.txt', path)
  ]);
};
const EXPECED_LAMBDA_CALL = 8; // pictures files are consumed twice, by myPromiseHandler and myPythonHandler

const serverless = spawn('serverless', ['--config', 'serverless.s3.yml', 'offline', 'start'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

pump(
  serverless.stdout,
  getSplitLinesTransform(),
  new Writable({
    objectMode: true,
    write(line, enc, cb) {
      if (/Starting Offline S3/.test(line)) {
        uploadFiles();
      }

      this.count =
        (this.count || 0) +
        (
          line.match(
            /offline: \(λ: .*\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g
          ) || []
        ).length;
      if (this.count === EXPECED_LAMBDA_CALL) serverless.kill();
      cb();
    }
  })
);

serverless.stdout.on('data', data => {
  console.log(data.toString());
});

serverless.stderr.on('data', data => {
  console.error(data.toString());
  process.exit(1);
});

serverless.on('close', code => {
  process.exit(code);
});

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
