const {join} = require('path');
const figures = require('figures');
const SQS = require('aws-sdk/clients/sqs');
const {
  assignAll,
  filter,
  forEach,
  get,
  has,
  isEmpty,
  isUndefined,
  lowerFirst,
  map,
  mapKeys,
  mapValues,
  omitBy,
  pipe
} = require('lodash/fp');
const functionHelper = require('serverless-offline/src/functionHelper');
const LambdaContext = require('serverless-offline/src/LambdaContext');

const fromCallback = fun =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const printBlankLine = () => console.log();

const extractQueueNameFromARN = arn => {
  const [, , , , , QueueName] = arn.split(':');
  return QueueName;
};

class ServerlessOfflineSQS {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;

    this.commands = {};

    this.hooks = {
      'before:offline:start': this.offlineStartInit.bind(this),
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  getConfig() {
    return assignAll([
      omitBy(isUndefined, this.options),
      omitBy(isUndefined, this.service),
      omitBy(isUndefined, this.service.provider),
      omitBy(isUndefined, get(['custom', 'serverless-offline'], this.service)),
      omitBy(isUndefined, get(['custom', 'serverless-offline-sqs'], this.service))
    ]);
  }

  getClient() {
    return new SQS(this.getConfig());
  }

  getQueueName(queueEvent) {
    if (typeof queueEvent === 'string') return extractQueueNameFromARN(queueEvent);
    if (typeof queueEvent.arn === 'string') return extractQueueNameFromARN(queueEvent.arn);
    if (typeof queueEvent.queueName === 'string') return queueEvent.queueName;

    if (queueEvent.arn['Fn::GetAtt']) {
      const [ResourceName] = queueEvent.arn['Fn::GetAtt'];

      if (
        this.service &&
        this.service.resources &&
        this.service.resources.Resources &&
        this.service.resources.Resources[ResourceName] &&
        this.service.resources.Resources[ResourceName].Properties &&
        typeof this.service.resources.Resources[ResourceName].Properties.QueueName === 'string'
      )
        return this.service.resources.Resources[ResourceName].Properties.QueueName;
    }

    throw new Error(
      `QueueName not found. See https://github.com/CoorpAcademy/serverless-plugins/tree/master/packages/serverless-offline-sqs#functions`
    );
  }

  eventHandler(queueEvent, functionName, messages, cb) {
    if (!messages) return cb();

    const streamName = this.getQueueName(queueEvent);
    this.serverless.cli.log(`${streamName} (λ: ${functionName})`);

    const config = this.getConfig();
    const {location = '.'} = config;

    const __function = this.service.getFunction(functionName);

    const {env} = process;
    const functionEnv = assignAll([
      {AWS_REGION: get('service.provider.region', this)},
      env,
      get('service.provider.environment', this),
      get('environment', __function)
    ]);
    process.env = functionEnv;

    const serviceRuntime = this.service.provider.runtime;
    const servicePath = join(this.serverless.config.servicePath, location);

    const funOptions = functionHelper.getFunctionOptions(
      __function,
      functionName,
      servicePath,
      serviceRuntime
    );
    const handler = functionHelper.createHandler(funOptions, config);

    const lambdaContext = new LambdaContext(__function, this.service.provider, (err, data) => {
      this.serverless.cli.log(
        `[${err ? figures.cross : figures.tick}] ${functionName} ${JSON.stringify(data) || ''}`
      );
      cb(err, data);
    });

    const awsRegion = config.region || 'us-west-2';
    const awsAccountId = config.accountId || '000000000000';
    const eventSourceARN =
      typeof queueEvent.arn === 'string'
        ? queueEvent.arn
        : `arn:aws:sqs:${awsRegion}:${awsAccountId}:${streamName}`;

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
          messageAttributes: mapValues(mapKeys(lowerFirst), messageAttributes),
          md5OfBody,
          eventSource: 'aws:sqs',
          eventSourceARN,
          awsRegion
        })
      )
    };

    const x = handler(event, lambdaContext, lambdaContext.done);
    if (x && typeof x.then === 'function' && typeof x.catch === 'function')
      x.then(lambdaContext.succeed).catch(lambdaContext.fail);
    else if (x instanceof Error) lambdaContext.fail(x);

    process.env = env;
  }

  async createQueueReadable(functionName, queueEvent) {
    const client = this.getClient();
    const queueName = this.getQueueName(queueEvent);

    this.serverless.cli.log(`${queueName}`);

    if (this.getConfig().autoCreate) {
      const params = {QueueName: queueName};
      await fromCallback(cb => client.createQueue(params, cb));
    }

    const {QueueUrl} = await fromCallback(cb =>
      client.getQueueUrl(
        {
          QueueName: queueName
        },
        cb
      )
    );

    const next = async () => {
      const {Messages} = await fromCallback(cb =>
        client.receiveMessage(
          {
            QueueUrl,
            MaxNumberOfMessages: queueEvent.batchSize,
            AttributeNames: ['All'],
            MessageAttributeNames: ['All'],
            WaitTimeSeconds: 20
          },
          cb
        )
      );

      if (Messages) {
        try {
          await fromCallback(cb => this.eventHandler(queueEvent, functionName, Messages, cb));

          await fromCallback(cb =>
            client.deleteMessageBatch(
              {
                Entries: (Messages || []).map(({MessageId: Id, ReceiptHandle}) => ({
                  Id,
                  ReceiptHandle
                })),
                QueueUrl
              },
              () => cb()
            )
          );
        } catch (err) {
          this.serverless.cli.log(err.stack);
        }
      }

      next();
    };

    next();
  }

  offlineStartInit() {
    this.serverless.cli.log(`Starting Offline SQS.`);

    mapValues.convert({cap: false})((_function, functionName) => {
      const queues = pipe(
        get('events'),
        filter(has('sqs')),
        map(get('sqs'))
      )(_function);

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
