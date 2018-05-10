// import Kinesis from 'aws-sdk/clients/kinesis';

// const kinesis = new Kinesis({
//   apiVersion: '2013-12-02',
//   endpoint: 'http://localhost:4567',
//   region: 'eu-west-1',
//   accessKeyId: 'foo',
//   secretAccessKey: 'foo'
// });

// kinesis.putRecord(
//   {
//     Data: JSON.stringify({
//       type: 'create',
//       payload: poll
//     }),
//     PartitionKey: id,
//     StreamName: 'polls'
//   },
//   (err, data) => {
//     console.log('create', {
//       err,
//       data
//     });
//     if (err) return callback(err);

//     callback(null, {
//       statusCode: 201,
//       body: JSON.stringify(poll)
//     });
//   }
// );

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
  // const body = JSON.parse(event.body);

  // const poll = body;

  // kinesis.putRecord(
  //   {
  //     Data: JSON.stringify({
  //       type: 'create',
  //       payload: poll
  //     }),
  //     PartitionKey: id,
  //     StreamName: 'polls'
  //   },
  //   (err, data) => {
  //     console.log('create', {
  //       err,
  //       data
  //     });
  //     if (err) return callback(err);

  //     callback(null, {
  //       statusCode: 201,
  //       body: JSON.stringify(poll)
  //     });
  //   }
  // );

  callback(null, {
    statusCode: 201,
    body: JSON.stringify(POLL)
  });
};

export const getPoll = (event, context, callback) => {
  // console.log(polls);
  // const id = event.pathParameters.id;
  // if (!polls.has(id))
  //   return callback(null, {
  //     statusCode: 404
  //   });
  return callback(null, {
    statusCode: 200,
    body: JSON.stringify(POLL)
  });
};

export const updatePoll = (event, context, callback) => {
  // const id = event.pathParameters.id;
  // if (!polls.has(id))
  //   return callback(null, {
  //     statusCode: 404
  //   });
  // const body = JSON.parse(event.body);
  // const poll = Object.assign({}, polls.get(id), body);
  // polls.set(id, poll);
  // kinesis.putRecord(
  //   {
  //     Data: JSON.stringify({
  //       type: 'update',
  //       payload: poll
  //     }),
  //     PartitionKey: id,
  //     StreamName: 'polls'
  //   },
  //   err => {
  //     if (err) return callback(err);
  //     callback(null, {
  //       statusCode: 201,
  //       body: JSON.stringify(poll)
  //     });
  //   }
  // );

  return callback(null, {
    statusCode: 200,
    body: JSON.stringify(POLL)
  });
};

export const removePoll = (event, context, callback) => {
  // const id = event.pathParameters.id;

  // if (!polls.has(id))
  //   return callback(null, {
  //     statusCode: 404
  //   });

  // polls.delete(id);

  // kinesis.putRecord(
  //   {
  //     Data: JSON.stringify({
  //       type: 'delete',
  //       payload: {
  //         id
  //       }
  //     }),
  //     PartitionKey: id,
  //     StreamName: 'polls'
  //   },
  //   err => {
  //     if (err) return callback(err);

  //     callback(null, {
  //       statusCode: 201
  //     });
  //   }
  // );

  return callback(null, {
    statusCode: 204
  });
};

export const aggregate = (event, context, callback) => {
  callback(null);
};
