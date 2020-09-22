const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const Minio = require('minio');

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
  await new Promise(resolve => {
    setTimeout(resolve, 1000);
  });

  await Promise.all([
    client.fPutObject('documents', 'first.txt', path),
    client.fPutObject('pictures', 'first.txt', path),
    client.fPutObject('files', 'first.txt', path),
    client.fPutObject('documents', 'second.txt', path),
    client.fPutObject('pictures', 'second.txt', path),
    client.fPutObject('files', 'second.txt', path)
  ]);
};

const serverless = spawn('serverless', ['--config', 'serverless.s3.yml', 'offline', 'start'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

serverless.stdout.pipe(
  new Writable({
    write(chunk, enc, cb) {
      const output = chunk.toString();

      if (/Starting Offline S3/.test(output)) {
        uploadFiles();
      }

      this.count =
        (this.count || 0) +
        (
          output.match(
            /offline: \(λ: .*\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g
          ) || []
        ).length;
      if (this.count === 6) serverless.kill();
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
