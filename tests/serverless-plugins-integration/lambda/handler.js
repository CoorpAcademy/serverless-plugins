module.exports.promise = (event, context) => {
  console.log(JSON.stringify(event));
  return Promise.resolve();
};

module.exports.callback = (event, context, cb) => {
  console.log(JSON.stringify(event));
  cb();
};
