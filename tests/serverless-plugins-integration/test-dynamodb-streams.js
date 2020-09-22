/* eslint-disable unicorn/no-process-exit */
const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {DynamoDB} = require('aws-sdk');

const client = new DynamoDB({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:8000'
});

const putItems = async () => {
  // Dynamodb-local doesn't create stream until table isn't empty
  await Promise.all([
    client
      .putItem({
        Item: {id: {S: `Bug`}},
        TableName: 'MyFirstTable'
      })
      .promise(),
    client
      .putItem({
        Item: {id: {S: `Bug`}},
        TableName: 'MySecondTable'
      })
      .promise(),
    client
      .putItem({
        Item: {id: {S: `Bug`}},
        TableName: 'MyThirdTable'
      })
      .promise(),
    client
      .putItem({
        Item: {id: {S: `Bug`}},
        TableName: 'MyFourthTable'
      })
      .promise()
  ]);
  // wait stream get a new iterator
  await new Promise(resolve => {
    setTimeout(resolve, 1000);
  });

  await Promise.all([
    client
      .putItem({
        Item: {id: {S: `MyFirstId`}},
        TableName: 'MyFirstTable'
      })
      .promise(),
    client
      .putItem({
        Item: {id: {S: `MySecondId`}},
        TableName: 'MySecondTable'
      })
      .promise(),
    client
      .putItem({
        Item: {id: {S: `MyThirdId`}},
        TableName: 'MyThirdTable'
      })
      .promise(),
    client
      .putItem({
        Item: {id: {S: `MyFourthId`}},
        TableName: 'MyFourthTable'
      })
      .promise()
  ]);
};

const serverless = spawn(
  'serverless',
  ['--config', 'serverless.dynamodb-streams.yml', 'offline', 'start'],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: __dirname
  }
);

const set = new Set();
serverless.stdout.pipe(
  new Writable({
    write(chunk, enc, cb) {
      const output = chunk.toString();

      if (/Starting Offline Dynamodb Streams/.test(output)) {
        putItems();
      }

      const matches = /offline: \(λ: (.*)\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g.exec(
        output
      );

      if (matches) set.add(matches[1]);

      if (set.size === 4) serverless.kill();
      cb();
    }
  })
);
serverless.stdout.pipe(
  new Writable({
    write(chunk, enc, cb) {
      const output = chunk.toString();

      if (/Starting Offline Dynamodb Streams/.test(output)) {
        putItems();
      }

      this.count =
        (this.count || 0) +
        (
          output.match(
            /offline: \(λ: .*\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g
          ) || []
        ).length;
      if (this.count === 4) serverless.kill();
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
