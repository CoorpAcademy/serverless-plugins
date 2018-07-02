import {promisify} from 'util';
import {DocumentClient} from 'aws-sdk/clients/dynamodb';
import test from 'ava';

const documentClient = new DocumentClient({
  apiVersion: '2012-08-10',
  endpoint: 'http://0.0.0.0:8000',
  region: 'eu-west-1',
  accessKeyId: 'undefined',
  secretAccessKey: 'undefined'
});

test('list table', async t => {
  const actual = await promisify(documentClient.put.bind(documentClient))({
    Item: {
      // Id: `${Date.now()}`,
      Id: `FOO`,
      Title: 'Foo'
    },
    // Expected: {
    //   Id: {
    //     Exists: false
    //   }
    // },
    TableName: 'polls',
    ReturnConsumedCapacity: 'TOTAL'
  });
  const expected = {};
  t.deepEqual(actual, expected);
});
