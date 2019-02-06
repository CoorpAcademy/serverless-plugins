const _ = require('lodash/fp');

class ExtendDeploymentWithAccessLogs {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.provider = this.serverless.getProvider('aws');

    this.configuration = _.get('service.custom.serverless-apigateway-access-logs', serverless);
    if (!this.configuration)
      throw new Error('Plugin serverless-apigateway-access-logs must be configured');
    if (!_.has('format', this.configuration))
      throw new Error(
        'Plugin serverless-apigateway-access-logs must be configured: missing format'
      );
    if (!_.has('log-group', this.configuration))
      throw new Error(
        'Plugin serverless-apigateway-access-logs must be configured: missing log-group'
      );
    this.hooks = {
      'before:aws:package:finalize:mergeCustomProviderResources': this.bindDeploymentId.bind(this)
    };
  }

  bindDeploymentId() {
    const template = this.serverless.service.provider.compiledCloudFormationTemplate;

    // Find the deployment resource and patch it
    Object.keys(template.Resources).forEach(key => {
      const resource = template.Resources[key];
      if (resource.Type === 'AWS::ApiGateway::Deployment') {
        const deploymentId = key;
        resource.Properties.StageName = '__unused_stage__';

        template.Resources.CloudWatchLogsGroup = {
          Type: 'AWS::Logs::LogGroup',
          Properties: {
            LogGroupName: this.configuration['log-group'],
            RetentionInDays: this.configuration['log-group-retention'] || 7
          }
        };
        template.Resources.ApiGatewayStage = {
          Type: 'AWS::ApiGateway::Stage',
          DependsOn: [deploymentId],
          Properties: {
            RestApiId: this.provider.getApiGatewayRestApiId(),
            StageName: this.provider.getStage(),
            DeploymentId: {Ref: deploymentId},
            AccessLogSetting: {
              Format: this.configuration.format,
              DestinationArn: {
                'Fn::GetAtt': 'CloudWatchLogsGroup.Arn'
              }
            }
          }
        };
      }
    });
  }
}

module.exports = ExtendDeploymentWithAccessLogs;
