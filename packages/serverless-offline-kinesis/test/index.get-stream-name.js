const test = require('ava');
const ServerlessOfflineKinesis = require('../src');

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
test.beforeEach(t => {
  t.context.plugin = new ServerlessOfflineKinesis(baseServerless);
});

test('getStreamName handles a directly specified ARN', t => {
  const streamName = t.context.plugin.getStreamName(
    'arn:aws:kinesis:us-east-1:123456789012:stream/TestStream'
  );
  t.is(streamName, 'TestStream');
});

test('getStreamName handles an object with a arn string property', t => {
  const streamName = t.context.plugin.getStreamName({
    arn: 'arn:aws:kinesis:us-east-1:123456789012:stream/TestStream'
  });
  t.is(streamName, 'TestStream');
});

test('getStreamName handles an object with a streamName property', t => {
  const streamName = t.context.plugin.getStreamName({streamName: 'TestStream'});
  t.is(streamName, 'TestStream');
});

test('getStreamName handles an object with an arn Fn::GetAtt lookup (array form)', t => {
  const streamName = t.context.plugin.getStreamName({arn: {'Fn::GetAtt': ['TestStream', 'Arn']}});
  t.is(streamName, 'test-stream-dev');
});

test('getStreamName handles an object with an arn Fn::GetAtt lookup (string form)', t => {
  const streamName = t.context.plugin.getStreamName({arn: {'Fn::GetAtt': 'TestStream.Arn'}});
  t.is(streamName, 'test-stream-dev');
});
test('getStreamName makes a naïve attempt to parse an arn Fn::Join lookup', t => {
  const streamName = t.context.plugin.getStreamName({
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
  });
  t.is(streamName, 'my-stream-dev');
});
