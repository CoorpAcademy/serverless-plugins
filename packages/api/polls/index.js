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
  callback(null, {
    statusCode: 201,
    body: JSON.stringify(POLL)
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
