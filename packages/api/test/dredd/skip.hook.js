const {beforeEach} = require('hooks');

beforeEach(function(transaction) {
  const {statusCode} = transaction.expected;
  transaction.skip = !statusCode.toString().startsWith('2');
});
