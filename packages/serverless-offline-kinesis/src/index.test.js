const ServerlessOfflineKinesis = require('./index');
const { extractStreamNameFromGetAtt } = ServerlessOfflineKinesis;

test('extractStreamNameFromGetAtt handles array Fn::GetAtt', () => {
  expect(extractStreamNameFromGetAtt(['MyResource', 'Arn'])).toEqual('MyResource');
});
test('extractStreamNameFromGetAtt handles string Fn::GetAtt', () => {
  expect(extractStreamNameFromGetAtt('MyResource.Arn')).toEqual('MyResource');
});
test('extractStreamNameFromGetAtt throws on other cases', () => {
  expect(() => extractStreamNameFromGetAtt({ MyResource: 'Arn' })).toThrow();
});

const baseServerless = {
  service: {
    resources: {
      Resources: {
        TestStream: {
          Type: 'AWS::Kinesis::Stream',
          Properties: {
            Name: 'test-stream-dev'
          },
        },
      },
    },
  },
};

test('getStreamName handles a directly specified ARN', () => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  expect(plugin.getStreamName('arn:aws:kinesis:us-east-1:123456789012:stream/TestStream')).toEqual('TestStream');
})

test('getStreamName handles an object with a arn string property', () => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  expect(plugin.getStreamName({
    arn: 'arn:aws:kinesis:us-east-1:123456789012:stream/TestStream'
  })).toEqual('TestStream');
});

test('getStreamName handles an object with a streamName property', () => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  expect(plugin.getStreamName({
    streamName: 'TestStream',
  })).toEqual('TestStream');
});

test('getStreamName handles an object with an arn Fn::GetAtt lookup (array form)', () => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  expect(plugin.getStreamName({
    arn: {
      'Fn::GetAtt': ['TestStream', 'Arn'],
    }
  })).toEqual('test-stream-dev');
});

test('getStreamName handles an object with an arn Fn::GetAtt lookup (string form)', () => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  expect(plugin.getStreamName({
    arn: {
      'Fn::GetAtt': 'TestStream.Arn',
    }
  })).toEqual('test-stream-dev');
});
test('getStreamName makes a naïve attempt to parse an arn Fn::Join lookup', () => {
  const plugin = new ServerlessOfflineKinesis(baseServerless);
  expect(plugin.getStreamName({
    arn: {
      'Fn::Join': [
        ':',
        ['arn', 'aws', 'kinesis', { Ref: 'AWS::Region'}, { Ref: 'AWS::AccountId' }, 'stream/my-stream-dev']
      ]
    }
  })).toEqual('my-stream-dev');
});

