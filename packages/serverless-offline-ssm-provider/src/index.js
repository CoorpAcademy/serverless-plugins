const fs = require('fs');
const {fromPairs, get, map, pipe, split, trim, bind} = require('lodash/fp');

const fromCallback =
  fun =>
  (...args) =>
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

const SSM_PREFIX = 'ssm:';

class ServerlessOfflineSSMProvider {
  constructor(serverless) {
    this.serverless = serverless;
    this.config = this.serverless.service.custom['serverless-offline-ssm-provider'];
    this.values = this.config ? getValues(this.config.file) : getValues();

    const delegate = bind(serverless.variables.getValueFromSource, serverless.variables);

    serverless.variables.getValueFromSource = async variableString => {
      if (!variableString.startsWith(SSM_PREFIX)) return delegate(variableString);

      const ssmPath = variableString.replace(SSM_PREFIX, '');
      const ssmValue = await this.values(ssmPath);

      if (!ssmValue) return delegate(variableString);

      return ssmValue;
    };
  }
}

module.exports = ServerlessOfflineSSMProvider;
