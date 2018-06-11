import DynamoDB from 'aws-sdk/clients/dynamodb';

const dynamodb = new DynamoDB({
  apiVersion: '2013-12-02',
  endpoint: 'http://0.0.0.0:8000',
  region: 'eu-west-1',
  accessKeyId: 'undefined',
  secretAccessKey: 'undefined'
});

const POLL = {
  question: 'pariatur'
};

export const listPolls = (event, context, callback) => {
  callback(null, {
    statusCode: 200,
    body: JSON.stringify([POLL, POLL])
  });
};

export const createPoll = (event, context, callback) => {
  const body = JSON.parse(event.body);
  const poll = Object.assign(body, {
    id: `${Date.now()}`
  });
  const params = {
    Item: {
      Id: {
        S: poll.id
      },
      Question: {
        S: poll.question
      }
    },
    TableName: 'polls',
    ReturnConsumedCapacity: 'TOTAL'
  };
  dynamodb.putItem(params, function(err, data) {
    if (err) {
      console.log(err, err.stack); // an error occurred
      return callback(err);
    }

    console.log(data); // successful response
    return callback(null, {
      statusCode: 201,
      body: JSON.stringify(poll)
    });
  });
};

export const getPoll = (event, context, callback) => {
  return callback(null, {
    statusCode: 200,
    body: JSON.stringify(POLL)
  });
};

export const updatePoll = (event, context, callback) => {
  const body = JSON.parse(event.body);

  const poll = body;

  return callback(null, {
    statusCode: 200,
    body: JSON.stringify(poll)
  });
};

export const removePoll = (event, context, callback) => {
  return callback(null, {
    statusCode: 204
  });
};

export const aggregate = (event, context, callback) => {
  callback(null);
};
