const test = require('ava');
const {v4: uuid} = require('uuid');
const {
  DynamoDBClient,
  CreateTableCommand,
  BatchWriteItemCommand,
  ScanCommand
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBStreamsClient,
  DescribeStreamCommand,
  GetShardIteratorCommand,
  GetRecordsCommand
} = require('@aws-sdk/client-dynamodb-streams');
const DynamoDBStreamReadable = require('..');

// #248 (EdgarOrtegaRamirez): migrated the test off aws-sdk v2 to @aws-sdk v3. DynamoDBStreamReadable
// consumes the v2 *callback* contract (`client.getRecords(params, cb)`), so wrap the v3 streams
// client's promise-based `send(command)` back into that trio — the same adapter shape the consumer
// package ships in production.
const toCallbackStreamsClient = client => {
  const method = Command => (params, callback) =>
    client.send(new Command(params)).then(data => callback(null, data), callback);
  return {
    getShardIterator: method(GetShardIteratorCommand),
    describeStream: method(DescribeStreamCommand),
    getRecords: method(GetRecordsCommand)
  };
};

const LOCAL_CONFIG = {
  credentials: {accessKeyId: 'local', secretAccessKey: 'local'},
  endpoint: 'http://localhost:8000',
  region: 'eu-west-1'
};

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

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

test.before(t => {
  t.context.dynamodb = new DynamoDBClient(LOCAL_CONFIG);
  t.context.dynamodbstreams = toCallbackStreamsClient(new DynamoDBStreamsClient(LOCAL_CONFIG));
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
