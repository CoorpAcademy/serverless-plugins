# serverless-offline-ssm-provider

This Serverless-offline-ssm-provider fallback SSM resolution on your local machine. To do so, read specific file and extract values.

## Installation

First, add `serverless-offline-ssm-provider` to your project:

```sh
npm install serverless-offline-ssm-provider
```

Then inside your project's `serverless.yml` file, add following entry to the plugins section before `serverless-offline`: `serverless-offline-ssm-provider`.

```yml
plugins:
  - serverless-offline-ssm-provider
  - serverless-offline
```

## Configure

```yml
custom:
  serverless-offline-ssm-provider:
    file: .env
```
