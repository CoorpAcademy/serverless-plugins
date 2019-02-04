class ExtendDeploymentWithAccessLogs {
  constructor(serverless, options) {
    this.serverless = serverless
    this.hooks = {
      'before:aws:package:finalize:mergeCustomProviderResources': this.bindDeploymentId.bind(this)
    }
  }

  bindDeploymentId() {
    const template = this.serverless.service.provider.compiledCloudFormationTemplate

    // Find the deployment resource
    let deploymentId
    for (let key of Object.keys(template.Resources)) {
      const resource = template.Resources[key]
      if (resource.Type === 'AWS::ApiGateway::Deployment') {
        deploymentId = key
        console.log('YOLOLOLO')
        break
      }
    }
  }
}

module.exports = ExtendDeploymentWithAccessLogs; 