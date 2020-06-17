const {join} = require('path');
const figures = require('figures');
const Minio = require('minio');
const {
  assignAll,
  filter,
  forEach,
  get,
  getOr,
  has,
  isEmpty,
  isUndefined,
  mapValues,
  omitBy,
  pipe
} = require('lodash/fp');
const functionHelper = require('serverless-offline/src/functionHelper');
const LambdaContext = require('serverless-offline/src/LambdaContext');

const fromCallback = fun =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const printBlankLine = () => console.log();

class ServerlessOfflineS3 {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;

    this.commands = {};

    this.hooks = {
      'before:offline:start': this.offlineStartInit.bind(this),
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  getConfig() {
    return assignAll([
      omitBy(isUndefined, this.options),
      omitBy(isUndefined, this.service),
      omitBy(isUndefined, this.service.provider),
      omitBy(isUndefined, get(['custom', 'serverless-offline'], this.service)),
      omitBy(isUndefined, get(['custom', 'serverless-offline-s3'], this.service))
    ]);
  }

  getClient() {
    return new Minio.Client(this.getConfig());
  }

  getBucketName(S3Event) {
    const bucketName = getOr(null, ['s3', 'bucket'], S3Event);
    if (bucketName) return bucketName;
    return this.serverless.cli.log('bucket name not found');
  }

  eventHandler(functionName, Records, cb) {
    if (!Records) return cb();

    const config = this.getConfig();
    const {location = '.'} = config;

    const __function = this.service.getFunction(functionName);

    const {env} = process;
    const functionEnv = assignAll([
      {AWS_REGION: get('service.provider.region', this)},
      env,
      get('service.provider.environment', this),
      get('environment', __function)
    ]);
    process.env = functionEnv;

    const serviceRuntime = this.service.provider.runtime;
    const servicePath = join(this.serverless.config.servicePath, location);

    const funOptions = functionHelper.getFunctionOptions(
      __function,
      functionName,
      servicePath,
      serviceRuntime
    );
    const handler = functionHelper.createHandler(funOptions, config);

    const lambdaContext = new LambdaContext(__function, this.service.provider, (err, data) => {
      this.serverless.cli.log(
        `[${err ? figures.cross : figures.tick}] ${functionName} ${JSON.stringify(data) || ''}`
      );
      cb(err, data);
    });

    const event = {Records};

    const x = handler(event, lambdaContext, lambdaContext.done);
    if (x && typeof x.then === 'function' && typeof x.catch === 'function')
      x.then(lambdaContext.succeed).catch(lambdaContext.fail);
    else if (x instanceof Error) lambdaContext.fail(x);

    process.env = env;
  }

  createS3BucketReadable(functionName, S3Event) {
    const client = this.getClient();
    const bucketname = this.getBucketName(S3Event);

    const next = () => {
      const listener = client.listenBucketNotification(bucketname, '*', '*', [
        's3:ObjectCreated:Put'
      ]);
      listener.on('notification', async record => {
        if (record) {
          try {
            await fromCallback(cb => this.eventHandler(functionName, record, cb));
          } catch (err) {
            this.serverless.cli.log(err.stack);
          }
        }
        next();
      });
    };
    next();
  }

  offlineStartInit() {
    this.serverless.cli.log(`Starting Offline S3.`);

    mapValues.convert({cap: false})((_function, functionName) => {
      const S3 = pipe(get('events'), filter(has('s3')))(_function);

      if (!isEmpty(S3)) {
        printBlankLine();
        this.serverless.cli.log(`S3 for ${functionName}:`);
      }

      forEach(S3Event => {
        this.createS3BucketReadable(functionName, S3Event);
      }, S3);

      if (!isEmpty(S3)) {
        printBlankLine();
      }
    }, this.service.functions);
  }

  offlineStartEnd() {
    this.serverless.cli.log('offline-start-end');
  }
}

module.exports = ServerlessOfflineS3;
