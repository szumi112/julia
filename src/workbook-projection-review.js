// Shared browser contract for the two post-financial import stages.
import { captureHistoricalResolution } from './historical-records.js'
import { SERVICE_BY_ID } from './services.js'

const invalid = () => { throw new TypeError('CLIENT_RESULT_INVALID') }
const id = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$`).test(value)
const count = (value) => Number.isSafeInteger(value) && value >= 0
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value
const text = (value, max = 240) => typeof value === 'string' && value.length > 0
  && value.length <= max && value === value.trim() && value === value.normalize('NFC')
  && value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value)
const exact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid()
  const result = {}
  for (const key of keys) {
    if (!descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')) invalid()
    result[key] = descriptors[key].value
  }
  return result
}
const list = (raw, capture, max = 100) => {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || raw.length > max || Reflect.ownKeys(raw).length !== raw.length + 1) invalid()
  return Object.freeze(Array.from({ length: raw.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(raw, String(index))
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) invalid()
    return capture(item.value)
  }))
}
export const projectionsComplete = (historical, activity) => historical?.status === 'complete'
  && activity?.status === 'complete'

export const captureProjectionJob = (raw, importId) => {
  const value = exact(raw, ['id', 'importId', 'status', 'afterSourceRecordId', 'totalRecords',
    'processedRecords', 'projectedRecords', 'conflictCount', 'version', 'updatedAt', 'completedAt'])
  if (!id(value.id, 'hpj') || !id(value.importId, 'wbi') || value.importId !== importId
    || !['ready', 'running', 'conflicts', 'complete', 'failed'].includes(value.status)
    || !(value.afterSourceRecordId === null || id(value.afterSourceRecordId, 'wbs'))
    || !['totalRecords', 'processedRecords', 'projectedRecords', 'conflictCount', 'version']
      .every((key) => count(value[key])) || value.version < 1
    || value.processedRecords > value.totalRecords || value.projectedRecords > value.processedRecords
    || !instant(value.updatedAt) || !(value.completedAt === null || instant(value.completedAt))
    || (value.status === 'complete') !== (value.completedAt !== null)
    || (value.status === 'complete' && value.processedRecords !== value.totalRecords)) invalid()
  return Object.freeze(value)
}
const context = (raw) => {
  const value = exact(raw, ['counterparty', 'serviceLabel', 'proposedClassification',
    'proposedServiceId', 'nearSubjectIds'])
  if (!text(value.counterparty, 160) || !text(value.serviceLabel)
    || !['person', 'counterparty', 'review'].includes(value.proposedClassification)
    || !(value.proposedServiceId === null || Object.hasOwn(SERVICE_BY_ID, value.proposedServiceId))) invalid()
  value.nearSubjectIds = list(value.nearSubjectIds, (subject) => {
    if (!id(subject, 'hc[lp]')) invalid()
    return subject
  })
  if (new Set(value.nearSubjectIds).size !== value.nearSubjectIds.length) invalid()
  return Object.freeze(value)
}
export const captureProjectionStatus = (raw, importId) => {
  const value = exact(raw, ['projection', 'conflicts'])
  value.projection = value.projection === null ? null : captureProjectionJob(value.projection, importId)
  value.conflicts = list(value.conflicts, (rawConflict) => {
    const conflict = exact(rawConflict, ['id', 'sourceRecordId', 'kind', 'context'])
    if (!id(conflict.id, 'hcf') || !id(conflict.sourceRecordId, 'wbs')
      || !['classification', 'service', 'near_match'].includes(conflict.kind)) invalid()
    conflict.context = context(conflict.context)
    return Object.freeze(conflict)
  })
  if ((!value.projection && value.conflicts.length)
    || (value.projection && value.conflicts.length > value.projection.conflictCount)) invalid()
  return Object.freeze(value)
}
export const captureProjectionCatalog = (raw, importId, afterSourceRecordId) => {
  const value = exact(raw, ['binding', 'afterSourceRecordId', 'nextAfterSourceRecordId',
    'directoryCount', 'directoryDigest', 'items', 'profiles'])
  value.binding = Object.freeze(exact(value.binding, ['environment', 'centreId', 'fingerprint',
    'artifactId', 'importId', 'creatorId', 'planDigest']))
  const binding = value.binding
  if (binding.environment !== 'staging' || binding.centreId !== 'centre_1'
    || !digest(binding.fingerprint) || !id(binding.artifactId, 'wba')
    || binding.importId !== importId || !id(binding.creatorId, 'stf')
    || !/^v1_[A-Za-z0-9_-]{43}$/.test(binding.planDigest ?? '')
    || value.afterSourceRecordId !== afterSourceRecordId
    || !(value.nextAfterSourceRecordId === null || (id(value.nextAfterSourceRecordId, 'wbs')
      && value.nextAfterSourceRecordId > (afterSourceRecordId ?? '')))
    || !count(value.directoryCount) || !digest(value.directoryDigest)) invalid()
  value.items = list(value.items, (rawItem) => {
    const item = exact(rawItem, ['sourceRecordId', 'kind', 'conflictId', 'resolution',
      'reviewContextDigest', 'context'])
    if (!id(item.sourceRecordId, 'wbs') || !['classification', 'service'].includes(item.kind)
      || !(item.conflictId === null || id(item.conflictId, 'hcf'))
      || !digest(item.reviewContextDigest)) invalid()
    item.context = context(item.context)
    if (item.resolution !== null) {
      const resolution = exact(item.resolution, ['classification', 'existingSubjectId', 'serviceId'])
      captureHistoricalResolution({ expectedJobVersion: 1, conflictId: 'hcf_validation', ...resolution })
      item.resolution = Object.freeze(resolution)
    }
    return Object.freeze(item)
  })
  value.profiles = list(value.profiles, (rawItem) => {
    const item = exact(rawItem, ['sourceRecordId', 'reviewContextDigest', 'context'])
    if (!id(item.sourceRecordId, 'wbs') || !digest(item.reviewContextDigest)) invalid()
    item.context = context(item.context)
    return Object.freeze(item)
  })
  const sourceIds = [...value.items, ...value.profiles].map(({ sourceRecordId }) => sourceRecordId)
  if (sourceIds.length > 100 || new Set(sourceIds).size !== sourceIds.length
    || sourceIds.some((source) => source <= (afterSourceRecordId ?? '')
      || (value.nextAfterSourceRecordId !== null && source > value.nextAfterSourceRecordId))) invalid()
  for (const entries of [value.items, value.profiles]) {
    if (entries.some((item, index) => index > 0
      && item.sourceRecordId <= entries[index - 1].sourceRecordId)) invalid()
  }
  return Object.freeze(value)
}
export const captureProjectionResolution = (raw) => {
  const value = exact(raw, ['expectedJobVersion', 'conflictId', 'classification',
    'existingSubjectId', 'serviceId', 'reviewContextDigest', 'directoryCount', 'directoryDigest'])
  const { reviewContextDigest, directoryCount, directoryDigest, ...decision } = value
  captureHistoricalResolution(decision)
  if (!digest(reviewContextDigest) || !count(directoryCount) || !digest(directoryDigest)
    || (decision.classification !== 'exclude' && decision.serviceId === null)) invalid()
  return Object.freeze(value)
}
