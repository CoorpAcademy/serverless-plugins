# serverless-offline-s3

This Serverless-offline plugin emulates AWS λ and S3 queue on your local machine. To do so, it listens S3 bucket events and invokes your handlers.

_Features_:

- [Serverless Webpack](https://github.com/serverless-heaven/serverless-webpack/) support.
- S3 configurations: batchsize.

## Installation

First, add `serverless-offline-s3` to your project:

```sh
npm install serverless-offline-s3
```

Then inside your project's `serverless.yml` file, add following entry to the plugins section before `serverless-offline` (and after `serverless-webpack` if presents): `serverless-offline-s3`.

```yml
plugins:
  - serverless-webpack
  - serverless-offline-s3
  - serverless-offline
```

[See example](../../tests/serverless-plugins-integration/README.md#s3)

## How it works?

To be able to emulate AWS S3 Bucket on local machine there should be some bucket system actually running. One of the existing implementations suitable for the task is [Minio](https://github.com/minio/minio).

[Minio](https://github.com/minio/minio) is a High Performance Object Storage released under Apache License v2.0. It is API compatible with Amazon S3 cloud storage service. Use MinIO to build high performance infrastructure for machine learning, analytics and application data workloads. See [example](../serverless-offline-s3-integration/docker-compose.yml) `s3` service setup.

We also need to setup actual buckets in Minio server, we can use [AWS cli](https://aws.amazon.com/cli/) tools for that. In example, we spawn-up another container with `aws-cli` pre-installed and run initialization script, against Minio server in separate container.

Once Minio is running and initialized, we can proceed with the configuration of the plugin.

Note that starting from version v3.1 of the plugin.

## Configure

### Functions

The configuration of function of the plugin follows the [serverless documentation](https://serverless.com/framework/docs/providers/aws/events/s3/).

```yml
functions:
  myS3Handler:
    handler: handler.compute
    events:
      - s3:
          bucket: myBucket
          event: s3:ObjectCreated:Put
```

### S3

The configuration of [`aws.S3`'s client](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#constructor-property) of the plugin is done by defining a `custom: serverless-offline-s3` object in your `serverless.yml` with your specific configuration.

[Minio](https://github.com/minio/minio) with the following configuration:

```yml
custom:
serverless-offline-s3:
  endpoint: http://0.0.0.0:9000
    region: eu-west-1
  accessKey: minioadmin
  secretKey: minioadmin
```
