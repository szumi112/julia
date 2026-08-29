import { AppError } from '../http/errors.js'
import {
  captureCreateActivityClassCommand,
  captureCreateActivityGroupCommand,
  captureCreateActivityMembershipCommand,
  captureCreateActivityParticipantCommand,
  captureEditActivityClassCommand,
  captureEditActivityGroupCommand,
  captureEditActivityMembershipCommand,
  captureEditActivityParticipantCommand,
  captureSetActivityAttendanceCommand,
} from '../../src/activity-records.js'
import {
  createActivityClass,
  createActivityGroup,
  createActivityMembership,
  createActivityParticipant,
  editActivityClass,
  editActivityGroup,
  editActivityMembership,
  editActivityParticipant,
  parseActivityWorkspaceQuery,
  readActivityWorkspace,
  setActivityAttendance,
} from '../core/activities.js'
import {
  continueActivityProjection,
  getActivityProjection,
} from '../core/activity-materializer.js'
import { authorize } from '../identity/policy.js'

const IMPORT_ID = /^wbi_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CENTRE_RESOURCE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const ACTIVITY_IDS = Object.freeze({
  groupId: /^agr_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  participantId: /^acp_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  membershipId: /^amb_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  classId: /^acl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
})
const COMMAND_KEYS = Object.freeze([
  'db', 'recoveryDb', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory',
  'body', 'idempotencyKey',
])
const READ_KEYS = Object.freeze(['db', 'actor', 'keyring', 'nowMs', 'url'])
const ACTIVITY_VALIDATION_FIELDS = new Set([
  'body', 'programId', 'label', 'details', 'leaderSpecialistIds', 'participantId',
  'groupId', 'membershipId', 'classId', 'startsOn', 'endsOn', 'date', 'time',
  'durationMinutes', 'topic', 'status', 'expectedVersion', 'clientId',
  'historicalClientId',
])

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

const projectionActor = (actor) => {
  if (!authorize(actor, 'finance.import', CENTRE_RESOURCE, { nowMs: 0 })) {
    throw new AppError('NOT_FOUND')
  }
  return actor
}

const importIdFrom = (value) => {
  if (typeof value !== 'string' || !IMPORT_ID.test(value)) validation('importId')
  return value
}

const adapterInput = (value, keys) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INTERNAL_ERROR')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    const expected = Object.hasOwn(descriptors, 'service') ? [...keys, 'service'] : keys
    if (actual.length !== expected.length || actual.some((key) => (
      typeof key !== 'string' || !expected.includes(key)
      || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')
    ))) throw new Error('INTERNAL_ERROR')
    return Object.freeze(Object.fromEntries(expected.map(
      (key) => [key, descriptors[key].value],
    )))
  } catch (error) {
    if (error instanceof Error && error.message === 'INTERNAL_ERROR') throw error
    throw new Error('INTERNAL_ERROR')
  }
}

const capturedBody = (capture, value) => {
  try { return capture(value) } catch { validation('body') }
}

const nativeTarget = (key, value) => {
  if (!ACTIVITY_IDS[key]?.test(value)) validation(key)
  return value
}

const callNative = async (service, input) => {
  try { return await service(input) } catch (error) {
    let message
    try {
      const descriptor = error instanceof TypeError
        ? Object.getOwnPropertyDescriptor(error, 'message') : null
      if (descriptor && Object.hasOwn(descriptor, 'value')) message = descriptor.value
    } catch { throw new Error('INTERNAL_ERROR') }
    const match = typeof message === 'string'
      ? /^VALIDATION_FAILED\/([A-Za-z][A-Za-z0-9]*)$/.exec(message)
      : null
    if (match && ACTIVITY_VALIDATION_FIELDS.has(match[1])) {
      throw new AppError('VALIDATION_FAILED', { field: match[1] })
    }
    throw error
  }
}

const nativeCommand = (input, { capture, service: defaultService, targetKey = null }) => {
  const keys = targetKey === null ? COMMAND_KEYS : [...COMMAND_KEYS, targetKey]
  const command = adapterInput(input, keys)
  const service = command.service ?? defaultService
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  const target = targetKey === null ? {} : {
    [targetKey]: nativeTarget(targetKey, command[targetKey]),
  }
  const body = capturedBody(capture, command.body)
  return callNative(service, {
    db: command.db, recoveryDb: command.recoveryDb, actor: command.actor,
    keyring: command.keyring, nowMs: command.nowMs,
    correlationId: command.correlationId, idFactory: command.idFactory,
    body, idempotencyKey: command.idempotencyKey, ...target,
  })
}

export const getActivityWorkspace = (input = {}) => {
  const captured = adapterInput(input, READ_KEYS)
  const service = captured.service ?? readActivityWorkspace
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  return service({
    db: captured.db, actor: captured.actor, keyring: captured.keyring,
    nowMs: captured.nowMs, window: parseActivityWorkspaceQuery(captured.url),
  })
}

export const postActivityGroup = (input = {}) => nativeCommand(input, {
  capture: captureCreateActivityGroupCommand, service: createActivityGroup,
})

export const postActivityGroupEdit = (input = {}) => nativeCommand(input, {
  capture: captureEditActivityGroupCommand, service: editActivityGroup, targetKey: 'groupId',
})

export const postActivityParticipant = (input = {}) => nativeCommand(input, {
  capture: captureCreateActivityParticipantCommand, service: createActivityParticipant,
})

export const postActivityParticipantEdit = (input = {}) => nativeCommand(input, {
  capture: captureEditActivityParticipantCommand,
  service: editActivityParticipant,
  targetKey: 'participantId',
})

export const postActivityMembership = (input = {}) => nativeCommand(input, {
  capture: captureCreateActivityMembershipCommand, service: createActivityMembership,
})

export const postActivityMembershipEdit = (input = {}) => nativeCommand(input, {
  capture: captureEditActivityMembershipCommand,
  service: editActivityMembership,
  targetKey: 'membershipId',
})

export const postActivityClass = (input = {}) => nativeCommand(input, {
  capture: captureCreateActivityClassCommand, service: createActivityClass,
})

export const postActivityClassEdit = (input = {}) => nativeCommand(input, {
  capture: captureEditActivityClassCommand, service: editActivityClass, targetKey: 'classId',
})

export const postActivityAttendance = (input = {}) => nativeCommand(input, {
  capture: captureSetActivityAttendanceCommand,
  service: setActivityAttendance,
  targetKey: 'classId',
})

export const getActivityProjectionStatus = (input = {}) => {
  const actor = projectionActor(input.actor)
  const service = input.service ?? getActivityProjection
  if (typeof service !== 'function') throw new Error('INTERNAL_ERROR')
  return service({
    db: input.db, actor, importId: importIdFrom(input.importId),
  })
}

export const postActivityProjectionContinue = (input = {}) => {
  const actor = projectionActor(input.actor)
  const service = input.service ?? continueActivityProjection
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
