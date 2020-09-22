const test = require('ava');
const {v4: uuid} = require('uuid');
const DynamoDB = require('aws-sdk/clients/dynamodb');
const DynamoDBStreams = require('aws-sdk/clients/dynamodbstreams');
const DynamoDBStreamReadable = require('..');

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

const batchWriteItem = (dynamodb, tableName, items) =>
  dynamodb
    .batchWriteItem({
      RequestItems: {
        [tableName]: items.map(document => ({
          PutRequest: document
        }))
      }
    })
    .promise();

test.before(t => {
  t.context.dynamodb = new DynamoDB({
    accessKeyId: '-',
    secretAccessKey: '-',
    endpoint: 'http://localhost:8000',
    region: 'eu-west-1'
  });
  t.context.dynamodbstreams = new DynamoDBStreams({
    accessKeyId: '-',
    secretAccessKey: '-',
    endpoint: 'http://localhost:8000',
    region: 'eu-west-1'
  });
});

test.beforeEach(async t => {
  const {dynamodb} = t.context;

  const tableName = uuid();
  t.context.tableName = tableName;

  const table = await dynamodb
    .createTable({
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
    .promise();

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

  const documents = [...new Array(10)].map(() => ({
    Item: {
      Id: {
        S: uuid()
      }
    }
  }));

  await batchWriteItem(dynamodb, tableName, documents);

  t.deepEqual(
    await dynamodb
      .scan({
        TableName: tableName,
        Select: 'COUNT'
      })
      .promise(),
    {Count: documents.length, ScannedCount: documents.length}
  );

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

  const documents = [...new Array(10)].map(() => ({
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

  const initialDocuments = [...new Array(10)].map(() => ({
    Item: {
      Id: {
        S: uuid()
      }
    }
  }));
  const subsequentDocuments = [...new Array(10)].map(() => ({
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

  const documents = [...new Array(10)].map(() => ({
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

  const documents = [...new Array(10)].map(() => ({
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

  const documents = [...new Array(10)].map(() => ({
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
