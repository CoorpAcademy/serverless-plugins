const Minio = require('minio');
const {logWarning} = require('serverless-offline/dist/serverlessLog');
const S3EventDefinition = require('./s3-event-definition');
const S3Event = require('./s3-event');

class S3 {
  constructor(lambda, resources, options) {
    this.lambda = null;
    this.resources = null;
    this.options = null;

    this.lambda = lambda;
    this.resources = resources;
    this.options = options;

    this.client = new Minio.Client(this.options);
  }

  create(events) {
    return Promise.all(events.map(({functionKey, s3}) => this._create(functionKey, s3)));
  }

  _create(functionKey, rawS3EventDefinition) {
    const s3Event = new S3EventDefinition(rawS3EventDefinition);
    return this._s3Event(functionKey, s3Event);
  }

  _s3Event(functionKey, s3Event) {
    const {event, bucket} = s3Event;

    const job = () => {
      const listener = this.client.listenBucketNotification(bucket, '*', '*', [event]);
      listener.on('notification', async record => {
        if (record) {
          try {
            const lambdaFunction = this.lambda.get(functionKey);

            const s3Notification = new S3Event(record);
            lambdaFunction.setEvent(s3Notification);

            await lambdaFunction.runHandler();

            listener.stop();
          } catch (err) {
            logWarning(err.stack);
          }
        }
        job();
      });
    };
    job();
  }
}
module.exports = S3;
