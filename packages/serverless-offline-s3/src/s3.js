const Minio = require('minio');
const {assign, toNumber} = require('lodash/fp');

const log = require('@serverless/utils/log').log;

const S3EventDefinition = require('./s3-event-definition');
const S3Event = require('./s3-event');

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

class S3 {
  constructor(lambda, resources, options) {
    this.lambda = null;
    this.resources = null;
    this.options = null;

    this.lambda = lambda;
    this.resources = resources;
    this.options = options;

    const s3Endpoint = this.options.endpoint ? new URL(this.options.endpoint) : {};
    this.client = new Minio.Client(
      assign(this.options, {
        endPoint: s3Endpoint.hostname,
        port: s3Endpoint.port ? toNumber(s3Endpoint.port) : undefined,
        useSSL: s3Endpoint.protocol !== 'http:'
      })
    );

    this.events = [];
    this.listeners = [];
  }

  create(events) {
    this.events = events;
    return Promise.all(
      this.events.map(async ({s3}) => {
        const {bucket} = s3;
        await this._waitFor(bucket);
      })
    );
  }

  start() {
    return Promise.all(
      this.events.map(async ({functionKey, s3}) => {
        const {event, bucket, rules} = s3;
        await this._waitFor(bucket);

        const eventRules = rules || [];
        const prefix = (eventRules.find(rule => rule.prefix) || {prefix: '*'}).prefix;
        const suffix = (eventRules.find(rule => rule.suffix) || {suffix: '*'}).suffix;

        const listener = this.client.listenBucketNotification(bucket, prefix, suffix, [event]);

        listener.on('notification', async record => {
          if (record) {
            try {
              const lambdaFunction = this.lambda.get(functionKey);

              const s3Notification = new S3Event(record);
              lambdaFunction.setEvent(s3Notification);

              await lambdaFunction.runHandler();
            } catch (err) {
              log.warn(err.stack);
            }
          }
        });

        this.listeners = [...this.listeners, listener];
      })
    );
  }

  stop(timeout) {
    this.listeners.forEach(listener => listener.stop());
    this.listeners = [];
  }

  _create(functionKey, rawS3EventDefinition) {
    const s3Event = new S3EventDefinition(rawS3EventDefinition);
    return this._s3Event(functionKey, s3Event);
  }

  async _waitFor(bucket) {
    const exists = await this.client.bucketExists(bucket);
    if (exists) return;

    await delay(1000);
    return this._waitFor(bucket);
  }

  async _s3Event(functionKey, s3Event) {
    const {event, bucket, rules} = s3Event;
    await this._waitFor(bucket);

    const eventRules = rules || [];
    const prefix = (eventRules.find(rule => rule.prefix) || {prefix: '*'}).prefix;
    const suffix = (eventRules.find(rule => rule.suffix) || {suffix: '*'}).suffix;

    const listener = this.client.listenBucketNotification(bucket, prefix, suffix, [event]);

    listener.on('notification', async record => {
      if (record) {
        try {
          const lambdaFunction = this.lambda.get(functionKey);

          const s3Notification = new S3Event(record);
          lambdaFunction.setEvent(s3Notification);

          await lambdaFunction.runHandler();
        } catch (err) {
          log.warn(err.stack);
        }
      }
    });

    listener.stop();

    this.listeners.push(listener);
  }
}
module.exports = S3;
