const SQSClient = require('aws-sdk/clients/sqs');
// eslint-disable-next-line no-shadow
const {pipe, get, values, matches, find, mapValues, isPlainObject, toString} = require('lodash/fp');
const log = require('@serverless/utils/log.js').log;
const {default: PQueue} = require('p-queue');
const SQSEventDefinition = require('./sqs-event-definition');
const SQSEvent = require('./sqs-event');

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

class SQS {
  constructor(lambda, resources, options) {
    this.lambda = null;
    this.resources = null;
    this.options = null;

    this.lambda = lambda;
    this.resources = resources;
    this.options = options;

    this.client = new SQSClient(this.options);

    this.queue = new PQueue({autoStart: false});
  }

  create(events) {
    return Promise.all(events.map(({functionKey, sqs}) => this._create(functionKey, sqs)));
  }

  start() {
    this.queue.start();
  }

  stop(timeout) {
    this.queue.pause();
  }

  _create(functionKey, rawSqsEventDefinition) {
    const sqsEvent = new SQSEventDefinition(
      rawSqsEventDefinition,
      this.options.region,
      this.options.accountId
    );

    return this._sqsEvent(functionKey, sqsEvent);
  }

  _rewriteQueueUrl(queueUrl) {
    if (!this.options.endpoint) return queueUrl;

    const {hostname, protocol, username, password, port} = new URL(this.options.endpoint);
    const rewritedQueueUrl = new URL(queueUrl);
    rewritedQueueUrl.hostname = hostname;
    rewritedQueueUrl.protocol = protocol;
    rewritedQueueUrl.username = username;
    rewritedQueueUrl.password = password;
    rewritedQueueUrl.port = port;

    return rewritedQueueUrl.href;
  }

  async _getQueueUrl(queueName) {
    try {
      return await this.client.getQueueUrl({QueueName: queueName}).promise();
    } catch (err) {
      await delay(10000);
      return this._getQueueUrl(queueName);
    }
  }

  async _sqsEvent(functionKey, sqsEvent) {
    const {enabled, arn, queueName, batchSize} = sqsEvent;

    if (!enabled) return;

    if (this.options.autoCreate) await this._createQueue(sqsEvent);

    const QueueUrl = this._rewriteQueueUrl(
      (await this.client.getQueueUrl({QueueName: queueName}).promise()).QueueUrl
    );

    const job = async () => {
      const {Messages} = await this.client
        .receiveMessage({
          QueueUrl,
          MaxNumberOfMessages: batchSize,
          AttributeNames: ['All'],
          MessageAttributeNames: ['All'],
          WaitTimeSeconds: 5
        })
        .promise();

      if (Messages) {
        try {
          const lambdaFunction = this.lambda.get(functionKey);

          const event = new SQSEvent(Messages, this.region, arn);
          lambdaFunction.setEvent(event);

          await lambdaFunction.runHandler();

          await this.client
            .deleteMessageBatch({
              Entries: (Messages || []).map(({MessageId: Id, ReceiptHandle}) => ({
                Id,
                ReceiptHandle
              })),
              QueueUrl
            })
            .promise();
        } catch (err) {
          log.warning(err.stack);
        }
      }

      this.queue.add(job);
    };
    this.queue.add(job);
  }

  _getResourceProperties(queueName) {
    return pipe(
      values,
      find(matches({Properties: {QueueName: queueName}})),
      get('Properties')
    )(this.resources);
  }

  async _createQueue({queueName}, remainingTry = 5) {
    try {
      const properties = this._getResourceProperties(queueName);
      await this.client
        .createQueue({
          QueueName: queueName,
          Attributes: mapValues(
            value => (isPlainObject(value) ? JSON.stringify(value) : toString(value)),
            properties
          )
        })
        .promise();
    } catch (err) {
      if (remainingTry > 0 && err.name === 'AWS.SimpleQueueService.NonExistentQueue')
        return this._createQueue({queueName}, remainingTry - 1);
      log.warning(err.stack);
    }
  }
}

module.exports = SQS;
