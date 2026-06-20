# dynamodb-streams-readable

Node.js stream interface for reading records from [AWS DynamoDB Streams](https://docs.aws.amazon.com/us_en/amazondynamodb/latest/developerguide/Streams.html).

## Usage

```js
var client = new AWS.DynamoDBStreams({
  region: 'us-east-1'
});

// see below for options
var readable = require('dynamodb-streams-readable')(client, options);

readable
  // 'data' events will trigger for a set of records in the stream
  .on('data', function(records) {
    console.log(records);
  })
  // each time a records are passed downstream, the 'checkpoint' event will provide
  // the last sequence number that has been read
  .on('checkpoint', function(sequenceNumber) {
    console.log(sequenceNumber);
  })
  .on('error', function(err) {
    console.error(err);
  })
  .on('end', function() {
    console.log('all done!');
  });

// Calling .close() will finish all pending GetRecord requests before emitting
// the 'end' event.
// Because the kinesis stream persists, the readable stream will not
// 'end' until you explicitly close it
setTimeout(function() {
  readable.close();
}, 60 * 60 * 1000);
```

## Options

You can pass options to create the readable stream, all parameters are optional:

```js
var options = {
  shardId: 'shard-identifier', // defaults to first shard in the stream
  iterator: 'LATEST', // default to TRIM_HORIZON
  startAfter: '12345678901234567890', // start reading after this sequence number
  startAt: '12345678901234567890', // start reading from this sequence number
  limit: 100, // number of records per `data` event
  readInterval: 500, // ms to wait between getRecords calls (default 500)
  maxIteratorRetries: 10, // bounded recoveries on a stale/expired iterator before surfacing an error
  log: undefined // optional logger ({warning, ...}); defaults to console
};
```

## Resilience

This readable keeps polling an **open** shard indefinitely — an empty `getRecords`
response with no `NextShardIterator` (as some local DynamoDB emulators return) no
longer ends the stream prematurely. The stream ends only when you call `.close()`.

A stale/expired/invalid shard iterator (`ResourceNotFoundException` "Invalid ShardId in
ShardIterator", `ExpiredIteratorException`, `TrimmedDataAccessException`) is recovered by
re-describing the stream for a fresh iterator, bounded by `maxIteratorRetries`; once that
budget is exhausted the original error is surfaced via the `error` event.

`.close()` is shutdown-safe: it stops scheduling polls and ends the stream without issuing
a brand-new `getRecords`, so no read fires against a shutting-down endpoint (e.g. on `SIGINT`).

When `shardId` is supplied but no matching shard exists, the factory surfaces a clear
`Shard <id> does not exist` error instead of silently falling back to the first shard.

> Note: against real AWS, a resharded stream returns `NextShardIterator=null` permanently on a
> sealed shard; this single-shard readable does not follow child shards — re-describe shards from
> the consumer to keep reading after a reshard.

Inspired by [@rclark's kinesis-readable](https://github.com/rclark/kinesis-readable).
