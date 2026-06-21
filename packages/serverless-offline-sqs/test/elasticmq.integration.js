const {execFile: execFileCb} = require('child_process');
const {promisify} = require('util');
const test = require('ava');
const {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  GetQueueUrlCommand
} = require('@aws-sdk/client-sqs');

const ServerlessOfflineSQS = require('../src');

// #146 (tstackhouse, tristan-mastrodicasa): a REAL, docker-gated integration test for autoStart.
// It boots an actual ElasticMQ container from the plugin lifecycle (autoStart:true + autoCreate:true,
// no endpoint), proves a queue is created INSIDE the container and a message round-trips, then ends()
// and proves the container is gone. Gated behind a `docker version` probe so a Docker-less CI skips
// it; a UNIQUE container name + afterEach `docker rm -f` guarantee nothing leaks.

const execFile = promisify(execFileCb);
const docker = (...args) => execFile('docker', args);
const dockerQuiet = async (...args) => {
  try {
    return await docker(...args);
  } catch (err) {
    return undefined;
  }
};

// A unique-per-run host port + container name so parallel/leftover runs never collide.
const TEST_PORT = 9399;
const TEST_NAME = `so-sqs-autostart-it-${process.pid}`;
// EVENT_QUEUE is wired to the lambda event (triggers _createSqs + a poll loop). RT_QUEUE is a
// resource-only queue with NO consumer, so the round-trip assertion below is deterministic (no
// listener races us for the message). autoCreate creates BOTH inside the autostarted container.
const EVENT_QUEUE = 'autostart-it-event';
const RT_QUEUE = 'autostart-it-roundtrip';
const silentLog = {notice: () => {}, warning: () => {}, debug: () => {}, info: () => {}};

const dockerAvailable = async () => {
  try {
    await docker('version');
    return true;
  } catch (err) {
    return false;
  }
};

const containerRunning = async name => {
  const {stdout} = await docker('ps', '--filter', `name=${name}`, '--format', '{{.Names}}');
  return stdout
    .split('\n')
    .map(s => s.trim())
    .includes(name);
};

// A minimal serverless mock. One function carries a real `sqs` event (so the plugin runs the genuine
// _createSqs path that autoCreates queues and attaches a listener — AC10), and a second round-trip
// queue is declared in resources.Resources so autoCreate creates it too, without a consumer.
const eventArn = `arn:aws:sqs:eu-west-1:000000000000:${EVENT_QUEUE}`;
const buildServerless = () => ({
  service: {
    custom: {
      'serverless-offline-sqs': {
        autoStart: {port: TEST_PORT, name: TEST_NAME, readinessTimeout: 60000},
        autoCreate: true,
        region: 'eu-west-1',
        accountId: '000000000000'
      }
    },
    provider: {region: 'eu-west-1'},
    resources: {
      Resources: {
        RtQueue: {Type: 'AWS::SQS::Queue', Properties: {QueueName: RT_QUEUE}}
      }
    },
    getAllFunctions: () => ['worker'],
    getFunction: () => ({handler: 'handler.worker', events: [{sqs: {arn: eventArn}}]}),
    getAllEventsInFunction: () => [{sqs: {arn: eventArn}}]
  }
});

let skip = false;

test.before(async () => {
  skip = !(await dockerAvailable());
  if (!skip) await dockerQuiet('rm', '-f', TEST_NAME); // reclaim a leak from a previous crashed run
});

test.after.always(async () => {
  await dockerQuiet('rm', '-f', TEST_NAME);
});

test.serial(
  '#146 INTEGRATION autoStart boots ElasticMQ, autoCreates a queue, round-trips a message, tears down (AC2/AC3/AC4/AC10)',
  async t => {
    if (skip) {
      t.pass('docker unavailable — integration test skipped');
      return;
    }

    const plugin = new ServerlessOfflineSQS(buildServerless(), {}, {log: silentLog});
    // Stub only the heavyweight serverless-offline lambda pool; the autoStart + autoCreate paths are
    // the real thing (real container, real @aws-sdk SQS client against the container). The poll-loop
    // handler is a no-op; a failing get() would only be logged via enqueueLoop, never thrown.
    const lambdaStub = {setEvent: () => {}, runHandler: () => Promise.resolve()};
    plugin.lambda = {get: () => lambdaStub, cleanup: () => Promise.resolve()};
    plugin._createLambda = () => Promise.resolve();

    await plugin.start();

    // Halt the event-queue poll loop so it cannot busy-loop against the container once it's torn
    // down, and so it never races the round-trip below. The autoCreate of both queues has already
    // happened during start(); pausing only stops further ReceiveMessage polling.
    plugin.sqs.queue.pause();

    // AC2: the endpoint was set to the autostarted container BEFORE any queue op.
    t.is(plugin.options.endpoint, `http://localhost:${TEST_PORT}`);
    // AC2: the container is actually running.
    t.true(await containerRunning(TEST_NAME));

    // AC3/AC10: the queues were created INSIDE the container, and a message round-trips through one.
    const client = new SQSClient({
      endpoint: `http://localhost:${TEST_PORT}`,
      region: 'eu-west-1',
      credentials: {accessKeyId: 'local', secretAccessKey: 'local'}
    });

    // AC10: the event-wired queue was autoCreated inside the container.
    const {QueueUrl: eventUrl} = await client.send(
      new GetQueueUrlCommand({QueueName: EVENT_QUEUE})
    );
    t.truthy(eventUrl);

    // AC3: a message round-trips through the (consumer-less) resource queue created in the container.
    const {QueueUrl} = await client.send(new GetQueueUrlCommand({QueueName: RT_QUEUE}));
    t.truthy(QueueUrl);

    await client.send(new SendMessageCommand({QueueUrl, MessageBody: 'hello-autostart'}));
    const received = await client.send(
      new ReceiveMessageCommand({QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 5})
    );
    t.is(received.Messages.length, 1);
    t.is(received.Messages[0].Body, 'hello-autostart');

    client.destroy();

    // AC4: end() stops + removes the container.
    await plugin.end(true); // skipExit so the test process survives
    t.false(await containerRunning(TEST_NAME));
  }
);
