const {get, has, isString, isPlainObject, castArray} = require('lodash/fp');

// #103 (cwienands1): resolve a DynamoDB `stream` event to its table name across
// every supported form — a string ARN, {arn:'<string ARN>'}, {tableName}, an
// {arn:{Fn::GetAtt:[Id, StreamArn|Arn]}}, an {arn:{Ref:Id}} and the (offline-
// unresolvable) {arn:{Fn::ImportValue:...}} — null-guarding the resolved name so a
// missing TableName surfaces a clear error instead of `arn:...:undefined`.
//
// Note: the {tableName} form was historically reported as "not supported" (issue-1)
// because of a removed `getTableName` helper. It IS supported and stays supported
// here; the real gaps were the missing Ref/ImportValue handling and the null-guard.

// arn:aws:dynamodb:<region>:<account>:table/<TableName>/stream/<label>
const extractTableNameFromARN = arn => {
  const [, , , , , tableUri] = String(arn).split(':');
  const [, tableName] = String(tableUri).split('/');
  return tableName;
};

// Look up Resources.<logicalId>.Properties.TableName, throwing clear errors when the
// resource is unknown or carries no static TableName (CFN would auto-name it, which
// cannot be known offline).
const tableNameFromResource = (logicalId, resources) => {
  const properties = get(['Resources', logicalId, 'Properties'], resources);
  if (!properties) throw new Error(`No resource defined with name ${logicalId}`);

  const {TableName} = properties;
  if (!isString(TableName) || TableName === '')
    throw new Error(
      `Resource ${logicalId} has no static Properties.TableName; ` +
        `add an explicit TableName or use a {tableName} stream event so it can be resolved offline`
    );

  return TableName;
};

// resolveTableName(event, resources) -> string (throws on the unresolvable shapes)
const resolveTableName = (event, resources) => {
  if (isString(event)) return extractTableNameFromARN(event);
  if (isString(event.tableName)) return event.tableName;

  const {arn} = event;
  if (isString(arn)) return extractTableNameFromARN(arn);

  if (isPlainObject(arn)) {
    if (has('Fn::GetAtt', arn)) {
      // Tolerate both the array form ['Table','StreamArn'] and the dotted-string
      // form 'Table.StreamArn' that some YAML produces.
      const [getAttTarget] = castArray(arn['Fn::GetAtt']);
      const [logicalId] = String(getAttTarget).split('.');
      return tableNameFromResource(logicalId, resources);
    }

    if (has('Ref', arn)) return tableNameFromResource(arn.Ref, resources);

    if (has('Fn::ImportValue', arn))
      throw new Error(
        'Fn::ImportValue cannot be resolved offline for a dynamodb stream; ' +
          'use a {tableName} stream event or an explicit Properties.TableName'
      );
  }

  throw new Error(
    'Unable to resolve a DynamoDB table name from the stream event; ' +
      'provide a string ARN, {arn}, {tableName}, or an Fn::GetAtt/Ref to a table resource'
  );
};

module.exports = {resolveTableName, extractTableNameFromARN};
