const {randomUUID} = require('crypto');
const {getOr, isString} = require('lodash/fp');

// Accepts either PascalCase PutEvents `Entries[]` shape (Source/DetailType/Detail/...) or an
// already-lowercased envelope, and produces the canonical EventBridge event envelope delivered to
// the Lambda handler. `region` comes from the plugin options (the awsRegion-style regression-guard
// surface — built from this.options.region at the call site, never a bare/undefined this.region).
const buildEventBridgeEvent = (entry, region, busArn) => {
  const detailRaw = getOr(getOr({}, 'detail', entry), 'Detail', entry);
  const detail = isString(detailRaw) ? JSON.parse(detailRaw) : detailRaw;

  const resources = getOr(getOr([busArn], 'resources', entry), 'Resources', entry);

  return {
    version: '0',
    id: getOr(getOr(randomUUID(), 'id', entry), 'EventId', entry),
    'detail-type': getOr(getOr(undefined, 'detail-type', entry), 'DetailType', entry),
    source: getOr(getOr(undefined, 'source', entry), 'Source', entry),
    account: getOr(getOr(undefined, 'account', entry), 'Account', entry),
    time: getOr(getOr(new Date().toISOString(), 'time', entry), 'Time', entry),
    region,
    resources,
    detail
  };
};

class EventBridgeEvent {
  constructor(entry, region, busArn) {
    Object.assign(this, buildEventBridgeEvent(entry, region, busArn));
  }
}

module.exports = EventBridgeEvent;
module.exports.buildEventBridgeEvent = buildEventBridgeEvent;
