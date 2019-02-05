class ExtendDeploymentWithAccessLogs {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.provider = this.serverless.getProvider('aws');
    console.log(serverless);
    this.hooks = {
      'before:aws:package:finalize:mergeCustomProviderResources': this.bindDeploymentId.bind(this)
    };
  }

  bindDeploymentId() {
    const template = this.serverless.service.provider.compiledCloudFormationTemplate;

    // Find the deployment resource and patch it
    for (const key of Object.keys(template.Resources)) {
      const resource = template.Resources[key];
      if (resource.Type === 'AWS::ApiGateway::Deployment') {
        const deploymentId = key;
        resource.Properties.StageName = '__unused_stage__';

        template.Resources.ApiGatewayStage = {
          Type: 'AWS::ApiGateway::Stage',
          DependsOn: [deploymentId],
          Properties: {
            RestApiId: this.provider.getApiGatewayRestApiId(),
            StageName: this.provider.getStage(),
            DeploymentId: {Ref: deploymentId},
            AccessLogSetting: {
              Format:
                '{"apptype":"api-product", "requestId":"$context.requestId", "ip": "$context.identity.sourceIp", "caller":"$context.identity.caller", "user":"$context.identity.user","requestTime":"$context.requestTime", "httpMethod":"$context.httpMethod","resourcePath":"$context.resourcePath", "status":"$context.status","protocol":"$context.protocol", "responseLength":"$context.responseLength" }',
              DestinationArn: {
                'Fn::GetAtt': 'CloudWatchLogsGroup.Arn'
              }
            }
          }
        };
      }
    }
  }
}

module.exports = ExtendDeploymentWithAccessLogs;
