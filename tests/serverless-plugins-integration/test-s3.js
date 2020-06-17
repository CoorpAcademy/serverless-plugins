/* eslint-disable unicorn/no-process-exit */
const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const Minio = require('minio');

const client = new Minio.Client({
  endPoint: '0.0.0.0',
  port: 9000,
  accessKey: 'minioadmin',
  secretKey: 'minioadmin',
  useSSL: false
});

const path = './files/test.txt';
const uploadFiles = () => {
  return Promise.all([
    client.fPutObject('documents', 'test.txt', path),
    client.fPutObject('pictures', 'test.txt', path),
    client.fPutObject('files', 'test.txt', path)
  ]);
};

const serverless = spawn('serverless', ['--config', 'serverless.s3.yml', 'offline'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

serverless.stdout.pipe(
  new Writable({
    write(chunk, enc, cb) {
      const output = chunk.toString();

      if (/Offline \[HTTP] listening on/.test(output)) {
        uploadFiles();
      }

      this.count = (this.count || 0) + (output.match(/\[✔]/g) || []).length;
      if (this.count === 3) serverless.kill();
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
