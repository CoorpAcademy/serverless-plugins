module.exports.handler = (event, context) => {
  // Print the whole event
  // console.log(JSON.stringify(event, null, 4));

  // Print only the record data
  console.log(
    event.Records &&
      event.Records.map(record => {
        return Buffer.from(record.kinesis.data, 'base64').toString('utf8');
      })
  );
  return Promise.resolve();
};
