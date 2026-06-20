const SQSClient = require('aws-sdk/clients/sqs');

const {
  assign,
  chunk,
  clamp,
  endsWith,
  filter,
  find,
  flatMap,
  fromPairs,
  get,
  getOr,
  includes,
  isArray,
  isEmpty,
  isFinite,
  isNil,
  isPlainObject,
  mapValues,
  matches,
  omit,
  pick,
  pipe,
  toString,
  values
} = require('lodash/fp');
const {default: PQueue} = require('p-queue');
const {normalizeLog} = require('./log');
const SQSEventDefinition = require('./sqs-event-definition');
const SQSEvent = require('./sqs-event');

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

// #253 (flipscholtz): MessageId is not guaranteed unique within a batch and can exceed the 80-char
// `Id` limit. Derive the batch-entry Id from the array index so it is unique and short.
const toDeleteEntries = messages =>
  (messages || []).map(({ReceiptHandle}, index) => ({Id: String(index), ReceiptHandle}));

// #211 (mfamilia): allow custom.serverless-offline-sqs.queueName to override the event's queue name.
// Non-mutating: returns a new definition when the override is set, otherwise the input unchanged.
// `arn` is stripped so SQSEventDefinition's switch falls through to the queueName branch (it prefers
// `arn` over `queueName`) and rebuilds the ARN from the override — otherwise the override is ignored
// for every arn-bearing event shape. A string definition is first normalised to an object.
const resolveQueueName = (options, rawSqsEventDefinition) => {
  if (!(options && options.queueName)) return rawSqsEventDefinition;

  const base =
    typeof rawSqsEventDefinition === 'string'
      ? {arn: rawSqsEventDefinition}
      : rawSqsEventDefinition;

  return {...omit(['arn'], base), queueName: options.queueName};
};

// #225 (tomusiaka): only these CloudFormation Properties are valid SQS createQueue Attributes.
// Everything else (notably QueueName, and Tags which goes through the separate `tags` param) must
// NOT be sent as an Attribute, or AWS/sqslite reject the request with
// `InvalidAttributeName: Unknown Attribute QueueName`.
const SQS_ATTRIBUTE_KEYS = [
  'DelaySeconds',
  'MaximumMessageSize',
  'MessageRetentionPeriod',
  'Policy',
  'ReceiveMessageWaitTimeSeconds',
  'VisibilityTimeout',
  'RedrivePolicy',
  'RedriveAllowPolicy',
  'KmsMasterKeyId',
  'KmsDataKeyReusePeriodSeconds',
  'SqsManagedSseEnabled',
  'FifoQueue',
  'ContentBasedDeduplication',
  'DeduplicationScope',
  'FifoThroughputLimit'
];

const stringifyAttribute = value =>
  isPlainObject(value) ? JSON.stringify(value) : toString(value);

// #189/#159: a `.fifo`-suffixed queue is FIFO on AWS regardless of the CloudFormation flag, so infer
// FifoQueue from the name too (a resource that omits FifoQueue would otherwise be created standard
// and reject MessageGroupId).
const isFifoQueue = (queueName, properties) =>
  endsWith('.fifo', queueName) || properties.FifoQueue === true || properties.FifoQueue === 'true';

// CloudFormation `Tags` is a list of `{Key, Value}` pairs, but the SQS createQueue `tags` param is a
// flat `{key: value}` map — normalize the list form (a plain map is passed through unchanged).
const normalizeTags = tags => {
  if (isEmpty(tags)) return undefined;
  if (isArray(tags)) return fromPairs(tags.map(({Key, Value}) => [Key, Value]));
  return tags;
};

// toCreateQueueParams(queueName, properties) -> {QueueName, Attributes, tags?}
// Pure + non-mutating: builds the SQS createQueue params from a CloudFormation Queue Properties
// object, keeping only valid SQS attribute keys (stringified), routing Tags to the `tags` param,
// and forcing FifoQueue for `.fifo` names.
const toCreateQueueParams = (queueName, properties = {}) => {
  const picked = pick(SQS_ATTRIBUTE_KEYS, properties);
  const attributes = isFifoQueue(queueName, properties)
    ? assign(picked, {FifoQueue: true})
    : picked;
  const tags = normalizeTags(get('Tags', properties));

  return {
    ...(tags ? {tags} : {}),
    QueueName: queueName,
    Attributes: mapValues(stringifyAttribute, attributes)
  };
};

// SQS ReceiveMessage long-poll caps WaitTimeSeconds at 20, even though the serverless
// maximumBatchingWindow property accepts 0-300.
const SQS_MAX_WAIT_TIME_SECONDS = 20;

// #227 (tomusiaka): honor the event-level `maximumBatchingWindow` as the receiveMessage
// WaitTimeSeconds instead of a hard-coded 5. Clamp to the SQS long-poll range [0, 20]; fall back to
// the previous default when the option is absent or not a finite number (0 is honored, not falsy).
const resolveWaitTimeSeconds = (sqsEvent, defaultWaitTimeSeconds) =>
  isFinite(get('maximumBatchingWindow', sqsEvent))
    ? clamp(0, SQS_MAX_WAIT_TIME_SECONDS, sqsEvent.maximumBatchingWindow)
    : defaultWaitTimeSeconds;

// #221 (successkrisz): support SQS partial batch failure reporting. When the event mapping sets
// `functionResponseType: ReportBatchItemFailures`, the handler returns
// `{batchItemFailures: [{itemIdentifier: messageId}]}` and only the successes must be deleted so the
// rest are redriven. Pure + immutable: returns the subset of `messages` to delete.
//   - legacy mode (reportBatchItemFailures false): delete the whole batch (unchanged behavior)
//   - thrown handler (failed): delete nothing -> redrive the whole batch
//   - report mode: delete every message whose MessageId is NOT a reported itemIdentifier
//     (empty/absent batchItemFailures => full-batch success => delete all)
const partitionBatchForDeletion = (messages, {reportBatchItemFailures, result, failed} = {}) => {
  if (!reportBatchItemFailures) return messages || [];
  if (failed) return [];

  const failedIds = flatMap(
    item => (item && !isNil(item.itemIdentifier) ? [String(item.itemIdentifier)] : []),
    getOr([], 'batchItemFailures', result)
  );

  return filter(({MessageId}) => !includes(String(MessageId), failedIds), messages || []);
};

class SQS {
  constructor(lambda, resources, options, log) {
    this.lambda = null;
    this.resources = null;
    this.options = null;

    this.lambda = lambda;
    this.resources = resources;
    this.options = options;
    this.log = normalizeLog(log);

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
    const def = resolveQueueName(this.options, rawSqsEventDefinition);

    const sqsEvent = new SQSEventDefinition(def, this.options.region, this.options.accountId);

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
    const {enabled, arn, queueName, batchSize = 10, functionResponseType} = sqsEvent;

    if (!enabled) return;

    if (this.options.autoCreate) await this._createQueue(sqsEvent);

    const QueueUrl = this._rewriteQueueUrl(
      (await this.client.getQueueUrl({QueueName: queueName}).promise()).QueueUrl
    );

    // #227 (tomusiaka): use maximumBatchingWindow as the long-poll wait (default 5s) per queue.
    const WaitTimeSeconds = resolveWaitTimeSeconds(sqsEvent, 5);
    // #221 (successkrisz): only honor partial-batch-failure when the mapping opts in.
    const reportBatchItemFailures = functionResponseType === 'ReportBatchItemFailures';

    const getMessages = async (size, messages = []) => {
      if (size <= 0) return messages;

      const {Messages} = await this.client
        .receiveMessage({
          QueueUrl,
          MaxNumberOfMessages: size > 10 ? 10 : size,
          AttributeNames: ['All'],
          MessageAttributeNames: ['All'],
          WaitTimeSeconds
        })
        .promise();

      if (!Messages || Messages.length === 0) return messages;
      return getMessages(size - Messages.length, [...messages, ...Messages]);
    };

    const job = async () => {
      const messages = await getMessages(batchSize);

      if (messages.length > 0) {
        try {
          const lambdaFunction = this.lambda.get(functionKey);

          const event = new SQSEvent(messages, this.options.region, arn);
          lambdaFunction.setEvent(event);

          // #221 (successkrisz): capture the handler result so ReportBatchItemFailures can keep the
          // failed records for redrive. A thrown handler is caught below and deletes nothing.
          const result = await lambdaFunction.runHandler();

          const toDelete = partitionBatchForDeletion(messages, {reportBatchItemFailures, result});

          if (toDelete.length > 0) {
            await Promise.all(
              chunk(10, toDeleteEntries(toDelete)).map(Entries =>
                this.client
                  .deleteMessageBatch({
                    Entries,
                    QueueUrl
                  })
                  .promise()
              )
            );
          }
        } catch (err) {
          this.log.warning(err.stack);
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
      await this.client.createQueue(toCreateQueueParams(queueName, properties)).promise();
    } catch (err) {
      if (remainingTry > 0 && err.name === 'AWS.SimpleQueueService.NonExistentQueue')
        return this._createQueue({queueName}, remainingTry - 1);
      this.log.warning(err.stack);
    }
  }
}

module.exports = SQS;
module.exports.toDeleteEntries = toDeleteEntries;
module.exports.resolveQueueName = resolveQueueName;
module.exports.toCreateQueueParams = toCreateQueueParams;
module.exports.resolveWaitTimeSeconds = resolveWaitTimeSeconds;
module.exports.partitionBatchForDeletion = partitionBatchForDeletion;
