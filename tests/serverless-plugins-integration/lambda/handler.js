module.exports.promise = (event, context) => {
  console.log('>> I am', process.env.WHOAMI);
  console.log(JSON.stringify(event, null, 4));
  return Promise.resolve();
};

module.exports.callback = (event, context, cb) => {
  console.log('>> I am', process.env.WHOAMI);
  console.log(JSON.stringify(event, null, 4));
  cb();
};
