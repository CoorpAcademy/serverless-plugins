module.exports.handler = (event, context) => {
  console.log(JSON.stringify(event, null, 4));
  return Promise.resolve();
};
