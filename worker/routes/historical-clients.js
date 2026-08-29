import {
  captureHistoricalResolution,
  isHistoricalClientId,
} from '../../src/historical-records.js'
import { AppError } from '../http/errors.js'
import { activateHistoricalClient } from '../core/historical-clients.js'
import {
  continueHistoricalProjection,
  getHistoricalProjection,
  getHistoricalProjectionReviewCatalog as loadHistoricalProjectionReviewCatalog,
  resolveHistoricalConflict,
} from '../core/historical-materializer.js'
import { authorize } from '../identity/policy.js'

const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const CENTRE_RESOURCE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })

const validation = (field) => { throw new AppError('VALIDATION_FAILED', { field }) }
const exactBody = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) validation('body')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string'
      || !keys.includes(key) || !descriptors[key]?.enumerable
      || !Object.hasOwn(descriptors[key], 'value'))) validation('body')
    return Object.freeze(Object.fromEntries(keys.map(
      (key) => [key, descriptors[key].value],
    )))
  } catch (error) {
    if (error instanceof AppError) throw error
    validation('body')
  }
}

const importIdFrom = (value) => {
  if (typeof value !== 'string' || !IMPORT_ID.test(value)) validation('importId')
  return value
}

const projectionActor = (actor) => {
  if (!authorize(actor, 'finance.import', CENTRE_RESOURCE, { nowMs: 0 })) {
    throw new AppError('NOT_FOUND')
  }
  return actor
}

const activationActor = (actor) => {
  if (!['owner', 'coordinator'].includes(actor?.role)) throw new AppError('NOT_FOUND')
  return actor
}

export const getHistoricalProjectionStatus = (input = {}) => {
  const actor = projectionActor(input.actor)
  const service = input.service ?? getHistoricalProjection
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  return service({
    db: input.db, recoveryDb: input.recoveryDb, actor,
    keyring: input.keyring, importId: importIdFrom(input.importId),
  })
}

export const getHistoricalProjectionReviewCatalog = (input = {}) => {
  const actor = projectionActor(input.actor)
  const service = input.service ?? loadHistoricalProjectionReviewCatalog
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  if (!(input.afterSourceRecordId === null
    || (typeof input.afterSourceRecordId === 'string'
      && /^wbs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(input.afterSourceRecordId)))) {
    validation('afterSourceRecordId')
  }
  return service({
    db: input.db, recoveryDb: input.recoveryDb, actor,
    keyring: input.keyring, config: input.config,
    centreId: input.centreId, importId: importIdFrom(input.importId),
    afterSourceRecordId: input.afterSourceRecordId,
  })
}

export const postHistoricalProjectionContinue = (input = {}) => {
  const actor = projectionActor(input.actor)
  const service = input.service ?? continueHistoricalProjection
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  const body = exactBody(input.body, ['expectedVersion'])
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    validation('expectedVersion')
  }
  return service({
    db: input.db, recoveryDb: input.recoveryDb, actor,
    keyring: input.keyring, config: input.config, centreId: input.centreId,
    importId: importIdFrom(input.importId), expectedVersion: body.expectedVersion,
    idempotencyKey: input.idempotencyKey, idFactory: input.idFactory,
    nowMs: input.nowMs,
  })
}

export const postHistoricalProjectionResolution = (input = {}) => {
  const actor = projectionActor(input.actor)
  const service = input.service ?? resolveHistoricalConflict
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  let body
  try {
    const captured = exactBody(input.body, [
      'expectedJobVersion', 'conflictId', 'classification', 'existingSubjectId',
      'serviceId', 'reviewContextDigest', 'directoryCount', 'directoryDigest',
    ])
    const decision = captureHistoricalResolution(Object.fromEntries(
      ['expectedJobVersion', 'conflictId', 'classification', 'existingSubjectId', 'serviceId']
        .map((key) => [key, captured[key]]),
    ))
    if (!/^[a-f0-9]{64}$/.test(captured.reviewContextDigest)
      || !Number.isSafeInteger(captured.directoryCount) || captured.directoryCount < 0
      || !/^[a-f0-9]{64}$/.test(captured.directoryDigest)) validation('body')
    body = Object.freeze({
      ...decision,
      reviewContextDigest: captured.reviewContextDigest,
      directoryCount: captured.directoryCount,
      directoryDigest: captured.directoryDigest,
    })
  } catch { validation('body') }
  return service({
    db: input.db, recoveryDb: input.recoveryDb, actor,
    keyring: input.keyring, config: input.config, centreId: input.centreId,
    importId: importIdFrom(input.importId), body,
    idempotencyKey: input.idempotencyKey, idFactory: input.idFactory,
    nowMs: input.nowMs,
  })
}

export const postHistoricalClientActivation = (input = {}) => {
  const actor = activationActor(input.actor)
  const service = input.service ?? activateHistoricalClient
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  if (!isHistoricalClientId(input.historicalClientId)) validation('historicalClientId')
  const body = exactBody(input.body, ['expectedVersion', 'specialistId'])
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
    validation('expectedVersion')
  }
  if (typeof body.specialistId !== 'string' || !SPECIALIST_ID.test(body.specialistId)) {
    validation('specialistId')
  }
  return service({
    db: input.db, recoveryDb: input.recoveryDb, actor,
    keyring: input.keyring, historicalClientId: input.historicalClientId, body,
    idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
    idFactory: input.idFactory, nowMs: input.nowMs,
  })
}
