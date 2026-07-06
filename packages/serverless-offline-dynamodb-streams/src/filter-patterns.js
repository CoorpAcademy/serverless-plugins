const {isEmpty, some, filter} = require('lodash/fp');
// Reuse the proven EventBridge content-filter matcher (see
// serverless-offline-eventbridge/NOTICE for the algorithm attribution). AWS Lambda
// event-source-mapping `filterPatterns` use the SAME EventBridge content-filter
// grammar (prefix/suffix/anything-but/exists/equals-ignore-case/numeric/wildcard/
// cidr, `$or`, nested-object AND), so a cross-package import keeps a single source
// of truth for the grammar rather than re-implementing it here.
const {matchesPattern} = require('@coorpacademy/serverless-offline-eventbridge/src/eventbridge');

// #242 (cremoon): honor dynamodb stream event-source-mapping `filterPatterns`
// locally. A record matches when it matches ANY one of the patterns in the array
// (logical OR across the array, matching AWS ESM semantics); each pattern is matched
// against the FULL record object — top-level eventName/eventSource plus the nested
// dynamodb.{Keys,NewImage,OldImage} attribute-value paths. Absent/empty patterns let
// every record through, preserving the current no-filter behavior.
//
// AWS ESM filter patterns are arbitrarily nested (top-level keys AND deep
// dynamodb.* attribute-value paths), with arrays-of-filters as OR at each leaf and
// nested objects as AND — exactly the semantics matchesPattern applies to its
// `detail` branch (via flattenLeaves -> dot-paths). We therefore route both the
// pattern and the record through that branch by wrapping each under `detail`, which
// reuses the proven grammar without re-implementing any matching logic.
const matchesRecord = (pattern, record) => matchesPattern({detail: pattern}, {detail: record});

const recordMatchesFilterPatterns = (filterPatterns, record) =>
  isEmpty(filterPatterns) ? true : some(pattern => matchesRecord(pattern, record), filterPatterns);

// filterRecords(filterPatterns, records) -> records (immutable subset). With no
// patterns the chunk passes through untouched; tolerates a non-array/empty chunk
// (e.g. the readable's drain sentinel) without throwing.
const filterRecords = (filterPatterns, records) =>
  isEmpty(filterPatterns)
    ? records
    : filter(record => recordMatchesFilterPatterns(filterPatterns, record), records);

module.exports = {recordMatchesFilterPatterns, filterRecords};
