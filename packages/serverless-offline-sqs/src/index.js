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

const getConfig = (service, pluginName) => {
  return (service && service.custom && service.custom[pluginName]) || {};
};

const extractQueueNameFromARN = arn => {
  const [, , , , , QueueName] = arn.split(':');
  return QueueName;
};

class ServerlessOfflineSQS {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.config = getConfig(this.service, 'serverless-offline-sqs');

    this.commands = {};

    this.hooks = {
      'before:offline:start': this.offlineStartInit.bind(this),
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  getClient() {
    const awsConfig = Object.assign(
      {
        region: this.options.region || this.service.provider.region || 'us-west-2'
      },
      this.config
    );
    return new SQS(awsConfig);
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

    const {location = this.options.location || '.'} = getConfig(this.service, 'serverless-offline');

    const __function = this.service.getFunction(functionName);

    const {env} = process;
    const functionEnv = Object.assign(
      {},
      env,
      get('service.provider.environment', this),
      get('environment', __function)
    );
    process.env = functionEnv;

    const serviceRuntime = this.service.provider.runtime;
    const servicePath = join(this.serverless.config.servicePath, location);

    const funOptions = getFunctionOptions(__function, functionName, servicePath, serviceRuntime);
    const handler = createHandler(funOptions, Object.assign({}, this.options, this.config));

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

    if (handler.length < 3)
      handler(event, lambdaContext)
        .then(res => lambdaContext.done(null, res))
        .catch(lambdaContext.done);
    else handler(event, lambdaContext, lambdaContext.done);

    process.env = env;
  }

  async createQueueReadable(functionName, queueEvent) {
    const client = this.getClient();
    const queueName = this.getQueueName(queueEvent);

    this.serverless.cli.log(`${queueName}`);

    const params = {QueueName: queueName};
    await fromCallback(cb => client.createQueue(params, cb));

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
            WaitTimeSeconds: 1
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
