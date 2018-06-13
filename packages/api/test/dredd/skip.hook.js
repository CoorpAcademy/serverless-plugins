const {beforeEach} = require('hooks');

beforeEach(function(transaction) {
  const {method} = transaction.request;
  const {statusCode} = transaction.expected;
  transaction.skip = !['GET'].includes(method) || !statusCode.startsWith('2');
});
