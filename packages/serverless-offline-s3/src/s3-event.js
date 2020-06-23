class S3Event {
  constructor(record) {
    this.Records = [record];
  }
}
module.exports = S3Event;
