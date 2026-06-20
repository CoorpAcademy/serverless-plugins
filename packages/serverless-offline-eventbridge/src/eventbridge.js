const http = require('http');
const {randomUUID} = require('crypto');
const SQSClient = require('aws-sdk/clients/sqs');

const {
  castArray,
  every,
  getOr,
  has,
  isArray,
  isNil,
  isPlainObject,
  some,
  toPairs
} = require('lodash/fp');

const {normalizeLog} = require('./log');
const EventBridgeEventDefinition = require('./eventbridge-event-definition');
const EventBridgeEvent = require('./eventbridge-event');
const {buildEventBridgeEvent} = require('./eventbridge-event');

const {DEFAULT_EVENT_BUS} = EventBridgeEventDefinition;

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

// ---------------------------------------------------------------------------
// EventPattern matching (pure)
//
// Adapted in spirit from rubenkaiser/serverless-offline-aws-eventbridge (MIT, see NOTICE),
// rewritten as pure immutable lodash/fp helpers. Two deliberate divergences from the reference:
//   - an unknown filter key returns `false` (non-match) instead of throwing, and
//   - `wildcard` and `cidr` are implemented.
// ---------------------------------------------------------------------------

// Flatten a pattern's `detail` object into [dotPath, filterArray] leaf pairs, so each leaf can be
// probed against the event with a single get. `$or` is preserved as a leaf (handled by the caller).
const flattenLeaves = (object, prefix = []) =>
  toPairs(object).reduce((acc, [key, value]) => {
    if (key === '$or') return [...acc, [[...prefix, key], value]];
    if (isPlainObject(value)) return [...acc, ...flattenLeaves(value, [...prefix, key])];
    return [...acc, [[...prefix, key], value]];
  }, []);

const wildcardToRegExp = pattern => {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, ch =>
    ch === '*' ? '.*' : `\\${ch}`
  );
  return new RegExp(`^${escaped}$`);
};

// IPv4 dotted-quad -> unsigned 32-bit integer (used by the `cidr` filter).
const ipToLong = ip => {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  return parts.reduce((acc, part) => {
    const n = Number(part);
    if (acc === null || !Number.isInteger(n) || n < 0 || n > 255) return null;
    return acc * 256 + n;
  }, 0);
};

const matchesCidr = (cidr, value) => {
  const [range, bitsRaw] = String(cidr).split('/');
  const bits = Number(bitsRaw);
  const base = ipToLong(range);
  const target = ipToLong(value);
  if (base === null || target === null || !Number.isInteger(bits) || bits < 0 || bits > 32)
    return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  const maskedBase = (base & mask) >>> 0;
  const maskedTarget = (target & mask) >>> 0;
  return maskedBase === maskedTarget;
};

// `{numeric: [">", 0, "<=", 100]}` — every [operator, operand] clause must hold.
const matchesNumeric = (clauses, value) => {
  const number = Number(value);
  if (Number.isNaN(number) || !isArray(clauses)) return false;
  return toPairs(clauses)
    .filter(([index]) => Number(index) % 2 === 0)
    .every(([index, operator]) => {
      const operand = Number(clauses[Number(index) + 1]);
      switch (operator) {
        case '=':
          return number === operand;
        case '>':
          return number > operand;
        case '>=':
          return number >= operand;
        case '<':
          return number < operand;
        case '<=':
          return number <= operand;
        default:
          return false;
      }
    });
};

// Leaf content filter: a scalar (exact equality) or a single-key filter object.
// `exists` is handled by the caller (it needs presence/absence, not the value).
const matchesFilter = (filter, value) => {
  if (!isPlainObject(filter)) return filter === value;

  const [[key, operand] = []] = toPairs(filter);

  switch (key) {
    case 'prefix': {
      if (isPlainObject(operand) && has('equals-ignore-case', operand))
        return String(value)
          .toLowerCase()
          .startsWith(String(operand['equals-ignore-case']).toLowerCase());
      return !isNil(value) && String(value).startsWith(String(operand));
    }
    case 'suffix':
      return !isNil(value) && String(value).endsWith(String(operand));
    case 'equals-ignore-case':
      return !isNil(value) && String(value).toLowerCase() === String(operand).toLowerCase();
    case 'anything-but': {
      // NOT equal / NOT in the set. A nested filter object (e.g. {prefix}) is negated too.
      const forbidden = castArray(operand);
      return !some(item => matchesFilter(item, value), forbidden);
    }
    case 'numeric':
      return matchesNumeric(operand, value);
    case 'wildcard':
      return !isNil(value) && wildcardToRegExp(operand).test(String(value));
    case 'cidr':
      return matchesCidr(operand, value);
    default:
      // Unknown filter -> non-match (divergence from the reference, which throws).
      return false;
  }
};

// Match an event field against a pattern field. The pattern field is an array of content filters
// (OR within the field). `{exists}` is resolved here against presence. When the event value is
// itself an array (e.g. `resources`), any element may satisfy the filter.
const matchesField = (filters, value, present) =>
  some(filter => {
    if (isPlainObject(filter) && has('exists', filter)) return Boolean(filter.exists) === present;
    if (isArray(value)) return some(item => matchesFilter(filter, item), value);
    return matchesFilter(filter, value);
  }, castArray(filters));

const ENVELOPE_KEYS = ['source', 'detail-type', 'account', 'region', 'resources'];

// `detail` is a nested object: flatten to dot-paths and require every leaf to match (AND across
// leaves), with `$or` branches handled recursively. `matchesPattern` is referenced (only ever called
// at runtime, after all consts are bound) so the mutual recursion through `$or` is safe.
const matchesDetail = (detailPattern, detail) => {
  if (!isPlainObject(detailPattern)) return false;

  return every(([path, filters]) => {
    if (path[path.length - 1] === '$or')
      return some(branch => matchesDetail(branch, detail), castArray(filters));

    const value = getOr(undefined, path, detail);
    return matchesField(filters, value, !isNil(value));
  }, flattenLeaves(detailPattern));
};

// matchesPattern(pattern, event) -> boolean. Every key in the pattern must match (AND across keys);
// each leaf is an OR across its filter array. `$or` is OR across its branch patterns, supported at
// the top level and within `detail`. Pure: never mutates `pattern` or `event`.
const matchesPattern = (pattern, event) => {
  if (!isPlainObject(pattern)) return false;

  return every(([key, value]) => {
    if (key === '$or') return some(branch => matchesPattern(branch, event), castArray(value));

    if (key === 'detail') return matchesDetail(value, getOr({}, 'detail', event));

    if (ENVELOPE_KEYS.includes(key)) {
      const fieldValue = getOr(undefined, key, event);
      return matchesField(value, fieldValue, !isNil(fieldValue));
    }

    // Unknown top-level key probed directly against the event.
    const fieldValue = getOr(undefined, [key], event);
    return matchesField(value, fieldValue, !isNil(fieldValue));
  }, toPairs(pattern));
};

// ---------------------------------------------------------------------------
// CloudFormation AWS::Events::Rule discovery (pure)
//
// The plugin honors rules declared in raw `resources.Resources` (an `AWS::Events::Rule` whose
// `Targets[].Arn` is `{Fn::GetAtt: [<FnLogicalId>, Arn]}`), mapping the target's logical id back to
// a function key. This is required because a rule can be wired purely in CloudFormation rather than
// as a function-level `eventBridge:` event.
// ---------------------------------------------------------------------------

// Resolve an EventBusName field (a plain string, or a Ref/Fn::GetAtt/Fn::ImportValue object) to a
// bus name. Unknown/unresolvable shapes fall back to the default bus.
const resolveEventBusName = busName => {
  if (isNil(busName)) return DEFAULT_EVENT_BUS;
  if (typeof busName === 'string') return busName;
  if (isPlainObject(busName)) {
    if (has('Ref', busName)) return busName.Ref;
    if (has('Fn::ImportValue', busName)) return String(busName['Fn::ImportValue']);
    if (has('Fn::GetAtt', busName)) return castArray(busName['Fn::GetAtt'])[0];
  }
  return DEFAULT_EVENT_BUS;
};

// Map a target Arn (`{Fn::GetAtt: [<FnLogicalId>, Arn]}`) to its logical id, or null when the
// target is not a lambda Fn::GetAtt reference.
const logicalIdFromTargetArn = arn => {
  if (isPlainObject(arn) && has('Fn::GetAtt', arn)) {
    const [logicalId, attribute] = castArray(arn['Fn::GetAtt']);
    if (attribute === 'Arn') return logicalId;
  }
  return null;
};

const subscriptionsFromResources = (resources, functionsByLogicalId = {}) =>
  toPairs(getOr({}, 'Resources', resources)).reduce((acc, [, resource]) => {
    if (getOr(undefined, 'Type', resource) !== 'AWS::Events::Rule') return acc;

    const eventPattern = getOr(undefined, ['Properties', 'EventPattern'], resource);
    const eventBus = resolveEventBusName(
      getOr(undefined, ['Properties', 'EventBusName'], resource)
    );
    const targets = getOr([], ['Properties', 'Targets'], resource);

    const subscriptions = targets.reduce((targetAcc, target) => {
      const logicalId = logicalIdFromTargetArn(getOr(undefined, 'Arn', target));
      if (isNil(logicalId)) return targetAcc;
      const functionKey = getOr(logicalId, logicalId, functionsByLogicalId);
      return [...targetAcc, {functionKey, eventPattern, eventBus}];
    }, []);

    return [...acc, ...subscriptions];
  }, []);

// ---------------------------------------------------------------------------
// PutEvents shaping (pure)
// ---------------------------------------------------------------------------

const entryToEvent = (entry, region, busArn) => buildEventBridgeEvent(entry, region, busArn);

const putEventsResponse = entries => ({
  Entries: (entries || []).map(() => ({EventId: randomUUID()})),
  FailedEntryCount: 0
});

// Parse a PutEvents request body, tolerating empty/malformed input.
const parsePutEventsBody = body => {
  try {
    const parsed = JSON.parse(body || '{}');
    return getOr([], 'Entries', parsed);
  } catch (err) {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Runtime backend (the thin I/O shell)
// ---------------------------------------------------------------------------

class EventBridge {
  constructor(lambda, options, log) {
    this.lambda = null;
    this.options = null;

    this.lambda = lambda;
    this.options = options;
    this.log = normalizeLog(log);

    this.subscriptions = [];
    this.server = null;
    this.pollTimer = null;
    this.sqsClient = null;
  }

  create(events) {
    const fromFunctionEvents = (events || []).map(({functionKey, destinations, eventBridge}) => {
      const def = new EventBridgeEventDefinition(
        eventBridge,
        this.options.region,
        this.options.accountId
      );
      return {
        functionKey,
        destinations,
        eventBus: def.eventBus,
        eventPattern: def.eventPattern,
        arn: def.arn,
        enabled: def.enabled
      };
    });

    const fromResources = subscriptionsFromResources(
      this.options.resources,
      this.options.functionsByLogicalId
    ).map(({functionKey, eventPattern, eventBus}) => ({
      functionKey,
      destinations: getOr(undefined, [functionKey], this.options.destinationsByFunction),
      eventBus,
      eventPattern,
      arn: `arn:aws:events:${this.options.region}:${this.options.accountId}:event-bus/${eventBus}`,
      enabled: true
    }));

    this.subscriptions = [...fromFunctionEvents, ...fromResources].filter(({enabled}) => enabled);

    this.log.debug('eventbridge subscriptions:', this.subscriptions);
  }

  start() {
    if (this.options.mockServer !== false) this._startServer();
    if (this.options.subscribe) this._startPolling();
  }

  async stop() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.server)
      await new Promise(resolve => {
        this.server.close(() => resolve());
      });
  }

  _startServer() {
    const {host = '127.0.0.1', port = 4010} = this.options;

    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const entries = parsePutEventsBody(Buffer.concat(chunks).toString('utf8'));
        try {
          await this.dispatch(entries);
        } catch (err) {
          this.log.warning(err.stack);
        }
        res.writeHead(200, {'Content-Type': 'application/x-amz-json-1.1'});
        res.end(JSON.stringify(putEventsResponse(entries)));
      });
    });

    this.server.listen(port, host);
    this.log.notice(`EventBridge PutEvents endpoint listening on http://${host}:${port}`);
  }

  // Fan a batch of PutEvents entries out to every matching subscriber. A target failure never fails
  // the PutEvents response (AWS PutEvents succeeds even if a downstream target throws).
  async dispatch(entries) {
    await Promise.all((entries || []).map(entry => this._dispatchEntry(entry)));
  }

  async _dispatchEntry(entry) {
    const event = entryToEvent(entry, this.options.region);

    await Promise.all(
      this.subscriptions
        .filter(({eventPattern}) => isNil(eventPattern) || matchesPattern(eventPattern, event))
        .map(subscription => this._invoke(subscription, event))
    );
  }

  _invoke(subscription, event) {
    const {functionKey, destinations} = subscription;
    const {maximumRetryAttempts = 10, retryDelayMs = 500} = this.options;

    const task = async remainingAttempts => {
      try {
        const lambdaFunction = this.lambda.get(functionKey);
        lambdaFunction.setEvent(new EventBridgeEvent(event, this.options.region));
        await lambdaFunction.runHandler();
      } catch (err) {
        this.log.warning(err.stack);
        if (remainingAttempts > 0) {
          await delay(retryDelayMs);
          return task(remainingAttempts - 1);
        }
        await this._onFailure(destinations, event, err);
      }
    };

    return task(maximumRetryAttempts - 1);
  }

  // onFailure (async-invoke DLQ): best-effort push of a failure record to the function's
  // `destinations.onFailure` SQS ARN. Gated behind `simulateDestinations` (default true), never
  // throws.
  async _onFailure(destinations, event, err) {
    if (this.options.simulateDestinations === false) return;

    const onFailure = getOr(undefined, ['onFailure'], destinations);
    const arn = isPlainObject(onFailure) ? getOr(undefined, 'arn', onFailure) : onFailure;
    if (isNil(arn)) return;

    try {
      if (!this.sqsClient) this.sqsClient = new SQSClient(this.options);
      const queueName = String(arn).split(':').pop();
      const {QueueUrl} = await this.sqsClient.getQueueUrl({QueueName: queueName}).promise();
      await this.sqsClient
        .sendMessage({
          QueueUrl,
          MessageBody: JSON.stringify({
            requestPayload: event,
            responsePayload: {errorMessage: err.message, errorType: err.name}
          })
        })
        .promise();
    } catch (dlqErr) {
      this.log.warning(dlqErr.stack);
    }
  }

  // Opt-in LocalStack poll loop placeholder: when `subscribe` is set, teams running a real `events`
  // bus at `options.endpoint` can provision/poll it. The in-process shim is the default path.
  _startPolling() {
    const {pollInterval = 1000} = this.options;
    const poll = () => {
      this.pollTimer = setTimeout(poll, pollInterval);
    };
    this.pollTimer = setTimeout(poll, pollInterval);
  }
}

module.exports = EventBridge;
module.exports.matchesPattern = matchesPattern;
module.exports.matchesFilter = matchesFilter;
module.exports.subscriptionsFromResources = subscriptionsFromResources;
module.exports.resolveEventBusName = resolveEventBusName;
module.exports.entryToEvent = entryToEvent;
module.exports.putEventsResponse = putEventsResponse;
module.exports.parsePutEventsBody = parsePutEventsBody;
