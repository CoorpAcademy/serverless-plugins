const {join} = require('path');
const figures = require('figures');
const SQS = require('aws-sdk/clients/sqs');
const {mapValues, isEmpty, forEach, map, has, filter, get, pipe} = require('lodash/fp');
const {createHandler, getFunctionOptions} = require('serverless-offline/src/functionHelper');
const createLambdaContext = require('serverless-offline/src/createLambdaContext');

const fromCallback = fun =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const printBlankLine = () => console.log();

class ServerlessOfflineSQS {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.config = this.service.custom['serverless-offline-sqs'];

    this.commands = {};

    this.client = new SQS(this.config);

    this.hooks = {
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  getQueueName(queueEvent) {
    if (typeof queueEvent.arn === 'string') return queueEvent.arn.split('/')[1];

    if (queueEvent.arn['Fn::GetAtt']) {
      const [ResourceName] = queueEvent.arn['Fn::GetAtt'];

      return this.service.resources.Resources[ResourceName].Properties.QueueName;
    }

    throw new Error(`QueueName not found`);
  }

  eventHandler(queueEvent, functionName, messages, cb) {
    if (!messages) return cb();

    const streamName = this.getQueueName(queueEvent);
    this.serverless.cli.log(`${streamName} (λ: ${functionName})`);

    const {location = '.'} = this.service.custom['serverless-offline'];

    const __function = this.service.getFunction(functionName);
    const servicePath = join(this.serverless.config.servicePath, location);
    const funOptions = getFunctionOptions(__function, functionName, servicePath);
    const handler = createHandler(funOptions, {});

    const lambdaContext = createLambdaContext(__function, (err, data) => {
      this.serverless.cli.log(
        `[${err ? figures.cross : figures.tick}] ${JSON.stringify(data) || ''}`
      );
      cb(err, data);
    });

    const event = {
      Records: messages.map(
        ({
          MessageId: messageId,
          ReceiptHandle: receiptHandle,
          Body: body,
          Attributes: attributes,
          MessageAttributes: messageAttributes,
          MD5OfBody: md5OfBody
        }) => ({
          messageId,
          receiptHandle,
          body,
          attributes,
          messageAttributes,
          md5OfBody,
          eventSource: 'aws:sqs',
          eventSourceARN: queueEvent.arn,
          awsRegion: 'us-west-2'
        })
      )
    };

    handler(event, lambdaContext, lambdaContext.done);
  }

  async createQueueReadable(functionName, queueEvent) {
    const queueName = this.getQueueName(queueEvent);

    this.serverless.cli.log(`${queueName}`);

    const {QueueUrl} = await fromCallback(cb =>
      this.client.getQueueUrl(
        {
          QueueName: queueName
        },
        cb
      )
    );

    const next = async () => {
      const {Messages} = await fromCallback(cb =>
        this.client.receiveMessage(
          {
            QueueUrl,
            MaxNumberOfMessages: queueEvent.batchSize,
            WaitTimeSeconds: 1
          },
          cb
        )
      );

      await fromCallback(cb => this.eventHandler(queueEvent, functionName, Messages, cb));

      next();
    };

    next();
  }

  offlineStartInit() {
    this.serverless.cli.log(`Starting Offline Kinesis.`);

    mapValues.convert({cap: false})((_function, functionName) => {
      const queues = pipe(get('events'), filter(has('sqs')), map(get('sqs')))(_function);

      if (!isEmpty(queues)) {
        printBlankLine();
        this.serverless.cli.log(`SQS for ${functionName}:`);
      }

      forEach(queueEvent => {
        this.createQueueReadable(functionName, queueEvent);
      }, queues);

      if (!isEmpty(queues)) {
        printBlankLine();
      }
    }, this.service.functions);
  }

  offlineStartEnd() {
    this.serverless.cli.log('offline-start-end');
  }
}

module.exports = ServerlessOfflineSQS;
