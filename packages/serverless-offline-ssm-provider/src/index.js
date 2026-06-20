const {get, isEmpty} = require('lodash/fp');

const {normalizeLog} = require('./log');
const {resolveParameter, shouldExecute} = require('./ssm');

const CUSTOM_OPTION = 'serverless-offline-ssm';

class ServerlessOfflineSsmProvider {
  constructor(serverless, cliOptions, {log} = {}) {
    this.serverless = serverless;
    this.cliOptions = cliOptions || {};
    this.log = normalizeLog(log);

    const config = get(['service', 'custom', CUSTOM_OPTION], serverless) || {};

    const stages = this.cliOptions.ssmOfflineStages
      ? this.cliOptions.ssmOfflineStages.split(',')
      : config.stages;

    if (isEmpty(stages))
      throw new Error(
        'serverless-offline-ssm-provider: missing "custom.serverless-offline-ssm.stages"'
      );

    const stage = this.cliOptions.stage || get(['service', 'provider', 'stage'], serverless);
    this.ssmMap = config.ssm || {};

    if (shouldExecute(stages, stage)) this._patchAwsRequest();
  }

  _patchAwsRequest() {
    const aws = this.serverless.getProvider && this.serverless.getProvider('aws');
    if (!aws) return; // non-aws provider: no-op, never patch

    const original = aws.request.bind(aws);

    aws.request = (service, method, params, opts) => {
      // Pass through everything that is not an SSM getParameter (CF/S3/deploy calls).
      if (service !== 'SSM' || method !== 'getParameter')
        return original(service, method, params, opts);

      const hit = resolveParameter(this.ssmMap, params && params.Name);
      // Offline-stage miss => fall through to real AWS SSM (local map is an override layer, #152).
      if (!hit) return original(service, method, params, opts);

      this.log.debug(`[ssm-provider] resolved ${params.Name} locally as ${hit.Type}`);
      // #186: the synthetic Parameter MUST always carry a Type, or get-ssm.js throws.
      // The built-in resolver `await`s this, so a resolved promise matches its contract.
      return Promise.resolve({Parameter: {...params, Value: hit.Value, Type: hit.Type}});
    };

    this.serverless.setProvider('aws', aws);
    this.log.notice('serverless-offline-ssm-provider: resolving ssm locally for offline stage');
  }
}

module.exports = ServerlessOfflineSsmProvider;
