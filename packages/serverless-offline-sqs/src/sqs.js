const SQSClient = require('aws-sdk/clients/sqs');

const {
  assign,
  castArray,
  chunk,
  clamp,
  compact,
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
  isString,
  keyBy,
  map,
  mapValues,
  matches,
  omit,
  pick,
  pipe,
  reduce,
  split,
  toString,
  trim,
  uniq,
  values
} = require('lodash/fp');
const {default: PQueue} = require('p-queue');
const {normalizeLog} = require('./log');
const SQSEventDefinition = require('./sqs-event-definition');
const SQSEvent = require('./sqs-event');

const {extractQueueNameFromARN} = SQSEventDefinition;

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

// #262 (renanlido): a single SQS event may target MULTIPLE queues. The `queueName` (event-level
// or the custom.serverless-offline-sqs.queueName / --queueName override) may be:
//   - a scalar string            'orders'
//   - a comma-separated string   'orders, billing'   (CLI form: --queueName a,b)
//   - an array of either         ['orders', 'billing,audit']
// Normalize all of these into a de-duplicated, trimmed string[]. Anything falsy/empty -> [].
// Note: this is for *literal* queue names only; ARN strings are left to the SQSEventDefinition
// ARN-extraction path (#74/#200) and never reach here (see expandSqsEventDefinitions). Pure +
// non-throwing: castArray(undefined|null) yields a one-element array whose non-string member is
// dropped, so empty/nullish input resolves to [] without throwing.
const normalizeQueueNames = pipe(
  castArray,
  flatMap(name => (isString(name) ? split(',', name) : [])),
  map(trim),
  compact, // drop '' produced by trailing/double commas
  uniq
);

// #262 (renanlido): expand an SQS event definition into one definition per target queue, so an
// array / comma-separated `queueName` (event-level or via the --queueName override) becomes one
// independent SQSEventDefinition + poll loop per queue instead of a single malformed listener.
// Pure + non-mutating: returns a fresh array of definitions (one per resolved queue name).
//   - Override precedence and the #211 arn-strip contract are preserved: when options.queueName is
//     set it WINS and `arn`/`queueName` are stripped so SQSEventDefinition rebuilds the ARN from
//     the override.
//   - With NO override and NO literal event-level queueName (an ARN/intrinsic string or {arn}
//     object), the input is passed straight through as a single-element array so the existing
//     extractQueueNameFromARN/resolveCfnValue path (#74/#200) keeps owning name derivation.
const expandSqsEventDefinitions = (options, rawSqsEventDefinition) => {
  const overrideNames = normalizeQueueNames(get('queueName', options));

  if (!isEmpty(overrideNames)) {
    const base = isString(rawSqsEventDefinition)
      ? {}
      : omit(['arn', 'queueName'], rawSqsEventDefinition);
    return overrideNames.map(queueName => ({...base, queueName}));
  }

  // No override: only fan out a *literal* array/comma event-level queueName. An ARN string or an
  // {arn}/intrinsic object (no literal queueName) is passed straight through (single listener).
  const eventNames = isString(rawSqsEventDefinition)
    ? []
    : normalizeQueueNames(get('queueName', rawSqsEventDefinition));

  if (eventNames.length <= 1) return [rawSqsEventDefinition];

  const base = omit(['queueName'], rawSqsEventDefinition);
  return eventNames.map(queueName => ({...base, queueName}));
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

// #123 (zoellner) / agreed by esetnik: the global long-poll fallback used to be a hard-coded 5s and
// the only way to influence WaitTimeSeconds was the per-event maximumBatchingWindow (#227). A 20s
// long-poll against ElasticMQ/localstack produced the frequent 503s in #123 (bisected to 40efaf9),
// so the maintainer agreed to expose it as configuration with the 20s default debated down to ~15s.
// 15s is the thread compromise: long enough to keep poll churn (and the 503s) low, short enough to
// stay responsive.
const DEFAULT_WAIT_TIME_SECONDS = 15;

// #123 (zoellner): derive the plugin-level long-poll default from the merged options
// (custom.serverless-offline-sqs.waitTimeSeconds, or `pollingInterval` as an alias). Clamp to the
// SQS long-poll range [0, 20]; fall back to DEFAULT_WAIT_TIME_SECONDS when neither option is a finite
// number (0 is honored, not falsy — it means short-poll). `waitTimeSeconds` wins over the alias.
// Pure: reads only its argument, returns a number.
const resolveDefaultWaitTimeSeconds = options => {
  const configured = get('waitTimeSeconds', options);
  const value = isFinite(configured) ? configured : get('pollingInterval', options);
  return isFinite(value) ? clamp(0, SQS_MAX_WAIT_TIME_SECONDS, value) : DEFAULT_WAIT_TIME_SECONDS;
};

// #227 (tomusiaka): honor the event-level `maximumBatchingWindow` as the receiveMessage
// WaitTimeSeconds. Clamp to the SQS long-poll range [0, 20]; fall back to the supplied default
// (#123: now the options-derived plugin default, no longer a hard-coded 5) when the option is absent
// or not a finite number (0 is honored, not falsy).
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

// #65 (tclindner) / #133 (esetnik): autoCreate only ever created queues wired to a lambda event, so
// a dead-letter queue declared purely in resources.Resources — referenced only via another queue's
// RedrivePolicy.deadLetterTargetArn — was never created. collectQueueDefinitions scans EVERY
// AWS::SQS::Queue in the (already Fn::resolved) resources map and returns {queueName, properties}.
// Pure + non-mutating; the QueueName comes from Properties (the resource key is not the queue name).
const collectQueueDefinitions = (resources = {}) =>
  pipe(
    values,
    filter(matches({Type: 'AWS::SQS::Queue'})),
    map(resource => ({
      queueName: get(['Properties', 'QueueName'], resource),
      properties: get('Properties', resource) || {}
    })),
    filter(({queueName}) => !isNil(queueName))
  )(resources || {});

// #167 (jlippitt): a queue's Properties.RedrivePolicy.deadLetterTargetArn names the DLQ that must
// exist first. By the time SQS sees this.resources, index._resolveFn has flattened a Fn::GetAtt
// target into a resolved ARN string; reuse extractQueueNameFromARN so a resolved ARN yields the name
// and an unresolvable intrinsic (Fn::ImportValue, Ref) yields undefined (no throw) instead of a
// bogus target. Returns undefined when there is no RedrivePolicy/deadLetterTargetArn at all.
const extractDlqTargetName = (properties, region, accountId) => {
  const target = get(['RedrivePolicy', 'deadLetterTargetArn'], properties);
  if (isNil(target)) return undefined;
  return extractQueueNameFromARN(target, region, accountId);
};

// #133 (will-holley) / #167 (Zer0x00): createQueue against a RedrivePolicy fails with
// AWS.SimpleQueueService.NonExistentQueue unless the DLQ already exists, but create() fired every
// _create concurrently with an unordered Promise.all. orderQueuesForCreation topologically orders
// the creation set DLQ-first. Pure + immutable (no input mutation, no raw loops): a per-call
// `visiting` set bounds recursion so a self/cyclic reference cannot loop forever, an `emitted` set
// guarantees every input queue is emitted exactly once, and a target absent from the set is simply
// ignored (the referencing queue is still emitted). Stable for queues with no redrive relationship.
const orderQueuesForCreation = (queueDefs, region, accountId) => {
  const defs = queueDefs || [];
  const byName = keyBy('queueName', defs);

  const visit = (def, visiting, acc) => {
    if (acc.emitted.has(def.queueName)) return acc;
    if (visiting.has(def.queueName)) return acc; // cycle / self-reference guard

    const dlqName = extractDlqTargetName(def.properties, region, accountId);
    const dlqDef = dlqName && dlqName !== def.queueName ? byName[dlqName] : undefined;
    const afterDlq = dlqDef ? visit(dlqDef, new Set([...visiting, def.queueName]), acc) : acc;

    if (afterDlq.emitted.has(def.queueName)) return afterDlq;
    return {
      emitted: new Set([...afterDlq.emitted, def.queueName]),
      list: [...afterDlq.list, def]
    };
  };

  return reduce((acc, def) => visit(def, new Set(), acc), {emitted: new Set(), list: []}, defs)
    .list;
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

  async create(events) {
    const {region, accountId} = this.options;

    // #262 (renanlido): fan each event out into one (functionKey, def) per target queue (array /
    // comma-separated queueName, event-level or via the --queueName override) before creating; each
    // `def` is a fully-resolved single-queue definition.
    const definitions = flatMap(
      ({functionKey, sqs}) =>
        expandSqsEventDefinitions(this.options, sqs).map(def => ({functionKey, def})),
      events
    );

    // #65/#133/#167: when autoCreate is on, create EVERY declared queue — including a dead-letter
    // queue that lives only in resources.Resources and is referenced solely via another queue's
    // RedrivePolicy — and create them DLQ-first, sequentially, so createQueue does not reject with
    // AWS.SimpleQueueService.NonExistentQueue (the old unordered Promise.all race).
    if (this.options.autoCreate) {
      const resourceDefs = collectQueueDefinitions(this.resources);
      const resourceNames = new Set(map('queueName', resourceDefs));

      // Union in event-only queues — including every queue a multi-queue event fanned out to — so
      // the existing implicit-queue autoCreate keeps working; the defs are already fully resolved by
      // expandSqsEventDefinitions, so read each queueName directly. Dedupe so a queue declared BOTH
      // as a lambda event and a resource is created once, not twice.
      const eventDefs = pipe(
        map(({def}) => new SQSEventDefinition(def, region, accountId).queueName),
        filter(queueName => !isNil(queueName) && !resourceNames.has(queueName)),
        queueNames => [...new Set(queueNames)],
        map(queueName => ({queueName, properties: {}}))
      )(definitions);

      const ordered = orderQueuesForCreation([...resourceDefs, ...eventDefs], region, accountId);

      // sequential, DLQ-first (no Promise.all race); _createQueue is idempotent so the per-event
      // call below is a harmless no-op re-create.
      await reduce(
        (chain, {queueName}) => chain.then(() => this._createQueue({queueName})),
        Promise.resolve(),
        ordered
      );
    }

    return Promise.all(definitions.map(({functionKey, def}) => this._create(functionKey, def)));
  }

  start() {
    this.queue.start();
  }

  stop(timeout) {
    this.queue.pause();
  }

  _create(functionKey, def) {
    // #262 (renanlido): `def` is already a fully-resolved single-queue definition produced by
    // expandSqsEventDefinitions (override-wins + arn-strip handled there), so SQSEventDefinition
    // only ever sees one queue at a time.
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

    // #227 (tomusiaka): use the event-level maximumBatchingWindow as the long-poll wait per queue.
    // #123 (zoellner): when no event window is set, fall back to the configurable plugin-level
    // default (custom.serverless-offline-sqs.waitTimeSeconds / pollingInterval, default 15s) instead
    // of the old hard-coded 5s that left the long-poll behavior untunable.
    const WaitTimeSeconds = resolveWaitTimeSeconds(
      sqsEvent,
      resolveDefaultWaitTimeSeconds(this.options)
    );
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
module.exports.normalizeQueueNames = normalizeQueueNames;
module.exports.expandSqsEventDefinitions = expandSqsEventDefinitions;
module.exports.toCreateQueueParams = toCreateQueueParams;
module.exports.resolveWaitTimeSeconds = resolveWaitTimeSeconds;
module.exports.resolveDefaultWaitTimeSeconds = resolveDefaultWaitTimeSeconds;
module.exports.DEFAULT_WAIT_TIME_SECONDS = DEFAULT_WAIT_TIME_SECONDS;
module.exports.partitionBatchForDeletion = partitionBatchForDeletion;
module.exports.collectQueueDefinitions = collectQueueDefinitions;
module.exports.extractDlqTargetName = extractDlqTargetName;
module.exports.orderQueuesForCreation = orderQueuesForCreation;
