const noop = () => {};

const defaultLog = {
  debug: noop,
  info: console.log.bind(console),
  notice: console.log.bind(console),
  warning: console.warn.bind(console),
  error: console.error.bind(console),
  success: console.log.bind(console)
};
const normalizeLog = log => ({...defaultLog, ...log});

module.exports = {defaultLog, normalizeLog};
