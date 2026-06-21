const test = require('ava');
const {v4: uuid} = require('uuid');
const {
  DynamoDBClient,
  BatchWriteItemCommand,
  CreateTableCommand,
  ListTablesCommand,
  ScanCommand
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBStreamsClient,
  DescribeStreamCommand,
  GetRecordsCommand,
  GetShardIteratorCommand
} = require('@aws-sdk/client-dynamodb-streams');
const {NodeHttpHandler} = require('@smithy/node-http-handler');
const DynamoDBStreamReadable = require('..');
const {buildCallbackClient} = require('../src/callback-adapter');

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

const CLIENT_CONFIG = {
  credentials: {accessKeyId: 'local', secretAccessKey: 'local'},
  endpoint: 'http://localhost:8000',
  region: 'eu-west-1',
  // #248 (aws-sdk v3): force HTTP/1.1 — DynamoDB Local does not speak the v3 client's default HTTP/2.
  requestHandler: new NodeHttpHandler(),
  // #248 (aws-sdk v3): the v3 client defaults to maxAttempts:3 with ~150ms total backoff and gives up
  // (ECONNRESET "socket hang up") before the cold DynamoDB Local JVM accepts connections — aws-sdk v2
  // tolerated this. CI runs `nyc ava` right after `docker-compose up -d`, so this test races the cold
  // emulator. A generous maxAttempts lets the very first request ride out the JVM's cold start.
  maxAttempts: 20
};

// #248 (aws-sdk v3): CI does `docker-compose up -d` then immediately `nyc ava`, so this suite races a
// cold DynamoDB Local that is not yet accepting connections. Poll ListTables (a cheap, side-effect-free
// call) until the emulator answers, so the per-test CreateTableCommand never hits a dead socket. Bounded
// by `attempts` so a genuinely down emulator still fails fast instead of hanging the suite.
const waitForDynamoDB = async (client, attempts = 60, intervalMs = 500) => {
  try {
    await client.send(new ListTablesCommand({}));
  } catch (err) {
    if (attempts <= 1) throw err;
    await delay(intervalMs);
    return waitForDynamoDB(client, attempts - 1, intervalMs);
  }
};

// #248 (aws-sdk v3): DynamoDBStreamReadable drives the streams client through the aws-sdk v2 callback
// contract; wrap the v3 client in the same promise->callback shim the plugin uses in production.
const DDB_STREAMS_READABLE_COMMANDS = {
  describeStream: DescribeStreamCommand,
  getShardIterator: GetShardIteratorCommand,
  getRecords: GetRecordsCommand
};

const batchWriteItem = (dynamodb, tableName, items) =>
  dynamodb.send(
    new BatchWriteItemCommand({
      RequestItems: {
        [tableName]: items.map(document => ({
          PutRequest: document
        }))
      }
    })
  );

test.before(async t => {
  t.context.dynamodb = new DynamoDBClient(CLIENT_CONFIG);
  // The raw v3 streams client (used by the readable through the callback shim below).
  t.context.dynamodbstreams = buildCallbackClient(
    new DynamoDBStreamsClient(CLIENT_CONFIG),
    DDB_STREAMS_READABLE_COMMANDS
  );
  // Tolerate a cold-started emulator: block until DynamoDB Local answers before any test runs.
  await waitForDynamoDB(t.context.dynamodb);
});

test.beforeEach(async t => {
  const {dynamodb} = t.context;

  const tableName = uuid();
  t.context.tableName = tableName;

  const table = await dynamodb.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        {
          AttributeName: 'Id',
          AttributeType: 'S'
        }
      ],
      KeySchema: [
        {
          AttributeName: 'Id',
          KeyType: 'HASH'
        }
      ],
      StreamSpecification: {
        StreamEnabled: true,
        StreamViewType: 'NEW_AND_OLD_IMAGES'
      },
      ProvisionedThroughput: {
        ReadCapacityUnits: 1,
        WriteCapacityUnits: 1
      }
    })
  );

  t.context.table = table;
});

test.serial('reads records that already exist', async t => {
  const {
    dynamodb,
    tableName,
    table: {
      TableDescription: {LatestStreamArn}
    },
    dynamodbstreams
  } = t.context;

  const documents = Array.from({length: 10}).map(() => ({
    Item: {
      Id: {
        S: uuid()
      }
    }
  }));

  await batchWriteItem(dynamodb, tableName, documents);

  const {Count, ScannedCount} = await dynamodb.send(
    new ScanCommand({
      TableName: tableName,
      Select: 'COUNT'
    })
  );
  t.deepEqual({Count, ScannedCount}, {Count: documents.length, ScannedCount: documents.length});

  const readable = DynamoDBStreamReadable(dynamodbstreams, LatestStreamArn, {readInterval: 1});

  return new Promise((resolve, reject) => {
    let count = 0;
    readable
      .on('data', recordSet => {
        recordSet.forEach(record => {
          t.deepEqual(record.dynamodb.Keys.Id, documents[count].Item.Id);
          count = count + 1;
        });
        if (count > documents.length) t.fail('should not read extra records');
        if (count === documents.length) readable.close();
      })
      .on('end', () => {
        t.deepEqual(count, documents.length, `read ${documents.length} records`);
        resolve();
      })
      .on('error', err => {
        t.fail('should not error');
        reject(err);
      });
  });
});

test.serial('reads ongoing records', t => {
  const {
    dynamodb,
    tableName,
    table: {
      TableDescription: {LatestStreamArn}
    },
    dynamodbstreams
  } = t.context;

  const documents = Array.from({length: 10}).map(() => ({
    Item: {
      Id: {
        S: uuid()
      }
    }
  }));

  const readable = DynamoDBStreamReadable(dynamodbstreams, LatestStreamArn, {readInterval: 1});

  let count = 0;
  return Promise.all([
    new Promise((resolve, reject) => {
      readable
        .on('data', function (recordSet) {
          recordSet.forEach(record => {
            t.deepEqual(record.dynamodb.Keys.Id, documents[count].Item.Id);
            count = count + 1;
          });
          if (count > documents.length) t.fail('should not read extra records');
          if (count === documents.length) readable.close();
        })
        .on('end', function () {
          t.deepEqual(count, documents.length, `read ${documents.length} records`);
          resolve();
        })
        .on('error', function (err) {
          t.fail('should not error');
          reject(err);
        });
    }),
    delay(100).then(() => batchWriteItem(dynamodb, tableName, documents))
  ]);
});

test.serial('reads latest records', async t => {
  const {
    dynamodb,
    tableName,
    table: {
      TableDescription: {LatestStreamArn}
    },
    dynamodbstreams
  } = t.context;

  const initialDocuments = Array.from({length: 10}).map(() => ({
    Item: {
      Id: {
        S: uuid()
      }
    }
  }));
  const subsequentDocuments = Array.from({length: 10}).map(() => ({
    Item: {
      Id: {
        S: uuid()
      }
    }
  }));

  await batchWriteItem(dynamodb, tableName, initialDocuments);

  const readable = DynamoDBStreamReadable(dynamodbstreams, LatestStreamArn, {
    iterator: 'LATEST',
    readInterval: 1
  });

  let count = 0;
  return Promise.all([
    new Promise((resolve, reject) => {
      readable
        .on('data', function (recordSet) {
          recordSet.forEach(record => {
            t.deepEqual(record.dynamodb.Keys.Id, subsequentDocuments[count].Item.Id);
            count = count + 1;
          });
          if (count > subsequentDocuments.length) t.fail('should not read extra records');
          if (count === subsequentDocuments.length) readable.close();
        })
        .on('end', function () {
          t.deepEqual(
            count,
            subsequentDocuments.length,
            `read ${subsequentDocuments.length} records`
          );
          resolve();
        })
        .on('error', function (err) {
          t.fail('should not error');
          reject(err);
        });
    }),
    delay(100).then(() => batchWriteItem(dynamodb, tableName, subsequentDocuments))
  ]);
});

test.serial('emits checkpoints, obeys limits', t => {
  const {
    dynamodb,
    tableName,
    table: {
      TableDescription: {LatestStreamArn}
    },
    dynamodbstreams
  } = t.context;

  const documents = Array.from({length: 10}).map(() => ({
    Item: {
      Id: {
        S: uuid()
      }
    }
  }));

  const readable = DynamoDBStreamReadable(dynamodbstreams, LatestStreamArn, {
    limit: 1,
    readInterval: 1
  });
  let count = 0;
  let checkpoints = 0;
  return Promise.all([
    new Promise((resolve, reject) => {
      readable
        .on('data', function (recordSet) {
          t.is(recordSet.length, 1, 'obeys requested limit');
          recordSet.forEach(record => {
            t.deepEqual(record.dynamodb.Keys.Id, documents[count].Item.Id);
            count = count + 1;
          });
          if (count > documents.length) t.fail('should not read extra records');
          if (count === documents.length) readable.close();
        })
        .on('checkpoint', function (sequenceNum) {
          if (typeof sequenceNum !== 'string') t.fail('invalid sequenceNum emitted');
          checkpoints = checkpoints + 1;
        })
        .on('end', function () {
          t.deepEqual(count, documents.length, `read ${documents.length} records`);
          resolve();
        })
        .on('error', function (err) {
          t.fail('should not error');
          reject(err);
        });
    }),
    batchWriteItem(dynamodb, tableName, documents)
  ]);
});

test.serial('reads after checkpoint', async t => {
  const {
    dynamodb,
    tableName,
    table: {
      TableDescription: {LatestStreamArn}
    },
    dynamodbstreams
  } = t.context;

  const documents = Array.from({length: 10}).map(() => ({
    Item: {
      Id: {
        S: uuid()
      }
    }
  }));

  await batchWriteItem(dynamodb, tableName, documents);

  let count = 0;
  const sequenceNum = await new Promise((resolve, reject) => {
    const readable = DynamoDBStreamReadable(dynamodbstreams, LatestStreamArn, {
      limit: 1,
      readInterval: 1
    });

    let lastSequenceNum;
    readable
      .on('data', recordSet => {
        recordSet.forEach(record => {
          t.deepEqual(record.dynamodb.Keys.Id, documents[count].Item.Id);
          count = count + 1;
        });
        if (count > documents.length) t.fail('should not read extra records');
        if (count === Math.ceil(documents.length / 2)) readable.close();
      })
      .on('checkpoint', currentSequenceNum => {
        lastSequenceNum = currentSequenceNum;
      })
      .on('end', () => {
        t.deepEqual(
          count,
          Math.ceil(documents.length / 2),
          `read ${Math.ceil(documents.length / 2)} records`
        );
        resolve(lastSequenceNum);
      })
      .on('error', err => {
        t.fail('should not error');
        reject(err);
      });
  });

  await new Promise((resolve, reject) => {
    const readable = DynamoDBStreamReadable(dynamodbstreams, LatestStreamArn, {
      limit: 1,
      startAfter: sequenceNum,
      readInterval: 1
    });

    readable
      .on('data', recordSet => {
        recordSet.forEach(record => {
          t.deepEqual(record.dynamodb.Keys.Id, documents[count].Item.Id);
          count = count + 1;
        });
        if (count > documents.length) t.fail('should not read extra records');
        if (count === documents.length) readable.close();
      })
      .on('end', () => {
        t.deepEqual(count, documents.length, `read ${documents.length} records`);
        resolve();
      })
      .on('error', err => {
        t.fail('should not error');
        reject(err);
      });
  });
});

test.serial('reads from checkpoint', async t => {
  const {
    dynamodb,
    tableName,
    table: {
      TableDescription: {LatestStreamArn}
    },
    dynamodbstreams
  } = t.context;

  const documents = Array.from({length: 10}).map(() => ({
    Item: {
      Id: {
        S: uuid()
      }
    }
  }));

  await batchWriteItem(dynamodb, tableName, documents);

  let count = 0;
  const sequenceNum = await new Promise((resolve, reject) => {
    const readable = DynamoDBStreamReadable(dynamodbstreams, LatestStreamArn, {
      limit: 1,
      readInterval: 1
    });

    let lastSequenceNum;
    readable
      .on('data', recordSet => {
        recordSet.forEach(record => {
          t.deepEqual(record.dynamodb.Keys.Id, documents[count].Item.Id);
          count = count + 1;
        });
        if (count > documents.length) t.fail('should not read extra records');
        if (count === Math.ceil(documents.length / 2)) readable.close();
      })
      .on('checkpoint', currentSequenceNum => {
        lastSequenceNum = currentSequenceNum;
      })
      .on('end', () => {
        t.deepEqual(
          count,
          Math.ceil(documents.length / 2),
          `read ${Math.ceil(documents.length / 2)} records`
        );
        resolve(lastSequenceNum);
      })
      .on('error', err => {
        t.fail('should not error');
        reject(err);
      });
  });

  count = count - 1;
  await new Promise((resolve, reject) => {
    const readable = DynamoDBStreamReadable(dynamodbstreams, LatestStreamArn, {
      limit: 1,
      startAt: sequenceNum,
      readInterval: 1
    });

    readable
      .on('data', recordSet => {
        recordSet.forEach(record => {
          t.deepEqual(record.dynamodb.Keys.Id, documents[count].Item.Id);
          count = count + 1;
        });
        if (count > documents.length) t.fail('should not read extra records');
        if (count === documents.length) readable.close();
      })
      .on('end', () => {
        t.deepEqual(count, documents.length, `read ${documents.length} records`);
        resolve();
      })
      .on('error', err => {
        t.fail('should not error');
        reject(err);
      });
  });
});
