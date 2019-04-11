# serverless-apigateway-access-logs

This Serverless-apigateway-access-logs plugin enables you to configure AWS API gateway access logs.

## Installation

First, add `serverless-apigateway-access-logs to your project:

```sh
npm install serverless-apigateway-access-logs
```

Then inside your project's `serverless.yml` file, add following entry to the plugins section

```yml
plugins:
  - serverless-apigateway-access-logs
```

[See example](./example/README.md)

## Configuration
Plugin need to be configured with a log group, and a format.
Log group just need a name, plugins takes care to ensure CloudWatchLogGroup creation.

To configure it, add something like the following to your `serverless.yml`.
```yml
custom:
  serverless-apigateway-access-logs:
    format: '{ "requestId":"$context.requestId", "ip": "$context.identity.sourceIp", "caller":"$context.identity.caller", "user":"$context.identity.user","requestTime":"$context.requestTime", "httpMethod":"$context.httpMethod","resourcePath":"$context.resourcePath", "status":"$context.status","protocol":"$context.protocol", "responseLength":"$context.responseLength" }'
    log-group: /aws/my-api/${self:provider.stage}/access-logs
    log-group-retention: 14 # optional, default to 7
```

You can also additionnaly add a `stageTags` mapping to have some tags attached to the API gateway stage.
