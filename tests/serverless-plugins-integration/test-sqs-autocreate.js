/* eslint-disable unicorn/no-process-exit */
const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {SQS} = require('aws-sdk');

const client = new SQS({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:9324'
});

const sendMessages = () => {
  return Promise.all([
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/AutocreatedImplicitQueue',
        MessageBody: 'AutocreatedImplicitQueue'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/AutocreatedQueue',
        MessageBody: 'AutocreatedQueue'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/AutocreatedFifoQueue.fifo',
        MessageBody: 'AutocreatedFifoQueue',
        MessageGroupId: '1'
      })
      .promise()
  ]);
};

const serverless = spawn('serverless', ['--config', 'serverless.sqs.autocreate.yml', 'offline'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

serverless.stdout.pipe(
  new Writable({
    write(chunk, enc, cb) {
      const output = chunk.toString();

      if (/Offline.+listening on/.test(output)) {
        sendMessages()
          .then(() => console.log('sucessfully send messages'))
          .catch(err => {
            console.log('Some issue sending message:s', err.message);
          });
      }

      this.count = (this.count || 0) + (output.match(/\[✔]/g) || []).length;
      if (this.count === 2) serverless.kill();
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

async function pruneQueue(QueueName) {
  const {QueueUrl} = await client
    .getQueueUrl({QueueName})
    .promise()
    .catch(err => {
      console.log(`Ignore issue that occured pruning ${QueueName}: ${err.message}`);
      return {QueueUrl: null};
    });
  if (QueueUrl) await client.deleteQueue({QueueUrl}).promise();
}

async function cleanUp() {
  await Promise.all([
    pruneQueue('AutocreatedImplicitQueue'),
    pruneQueue('AutocreatedQueue'),
    pruneQueue('AutocreatedFifoQueue.fifo')
  ]);
}

serverless.on('close', code => {
  cleanUp()
    .then(() => {
      return process.exit(code);
    })
    .catch(err => {
      console.error(`Queue deletion failed: ${err.message}`);
      process.exit(code || 12);
    });
});

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
