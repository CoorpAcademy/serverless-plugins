class S3EventDefinition {
  constructor(S3Event) {
    this.event = S3Event.event;
    this.bucket = S3Event.bucket;
    this.rules = S3Event.rules;
  }
}

module.exports = S3EventDefinition;
