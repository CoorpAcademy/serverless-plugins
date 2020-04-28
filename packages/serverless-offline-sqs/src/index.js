const { join } = require("path");
const figures = require("figures");
const SQS = require("aws-sdk/clients/sqs");
const {
  assignAll,
  filter,
  compact,
  forEach,
  fromPairs,
  get,
  getOr,
  has,
  isEmpty,
  isUndefined,
  isPlainObject,
  keys,
  lowerFirst,
  map,
  mapKeys,
  mapValues,
  omit,
  omitBy,
  pipe,
  toPairs,
  values,
} = require("lodash/fp");

const fromCallback = (fun) =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const printBlankLine = () => console.log();

const extractQueueNameFromARN = (arn) => {
  const [, , , , , QueueName] = arn.split(":");
  return QueueName;
};

class ServerlessOfflineSQS {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;

    this.commands = {};

    this.hooks = {
      "before:offline:start": this.offlineStartInit.bind(this),
      "before:offline:start:init": this.offlineStartInit.bind(this),
      "before:offline:start:end": this.offlineStartEnd.bind(this),
    };

    this.serverlessOfflinePlugin = this.serverless.pluginManager.plugins.find(
      (plugin) => plugin.commands && plugin.commands.offline
    );

    if (!this.serverlessOfflinePlugin) {
      throw new Error("Missing serverless-offline plugin");
    }

    this.streams = [];
  }

  getConfig() {
    return assignAll([
      omitBy(isUndefined, this.options),
      omitBy(isUndefined, this.service),
      omitBy(isUndefined, this.service.provider),
      omitBy(isUndefined, get(["custom", "serverless-offline"], this.service)),
      omitBy(
        isUndefined,
        get(["custom", "serverless-offline-sqs"], this.service)
      ),
    ]);
  }

  getClient() {
    return new SQS(this.getConfig());
  }

  getProperties(queueEvent) {
    const getAtt = get(["arn", "Fn::GetAtt"], queueEvent);
    if (getAtt) {
      const [resourceName] = getAtt;
      const properties = get(
        ["resources", "Resources", resourceName, "Properties"],
        this.service
      );
      if (!properties)
        throw new Error(`No resource defined with name ${resourceName}`);
      return pipe(
        toPairs,
        map(([key, value]) => {
          if (!isPlainObject(value)) return [key, value.toString()];
          if (
            keys(value).some((k) => k === "Ref" || k.startsWith("Fn::")) ||
            values(value).some(isPlainObject)
          ) {
            return this.serverless.cli.log(
              `WARN ignore property '${key}' in config as it is some cloudformation reference: ${JSON.stringify(
                value
              )}`
            );
          }
          return [key, JSON.stringify(value)];
        }),
        compact,
        fromPairs
      )(properties);
    }
    return null;
  }

  getProperty(queueEvent, propertyName) {
    const properties = this.getProperties(queueEvent);
    return getOr(null, propertyName, properties);
  }

  getQueueName(queueEvent) {
    if (typeof queueEvent === "string")
      return extractQueueNameFromARN(queueEvent);
    if (typeof queueEvent.arn === "string")
      return extractQueueNameFromARN(queueEvent.arn);
    if (typeof queueEvent.queueName === "string") return queueEvent.queueName;

    const queueName = this.getProperty(queueEvent, "QueueName");
    if (!queueName)
      throw new Error(
        `QueueName not found. See https://github.com/CoorpAcademy/serverless-plugins/tree/master/packages/serverless-offline-sqs#functions`
      );
    return queueName;
  }

  async eventHandler(queueEvent, functionName, messages) {
    if (!messages) return;

    const streamName = this.getQueueName(queueEvent);
    this.serverless.cli.log(`${streamName} (λ: ${functionName})`);

    const config = this.getConfig();

    const awsRegion = config.region || "us-west-2";
    const awsAccountId = config.accountId || "000000000000";
    const eventSourceARN =
      typeof queueEvent.arn === "string"
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
          MD5OfBody: md5OfBody,
        }) => ({
          messageId,
          receiptHandle,
          body,
          attributes,
          messageAttributes: mapValues(mapKeys(lowerFirst), messageAttributes),
          md5OfBody,
          eventSource: "aws:sqs",
          eventSourceARN,
          awsRegion,
        })
      ),
    };

    const lambdaFunction = this.getLambdaFunction(functionName);
    lambdaFunction.setEvent(event);
    await lambdaFunction.runHandler();
  }

  getLambdaFunction(functionName) {
    // TODO: Find a better way to hook into serverless-offline Lambda
    const lambda = this.serverlessOfflinePlugin.__private_5_lambda;
    const lambdaFunction = lambda.get(functionName);
    return lambdaFunction;
  }

  async createQueueReadable(functionName, queueEvent) {
    const client = this.getClient();
    const QueueName = this.getQueueName(queueEvent);

    this.serverless.cli.log(`${QueueName}`);

    if (this.getConfig().autoCreate) {
      const properties = this.getProperties(queueEvent);
      const params = { QueueName, Attributes: omit(["QueueName"], properties) };
      await fromCallback((cb) => client.createQueue(params, cb));
    }

    const { QueueUrl } = await fromCallback((cb) =>
      client.getQueueUrl({ QueueName }, cb)
    );

    const next = async () => {
      const { Messages } = await fromCallback((cb) =>
        client.receiveMessage(
          {
            QueueUrl,
            MaxNumberOfMessages: queueEvent.batchSize,
            AttributeNames: ["All"],
            MessageAttributeNames: ["All"],
            WaitTimeSeconds: 20,
          },
          cb
        )
      );

      if (Messages) {
        try {
          await this.eventHandler(queueEvent, functionName, Messages);

          await fromCallback((cb) =>
            client.deleteMessageBatch(
              {
                Entries: (Messages || []).map(
                  ({ MessageId: Id, ReceiptHandle }) => ({
                    Id,
                    ReceiptHandle,
                  })
                ),
                QueueUrl,
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

    mapValues.convert({ cap: false })((_function, functionName) => {
      const queues = pipe(
        get("events"),
        filter(has("sqs")),
        map(get("sqs"))
      )(_function);

      if (!isEmpty(queues)) {
        printBlankLine();
        this.serverless.cli.log(`SQS for ${functionName}:`);
      }

      forEach((queueEvent) => {
        this.createQueueReadable(functionName, queueEvent);
      }, queues);

      if (!isEmpty(queues)) {
        printBlankLine();
      }
    }, this.service.functions);
  }

  offlineStartEnd() {
    this.serverless.cli.log("offline-start-end");
  }
}

module.exports = ServerlessOfflineSQS;
