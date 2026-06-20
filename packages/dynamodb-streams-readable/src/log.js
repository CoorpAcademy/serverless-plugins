const noop = () => {};

const defaultLog = {
  debug: noop,
  info: console.log.bind(console),
  notice: console.log.bind(console),
  warning: console.warn.bind(console),
  error: console.error.bind(console),
  success: console.log.bind(console)
};

// #197/#154 (cnuss/mshick): the readable is used both standalone (README usage, no logger) and from
// the offline plugin (which passes a normalized log via options). normalizeLog guarantees a complete
// logger so the recovery warning never throws when `options.log` is absent.
const normalizeLog = log => ({...defaultLog, ...log});

module.exports = {defaultLog, normalizeLog};
