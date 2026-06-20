const {isNil, omit, getOr} = require('lodash/fp');

const DEFAULT_EVENT_BUS = 'default';

// Normalizes a function's `eventBridge` event (a bare bus-name string, or an object carrying
// `eventBus` + `pattern`/`eventPattern`) into a stable shape: {eventBus, eventPattern, enabled, arn}.
// Untrusted Serverless config is guarded once here (the boundary) so the runtime backend only ever
// sees the clean shape. Raw keys are merged last via `omit` so they can never clobber computed fields.
class EventBridgeEventDefinition {
  constructor(rawEventBridgeEventDefinition, region, accountId) {
    let enabled;
    let eventBus;
    let eventPattern;

    switch ('string') {
      case typeof rawEventBridgeEventDefinition: {
        eventBus = rawEventBridgeEventDefinition;

        break;
      }
      default: {
        eventBus = getOr(DEFAULT_EVENT_BUS, 'eventBus', rawEventBridgeEventDefinition);
        eventPattern = getOr(
          getOr(undefined, 'eventPattern', rawEventBridgeEventDefinition),
          'pattern',
          rawEventBridgeEventDefinition
        );
        enabled = rawEventBridgeEventDefinition.enabled;
      }
    }

    this.enabled = isNil(enabled) ? true : enabled;
    this.eventBus = isNil(eventBus) ? DEFAULT_EVENT_BUS : eventBus;
    this.eventPattern = eventPattern;
    this.arn = `arn:aws:events:${region}:${accountId}:event-bus/${this.eventBus}`;

    if (typeof rawEventBridgeEventDefinition !== 'string') {
      Object.assign(
        this,
        omit(
          ['arn', 'eventBus', 'eventPattern', 'pattern', 'enabled'],
          rawEventBridgeEventDefinition
        )
      );
    }
  }
}

module.exports = EventBridgeEventDefinition;
module.exports.DEFAULT_EVENT_BUS = DEFAULT_EVENT_BUS;
