const {get, getOr, has, set, toPairs, merge, find, keys} = require('lodash/fp');

// #101 (shaheer-k): old code set Deployment.Properties.StageName='__unused_stage__' -> CF auto-creates
// the implicit stage logical id ApiGatewayStage__unused_stage__ (non-alphanumeric) -> rejected with
// 'Resource name ... is non alphanumeric'. Never emit a sentinel.
const STAGE_LOGICAL_ID = 'ApiGatewayStage';
const LOG_GROUP_LOGICAL_ID = 'CloudWatchLogsGroup';
const stageLogicalId = () => STAGE_LOGICAL_ID;
const sanitizeLogicalId = name => String(name).replace(/[^0-9A-Za-z]/g, '');

// Array-form Fn::GetAtt mirrors serverless stage.js; Tags from stageTags.
const buildAccessLogSettings = (configuration, logGroupLogicalId) => ({
  AccessLogSetting: {
    Format: configuration.format,
    DestinationArn: {'Fn::GetAtt': [logGroupLogicalId, 'Arn']}
  },
  Tags: toPairs(getOr({}, 'stageTags', configuration)).map(([Key, Value]) => ({Key, Value}))
});

const buildLogGroupResource = configuration => ({
  Type: 'AWS::Logs::LogGroup',
  Properties: {
    LogGroupName: configuration['log-group'],
    RetentionInDays: getOr(7, 'log-group-retention', configuration)
  }
});

// #64 (noanflaherty): old code overwrote template.Resources.ApiGatewayStage -> collides with
// serverless' reserved stage logical id (naming.js getStageLogicalId()==='ApiGatewayStage') and,
// since osls creates the stage out-of-band via the SDK, declaring a fresh Stage asks CF to CREATE
// an already-existing stage. MERGE (immutable) instead; only synthesize when absent; leave the
// Deployment StageName alone.
const mergeStageAccessLogs = (
  template,
  {restApiId, deploymentId, logGroupLogicalId, configuration}
) => {
  const logicalId = sanitizeLogicalId(stageLogicalId());
  const existingStage = get(['Resources', logicalId], template);
  const accessLog = buildAccessLogSettings(configuration, logGroupLogicalId);
  const baseStage = existingStage || {
    Type: 'AWS::ApiGateway::Stage',
    DependsOn: [deploymentId],
    Properties: {RestApiId: restApiId, DeploymentId: {Ref: deploymentId}}
  };
  const mergedStage = merge(baseStage, {Properties: accessLog});
  return set(
    ['Resources', logicalId],
    mergedStage,
    set(['Resources', logGroupLogicalId], buildLogGroupResource(configuration), template)
  );
};

class ExtendDeploymentWithAccessLogs {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.provider = this.serverless.getProvider('aws');
    this.configuration = get('service.custom.serverless-apigateway-access-logs', serverless);
    if (!this.configuration)
      throw new Error('Plugin serverless-apigateway-access-logs must be configured');
    if (!has('format', this.configuration))
      throw new Error(
        'Plugin serverless-apigateway-access-logs must be configured: missing format'
      );
    if (!has('log-group', this.configuration))
      throw new Error(
        'Plugin serverless-apigateway-access-logs must be configured: missing log-group'
      );
    this.hooks = {
      'before:aws:package:finalize:mergeCustomProviderResources': this.bindDeploymentId.bind(this)
    };
  }

  bindDeploymentId() {
    const template = this.serverless.service.provider.compiledCloudFormationTemplate;
    const deploymentId = find(
      key => get(['Resources', key, 'Type'], template) === 'AWS::ApiGateway::Deployment',
      keys(template.Resources)
    );
    if (!deploymentId) return;
    this.serverless.service.provider.compiledCloudFormationTemplate = mergeStageAccessLogs(
      template,
      {
        restApiId: this.provider.getApiGatewayRestApiId(),
        deploymentId,
        logGroupLogicalId: LOG_GROUP_LOGICAL_ID,
        configuration: this.configuration
      }
    );
  }
}

module.exports = ExtendDeploymentWithAccessLogs;
module.exports.stageLogicalId = stageLogicalId;
module.exports.sanitizeLogicalId = sanitizeLogicalId;
module.exports.buildAccessLogSettings = buildAccessLogSettings;
module.exports.buildLogGroupResource = buildLogGroupResource;
module.exports.mergeStageAccessLogs = mergeStageAccessLogs;
// set/merge are immutable; find/keys replace the old forEach. Fresh stage omits StageName (no sentinel).
