const http = require('http');
const {SQS} = require('aws-sdk');
const {delay, runOfflineTest} = require('./utils');

// #132: assert that an HTTP route and an SQS listener BOTH register and fire in the SAME
// `serverless offline` run. Before the fix, the plugin registered a bare `offline:start` hook that
// competed with serverless-offline's own start path, so only one side wired up (the reported
// symptom: "only the SQS lambda works"). Augmenting via init/ready/end only, both must respond.

const client = new SQS({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:9324'
});

const S = 'serverless-offline-sqs-http-dev';
// serverless-offline strips the stage from a REST `http` event's `event.path`, so the proxy event
// carries `/ping` (not `/dev/ping`); the GET below still targets the stage-prefixed URL.
const EXPECTED_KEYS = [`${S}-myHttpHandler http:/ping`, `${S}-mySqsHandler sqs:CoFunctionQueue`];

const httpGet = url =>
  new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      res.resume(); // drain the body so the socket frees up
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });

const triggerBoth = async () => {
  await delay(1000);
  await Promise.all([
    // HTTP route: serverless-offline serves http events under /<stage>/<path>; stage defaults to dev.
    httpGet('http://localhost:3336/dev/ping'),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/CoFunctionQueue',
        MessageBody: 'CoFunctionMessage'
      })
      .promise()
  ]);
};

runOfflineTest({
  config: 'serverless.sqs-http.yml',
  label: 'test-sqs-http',
  expectedKeys: EXPECTED_KEYS,
  // wait for the SQS banner: it is the LAST subsystem to come up, so once it logs both the HTTP
  // server (serverless-offline) and the SQS poller (this plugin) are registered in the same run.
  readyPattern: /Starting Offline SQS/,
  onReady: triggerBoth
});
