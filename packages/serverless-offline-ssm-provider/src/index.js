const fs = require('fs');

const getValues = (path = '.env') =>
  fs
    .readFileSync(path, {encoding: 'utf-8'})
    .trim()
    .split('\n')
    .map(line => line.split(/=(.*)/))
    .reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});

class ServerlessOfflineSSMProvider {
  constructor(serverless) {
    this.serverless = serverless;
    this.config = this.serverless.service.custom['serverless-offline-ssm-provider'];

    const aws = this.serverless.getProvider('aws');
    const request = aws.request.bind(aws);

    aws.request = (service, method, params, options) => {
      if (service !== 'SSM' || method !== 'getParameter')
        return request(service, method, params, options);

      return request(service, method, params, options).catch(error => {
        const {Name} = params;
        const Values = getValues(this.config.file);
        const Value = Values[Name];

        if (!Value) return Promise.reject(error);

        return Promise.resolve({
          Parameter: {
            Value
          }
        });
      });
    };

    this.serverless.setProvider('aws', aws);
  }
}

module.exports = ServerlessOfflineSSMProvider;
