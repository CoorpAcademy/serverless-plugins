const test = require('ava');

const ServerlessOfflineKinesis = require('../src');

const {extractStreamNameFromGetAtt} = ServerlessOfflineKinesis;

test('extractStreamNameFromGetAtt handles array Fn::GetAtt', t => {
  t.is(extractStreamNameFromGetAtt(['MyResource', 'Arn']), 'MyResource');
});
test('extractStreamNameFromGetAtt handles string Fn::GetAtt', t => {
  t.is(extractStreamNameFromGetAtt('MyResource.Arn'), 'MyResource');
});
test('extractStreamNameFromGetAtt throws on other cases', t => {
  t.throws(() => extractStreamNameFromGetAtt({MyResource: 'Arn'}));
});

const baseServerless = {
  service: {
    resources: {
      Resources: {
        TestStream: {
          Type: 'AWS::Kinesis::Stream',
          Properties: {
            Name: 'test-stream-dev'
          }
        }
      }
    }
  }
};

test('getStreamName handles a directly specified ARN', t => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  t.is(
    plugin.getStreamName('arn:aws:kinesis:us-east-1:123456789012:stream/TestStream'),
    'TestStream'
  );
});

test('getStreamName handles an object with a arn string property', t => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  t.is(
    plugin.getStreamName({
      arn: 'arn:aws:kinesis:us-east-1:123456789012:stream/TestStream'
    }),
    'TestStream'
  );
});

test('getStreamName handles an object with a streamName property', t => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  t.is(
    plugin.getStreamName({
      streamName: 'TestStream'
    }),
    'TestStream'
  );
});

test('getStreamName handles an object with an arn Fn::GetAtt lookup (array form)', t => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  t.is(
    plugin.getStreamName({
      arn: {
        'Fn::GetAtt': ['TestStream', 'Arn']
      }
    }),
    'test-stream-dev'
  );
});

test('getStreamName handles an object with an arn Fn::GetAtt lookup (string form)', t => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  t.is(
    plugin.getStreamName({
      arn: {
        'Fn::GetAtt': 'TestStream.Arn'
      }
    }),
    'test-stream-dev'
  );
});
test('getStreamName makes a naïve attempt to parse an arn Fn::Join lookup', t => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  t.is(
    plugin.getStreamName({
      arn: {
        'Fn::Join': [
          ':',
          [
            'arn',
            'aws',
            'kinesis',
            {Ref: 'AWS::Region'},
            {Ref: 'AWS::AccountId'},
            'stream/my-stream-dev'
          ]
        ]
      }
    }),
    'my-stream-dev'
  );
});
