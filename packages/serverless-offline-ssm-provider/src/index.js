const fs = require('fs');
const {fromPairs, get, map, pipe, split, trim} = require('lodash/fp');

const fromCallback = fun => (...args) =>
  new Promise((resolve, reject) => {
    fun(...args, (err, data) => (err ? reject(err) : resolve(data)));
  });
const readFile = fromCallback(fs.readFile);

const getValues = (path = '.ssm') => {
  const values = (async () => {
    try {
      return pipe(
        trim,
        split('\n'),
        map(split(/=(.*)/)),
        fromPairs
      )(await readFile(path, {encoding: 'utf-8'}));
    } catch (err) {
      return null;
    }
  })();
  return key => values.then(get(key));
};

class ServerlessOfflineSSMProvider {
  constructor(serverless) {
    this.serverless = serverless;
    this.config = this.serverless.service.custom['serverless-offline-ssm-provider'];
    this.values = this.config ? getValues(this.config.file) : getValues();

    const aws = this.serverless.getProvider('aws');
    const request = aws.request.bind(aws);

    aws.request = (service, method, params, options) => {
      if (service !== 'SSM' || method !== 'getParameter')
        return request(service, method, params, options);

      return request(service, method, params, options).catch(async error => {
        const {Name} = params;
        const Value = await this.values(Name);

        if (!Value) throw error;

        return {
          Parameter: {
            Value
          }
        };
      });
    };

    this.serverless.setProvider('aws', aws);
  }
}

module.exports = ServerlessOfflineSSMProvider;
