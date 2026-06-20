const test = require('ava');
const ExtendDeploymentWithAccessLogs = require('../src');
const {
  sanitizeLogicalId,
  stageLogicalId,
  buildAccessLogSettings,
  buildLogGroupResource,
  mergeStageAccessLogs
} = require('../src');

const baseResources = {
  ApiGatewayRestApi: {Type: 'AWS::ApiGateway::RestApi', Properties: {Name: 'svc-dev'}},
  ApiGatewayDeployment123: {
    Type: 'AWS::ApiGateway::Deployment',
    Properties: {RestApiId: {Ref: 'ApiGatewayRestApi'}}
  }
};
const fixtureTemplate = (extra = {}) => ({
  Resources: {...baseResources, ...extra}
});
const mergeArgs = {
  restApiId: {Ref: 'ApiGatewayRestApi'},
  deploymentId: 'ApiGatewayDeployment123',
  logGroupLogicalId: 'CloudWatchLogsGroup',
  configuration: {format: 'F', 'log-group': '/g'}
};

// ---------------------------------------------------------------------------
// sanitizeLogicalId / stageLogicalId (#101 shaheer-k)
// ---------------------------------------------------------------------------
test('sanitizeLogicalId strips every non-alphanumeric character', t => {
  t.is(sanitizeLogicalId('ApiGatewayStage__unused_stage__'), 'ApiGatewayStageunusedstage');
});
test('sanitizeLogicalId always yields an alphanumeric-only id', t => {
  ['a-b', 'staging/v1', 'A__B', 'x.y.z'].forEach(input =>
    t.regex(sanitizeLogicalId(input), /^[A-Za-z0-9]+$/)
  );
});
test('stageLogicalId is the serverless-canonical ApiGatewayStage', t => {
  t.is(stageLogicalId(), 'ApiGatewayStage');
});

// ---------------------------------------------------------------------------
// buildAccessLogSettings / buildLogGroupResource
// ---------------------------------------------------------------------------
test('buildAccessLogSettings uses array-form Fn::GetAtt and maps stageTags', t => {
  t.deepEqual(buildAccessLogSettings({format: 'F', stageTags: {a: '1'}}, 'CloudWatchLogsGroup'), {
    AccessLogSetting: {Format: 'F', DestinationArn: {'Fn::GetAtt': ['CloudWatchLogsGroup', 'Arn']}},
    Tags: [{Key: 'a', Value: '1'}]
  });
});
test('buildAccessLogSettings defaults Tags to [] when no stageTags', t => {
  t.deepEqual(buildAccessLogSettings({format: 'F'}, 'CloudWatchLogsGroup').Tags, []);
});
test('buildLogGroupResource defaults retention to 7', t => {
  t.deepEqual(buildLogGroupResource({'log-group': '/g'}), {
    Type: 'AWS::Logs::LogGroup',
    Properties: {LogGroupName: '/g', RetentionInDays: 7}
  });
});
test('buildLogGroupResource honours log-group-retention', t => {
  const res = buildLogGroupResource({'log-group': '/g', 'log-group-retention': 14});
  t.is(res.Properties.RetentionInDays, 14);
  t.is(res.Properties.LogGroupName, '/g');
});

// ---------------------------------------------------------------------------
// mergeStageAccessLogs (#101 shaheer-k, #64 noanflaherty)
// ---------------------------------------------------------------------------
test('mergeStageAccessLogs never sets the __unused_stage__ sentinel on the Deployment (#101)', t => {
  const out = mergeStageAccessLogs(fixtureTemplate(), mergeArgs);
  t.not(out.Resources.ApiGatewayDeployment123.Properties.StageName, '__unused_stage__');
});
test('mergeStageAccessLogs emits an alphanumeric stage logical id (#101)', t => {
  const out = mergeStageAccessLogs(fixtureTemplate(), mergeArgs);
  const stageKey = Object.keys(out.Resources).find(
    k => out.Resources[k].Type === 'AWS::ApiGateway::Stage'
  );
  t.regex(stageKey, /^[A-Za-z0-9]+$/);
  t.truthy(out.Resources[stageKey].Properties.AccessLogSetting);
});
test('mergeStageAccessLogs merges into a pre-existing ApiGatewayStage without clobbering (#64)', t => {
  const template = fixtureTemplate({
    ApiGatewayStage: {
      Type: 'AWS::ApiGateway::Stage',
      Properties: {
        RestApiId: {Ref: 'ApiGatewayRestApi'},
        StageName: 'staging',
        Variables: {keep: 'me'},
        MethodSettings: [{HttpMethod: '*', ResourcePath: '/*'}]
      }
    }
  });
  const before = JSON.parse(JSON.stringify(template));
  const out = mergeStageAccessLogs(template, {
    ...mergeArgs,
    configuration: {format: 'F', 'log-group': '/g', stageTags: {env: 'prod'}}
  });
  t.deepEqual(out.Resources.ApiGatewayStage.Properties.Variables, {keep: 'me'});
  t.deepEqual(out.Resources.ApiGatewayStage.Properties.MethodSettings, [
    {HttpMethod: '*', ResourcePath: '/*'}
  ]);
  t.truthy(out.Resources.ApiGatewayStage.Properties.AccessLogSetting);
  t.deepEqual(template, before);
});
test('mergeStageAccessLogs is immutable and idempotent (#64)', t => {
  const template = Object.freeze(fixtureTemplate());
  const first = mergeStageAccessLogs(template, mergeArgs);
  const second = mergeStageAccessLogs(template, mergeArgs);
  t.notThrows(() => mergeStageAccessLogs(template, mergeArgs));
  t.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// thin-class wiring (regression: constructor validation preserved)
// ---------------------------------------------------------------------------
const serverlessWith = custom => ({
  getProvider: () => ({
    getApiGatewayRestApiId: () => ({Ref: 'ApiGatewayRestApi'}),
    getStage: () => 'dev'
  }),
  service: {custom}
});
test('default export is the plugin class and helpers are exported', t => {
  t.is(typeof ExtendDeploymentWithAccessLogs, 'function');
  [
    sanitizeLogicalId,
    stageLogicalId,
    buildAccessLogSettings,
    buildLogGroupResource,
    mergeStageAccessLogs
  ].forEach(fn => t.is(typeof fn, 'function'));
});
test('constructor throws when not configured', t => {
  t.throws(() => new ExtendDeploymentWithAccessLogs(serverlessWith(undefined), {}), {
    message: 'Plugin serverless-apigateway-access-logs must be configured'
  });
});
test('constructor throws on missing format', t => {
  t.throws(
    () =>
      new ExtendDeploymentWithAccessLogs(
        serverlessWith({'serverless-apigateway-access-logs': {'log-group': '/g'}}),
        {}
      ),
    {message: 'Plugin serverless-apigateway-access-logs must be configured: missing format'}
  );
});
test('constructor throws on missing log-group', t => {
  t.throws(
    () =>
      new ExtendDeploymentWithAccessLogs(
        serverlessWith({'serverless-apigateway-access-logs': {format: 'F'}}),
        {}
      ),
    {message: 'Plugin serverless-apigateway-access-logs must be configured: missing log-group'}
  );
});
