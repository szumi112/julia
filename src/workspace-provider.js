import {
  captureLoadedWorkspaceLoad,
  createLoadedWorkspaceState,
  isWorkspaceWindowLoaded,
  mergeLoadedWorkspaceLoad,
  recordLoadedWorkspaceWrite,
  resetLoadedWorkspaceAuthority,
} from './loaded-windows.js'
import {
  isAppointmentId, isPaymentId, isSpecialistId, warsawDateFromUtc,
} from './core-records.js'
import {
  captureLoadedActivitiesLoad,
  createLoadedActivitiesState,
  mergeLoadedActivitiesLoad,
  recordLoadedActivitiesWrite,
  resetLoadedActivitiesAuthority,
} from './loaded-activities.js'
import {
  captureActivityAttendance,
  captureActivityClass,
  captureActivityGroup,
  captureActivityGroupLeader,
  captureActivityMembership,
  captureActivityMonthWindow,
  captureActivityParticipant,
  captureActivityWorkspace,
  captureCreateActivityClassCommand,
  captureCreateActivityGroupCommand,
  captureCreateActivityMembershipCommand,
  captureCreateActivityParticipantCommand,
  captureEditActivityClassCommand,
  captureEditActivityGroupCommand,
  captureEditActivityMembershipCommand,
  captureEditActivityParticipantCommand,
  captureSetActivityAttendanceCommand,
  isActivityClassId,
  isActivityGroupId,
  isActivityMembershipId,
  isActivityParticipantId,
} from './activity-records.js'

const AUTHORITY_KEYS = Object.freeze([
  'repositoryMode', 'dataMode', 'actorId', 'actorVersion', 'role', 'specialistId',
  'capabilities', 'demoRoleId', 'demoAuthGeneration',
])
const REPOSITORY_METHODS = Object.freeze([
  'loadWindow', 'createClient', 'editClient', 'archiveClient', 'activateHistoricalClient',
  'createAppointment', 'editAppointment', 'cancelAppointment', 'recordPayment',
  'correctPayment',
])
const ACTIVITY_REPOSITORY_METHODS = Object.freeze([
  'loadWindow',
  'createGroup', 'editGroup',
  'createParticipant', 'editParticipant',
  'createMembership', 'editMembership',
  'createClass', 'editClass', 'setAttendance',
])
const ACTIVITY_COMMAND_METHODS = Object.freeze(
  ACTIVITY_REPOSITORY_METHODS.filter((name) => name !== 'loadWindow'),
)
const WORKSPACE_METHODS = Object.freeze(REPOSITORY_METHODS.filter((name) => name !== 'loadWindow'))
const CLIENT_MUTATION_METHODS = new Set([
  'createClient', 'editClient', 'archiveClient', 'activateHistoricalClient',
])
const APPOINTMENT_MUTATION_METHODS = new Set(['createAppointment', 'editAppointment', 'cancelAppointment'])
const PAYMENT_MUTATION_METHODS = new Set(['recordPayment', 'correctPayment'])
const PAYMENT_ENTRY_KEYS = new Set([
  'id', 'amountGrosze', 'method', 'receivedAt', 'correctedAt', 'replacementEntryId',
])
const PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'monthly'])
const AUTHORITY_ACTION_KEY_LIMIT = 32
const ACTIVITY_LOAD_MAX_ATTEMPTS = 3
const INFRASTRUCTURE_CODES = new Set([
  'ACCESS_ASSERTION_INVALID', 'ACCESS_DENIED', 'CSRF_INVALID', 'CSRF_EXPIRED',
  'FORBIDDEN', 'INTERNAL_ERROR', 'INVALID_RESPONSE', 'NETWORK_ERROR', 'ORIGIN_INVALID',
  'SESSION_REQUIRED',
])

const fail = (message) => {
  throw new TypeError(message)
}

const captureExactRecord = (value, keys, label) => {
  let descriptors
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`Invalid ${label}`)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail(`Invalid ${label}`)
  }
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail(`Invalid ${label}`)
  }
  const captured = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`Invalid ${label}`)
    captured[key] = descriptor.value
  }
  return captured
}

const captureCapabilities = (value) => {
  let descriptors
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      fail('Invalid workspace authority')
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail('Invalid workspace authority')
  }
  const length = descriptors.length?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > 64
    || Reflect.ownKeys(descriptors).length !== length + 1) fail('Invalid workspace authority')
  const result = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
      fail('Invalid workspace authority')
    }
    result.push(descriptor.value)
  }
  if (new Set(result).size !== result.length) fail('Invalid workspace authority')
  return result.sort()
}

export const createWorkspaceAuthorityKey = (input) => {
  const value = captureExactRecord(input, AUTHORITY_KEYS, 'workspace authority')
  if (!['api', 'demo'].includes(value.repositoryMode)
    || typeof value.dataMode !== 'string' || value.dataMode.length === 0
    || typeof value.actorId !== 'string' || value.actorId.length === 0
    || !Number.isSafeInteger(value.actorVersion) || value.actorVersion < 1
    || typeof value.role !== 'string' || value.role.length === 0
    || (value.specialistId !== null
      && (typeof value.specialistId !== 'string' || value.specialistId.length === 0))
    || (value.demoRoleId !== null
      && (typeof value.demoRoleId !== 'string' || value.demoRoleId.length === 0))
    || (value.demoAuthGeneration !== null
      && (!Number.isSafeInteger(value.demoAuthGeneration) || value.demoAuthGeneration < 0))
    || (value.repositoryMode === 'api'
      && (!['owner', 'coordinator', 'specialist'].includes(value.role)
        || (value.role === 'specialist'
          ? !isSpecialistId(value.specialistId)
          : value.specialistId !== null && !isSpecialistId(value.specialistId))))) {
    fail('Invalid workspace authority')
  }
  return JSON.stringify([
    value.repositoryMode,
    value.dataMode,
    value.actorId,
    value.actorVersion,
    value.role,
    value.specialistId,
    captureCapabilities(value.capabilities),
    value.demoRoleId,
    value.demoAuthGeneration,
  ])
}

const activityScopeForAuthorityKey = (authorityKey) => {
  try {
    const parsed = JSON.parse(authorityKey)
    if (!Array.isArray(parsed) || parsed.length !== 9) return 'unknown'
    const rebuilt = createWorkspaceAuthorityKey({
      repositoryMode: parsed[0], dataMode: parsed[1], actorId: parsed[2],
      actorVersion: parsed[3], role: parsed[4], specialistId: parsed[5],
      capabilities: parsed[6], demoRoleId: parsed[7], demoAuthGeneration: parsed[8],
    })
    if (rebuilt !== authorityKey || parsed[0] !== 'api') return 'unknown'
    if (parsed[4] === 'specialist') return 'specialist'
    if (parsed[4] === 'owner' || parsed[4] === 'coordinator') return 'centre'
  } catch {}
  return 'unknown'
}

export const createAuthorityBoundDispatch = (options) => {
  const captured = captureExactRecord(options, [
    'dispatch', 'getState', 'resetAuthority', 'authorityKeyFor', 'demoRoleIds',
  ], 'authority dispatch')
  if (typeof captured.dispatch !== 'function' || typeof captured.getState !== 'function'
    || typeof captured.resetAuthority !== 'function'
    || typeof captured.authorityKeyFor !== 'function') fail('Invalid authority dispatch')
  const demoRoleIds = new Set(captureCapabilities(captured.demoRoleIds))
  return Object.freeze((action) => {
    let descriptors
    try {
      if (action === null || typeof action !== 'object' || Array.isArray(action)
        || Object.getPrototypeOf(action) !== Object.prototype) fail('Invalid authority action')
      descriptors = Object.getOwnPropertyDescriptors(action)
    } catch {
      fail('Invalid authority action')
    }
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length < 1 || keys.length > AUTHORITY_ACTION_KEY_LIMIT
      || keys.some((key) => typeof key !== 'string')) fail('Invalid authority action')
    const snapshot = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('Invalid authority action')
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    if (typeof snapshot.type !== 'string') {
      fail('Invalid authority action')
    }
    if (snapshot.type === 'SET_DEMO_ROLE') {
      if (typeof snapshot.roleId !== 'string') fail('Invalid authority action')
      if (!demoRoleIds.has(snapshot.roleId)) return captured.dispatch(snapshot)
      const state = captured.getState()
      if (state?.demoRoleId !== snapshot.roleId) {
        captured.resetAuthority(captured.authorityKeyFor({ ...state, demoRoleId: snapshot.roleId }))
      }
    }
    return captured.dispatch(snapshot)
  })
}

const repositoryFrom = (repositoryFactory, dispatch, getState) => {
  if (typeof repositoryFactory !== 'function') fail('Invalid workspace repository factory')
  const repository = repositoryFactory(Object.freeze({ dispatch, getState }))
  let descriptors
  try {
    if (repository === null || typeof repository !== 'object' || Array.isArray(repository)
      || !Object.isFrozen(repository)) fail('Invalid workspace repository')
    descriptors = Object.getOwnPropertyDescriptors(repository)
  } catch {
    fail('Invalid workspace repository')
  }
  const keys = Reflect.ownKeys(descriptors)
  const repositoryKeys = [...REPOSITORY_METHODS, 'activities']
  if (keys.length !== repositoryKeys.length
    || keys.some((name) => typeof name !== 'string' || !repositoryKeys.includes(name))) {
    fail('Invalid workspace repository')
  }
  for (const name of REPOSITORY_METHODS) {
    const descriptor = descriptors[name]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function') fail('Invalid workspace repository')
  }
  const activitiesDescriptor = descriptors.activities
  if (!activitiesDescriptor?.enumerable || !Object.hasOwn(activitiesDescriptor, 'value')) {
    fail('Invalid workspace repository')
  }
  const activities = activitiesDescriptor.value
  if (activities !== null) {
    let activityDescriptors
    try {
      if (typeof activities !== 'object' || Array.isArray(activities)
        || Object.getPrototypeOf(activities) !== Object.prototype
        || !Object.isFrozen(activities)) fail('Invalid activity repository')
      activityDescriptors = Object.getOwnPropertyDescriptors(activities)
    } catch { fail('Invalid activity repository') }
    const activityKeys = Reflect.ownKeys(activityDescriptors)
    if (activityKeys.length !== ACTIVITY_REPOSITORY_METHODS.length
      || activityKeys.some((name) => typeof name !== 'string'
        || !ACTIVITY_REPOSITORY_METHODS.includes(name))) fail('Invalid activity repository')
    for (const name of ACTIVITY_REPOSITORY_METHODS) {
      const descriptor = activityDescriptors[name]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'function') fail('Invalid activity repository')
    }
  }
  return repository
}

const errorCode = (error) => {
  try {
    const descriptor = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? Object.getOwnPropertyDescriptor(error, 'code')
      : null
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value
      : null
  } catch {
    return null
  }
}

const infrastructureFailure = (error) => INFRASTRUCTURE_CODES.has(errorCode(error))

const fixedError = (code) => {
  const error = new Error(code)
  error.code = code
  return error
}

const readOnlyError = () => fixedError('WORKSPACE_READ_ONLY')
const staleAuthorityError = () => fixedError('WORKSPACE_AUTHORITY_STALE')
const resetFailedError = () => fixedError('WORKSPACE_RESET_FAILED')

const paymentLockForRecord = (state, appointmentId) => {
  try {
    if (!isAppointmentId(appointmentId)) throw new TypeError('Invalid appointment ID')
    const appointmentDescriptor = Object.getOwnPropertyDescriptor(
      state.appointmentsById, appointmentId,
    )
    if (!appointmentDescriptor || !Object.hasOwn(appointmentDescriptor, 'value')) {
      throw new TypeError('Appointment is not canonically loaded')
    }
    const startDescriptor = Object.getOwnPropertyDescriptor(appointmentDescriptor.value, 'startsAt')
    if (!startDescriptor || !Object.hasOwn(startDescriptor, 'value')) {
      throw new TypeError('Appointment start is unavailable')
    }
    const date = warsawDateFromUtc(startDescriptor.value)
    captureLoadedWorkspaceLoad(state, { from: date, to: date })
    return Object.freeze({ appointmentId, date })
  } catch {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
}

const paymentLockForCorrection = (state, paymentId) => {
  try {
    if (!isPaymentId(paymentId)) throw new TypeError('Invalid payment ID')
    const appointments = state.appointmentsById
    const descriptors = Object.getOwnPropertyDescriptors(appointments)
    const matches = []
    for (const appointmentId of Reflect.ownKeys(descriptors)) {
      if (typeof appointmentId !== 'string') throw new TypeError('Invalid appointment map')
      const descriptor = descriptors[appointmentId]
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
        || !isAppointmentId(appointmentId)) throw new TypeError('Invalid appointment map')
      const appointment = descriptor.value
      if (appointment === null || typeof appointment !== 'object' || Array.isArray(appointment)
        || Object.getPrototypeOf(appointment) !== Object.prototype) {
        throw new TypeError('Invalid appointment')
      }
      const idDescriptor = Object.getOwnPropertyDescriptor(appointment, 'id')
      const startsAtDescriptor = Object.getOwnPropertyDescriptor(appointment, 'startsAt')
      const entriesDescriptor = Object.getOwnPropertyDescriptor(appointment, 'paymentEntries')
      if (!idDescriptor || !Object.hasOwn(idDescriptor, 'value') || idDescriptor.value !== appointmentId
        || !startsAtDescriptor || !Object.hasOwn(startsAtDescriptor, 'value')
        || !entriesDescriptor || !Object.hasOwn(entriesDescriptor, 'value')
        || !Array.isArray(entriesDescriptor.value)) {
        throw new TypeError('Invalid appointment')
      }
      for (const entry of entriesDescriptor.value) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
          || Object.getPrototypeOf(entry) !== Object.prototype) {
          throw new TypeError('Invalid payment entry')
        }
        const entryId = Object.getOwnPropertyDescriptor(entry, 'id')
        const entryDescriptors = Object.getOwnPropertyDescriptors(entry)
        const entryKeys = Reflect.ownKeys(entryDescriptors)
        if (entryKeys.length !== PAYMENT_ENTRY_KEYS.size
          || entryKeys.some((key) => typeof key !== 'string' || !PAYMENT_ENTRY_KEYS.has(key))
          || !entryId || !Object.hasOwn(entryId, 'value') || !isPaymentId(entryId.value)
          || !Number.isSafeInteger(entryDescriptors.amountGrosze?.value)
          || entryDescriptors.amountGrosze.value < 1 || entryDescriptors.amountGrosze.value > 1_000_000
          || !PAYMENT_METHODS.has(entryDescriptors.method?.value)
          || typeof entryDescriptors.receivedAt?.value !== 'string'
          || (entryDescriptors.correctedAt?.value !== null
            && typeof entryDescriptors.correctedAt?.value !== 'string')
          || (entryDescriptors.replacementEntryId?.value !== null
            && !isPaymentId(entryDescriptors.replacementEntryId?.value))
          || (entryDescriptors.correctedAt?.value === null
            && entryDescriptors.replacementEntryId?.value !== null)) {
          throw new TypeError('Invalid payment entry')
        }
        warsawDateFromUtc(entryDescriptors.receivedAt.value)
        if (entryDescriptors.correctedAt.value !== null) {
          warsawDateFromUtc(entryDescriptors.correctedAt.value)
        }
        if (entryId.value === paymentId) matches.push({ appointmentId, startsAt: startsAtDescriptor.value })
      }
    }
    if (matches.length !== 1) throw new TypeError('Payment entry is unavailable')
    const { appointmentId, startsAt } = matches[0]
    const date = warsawDateFromUtc(startsAt)
    if (!isWorkspaceWindowLoaded(state, { from: date, to: date })) {
      throw new TypeError('Payment entry is not canonically loaded')
    }
    return Object.freeze({ appointmentId, date })
  } catch {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
}

const paymentLockForCommand = (name, state, args) => {
  if (name === 'recordPayment') return paymentLockForRecord(state, args[0])
  return paymentLockForCorrection(state, args[0])
}

const paymentLockReconciledBy = (lock, capture) => lock !== null
  && lock.date !== null && capture.from <= lock.date && lock.date <= capture.to

const historicalActivationLockFor = (args) => {
  try {
    if (!Array.isArray(args) || args.length !== 2
      || typeof args[0] !== 'string'
      || !/^hcl_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(args[0])) {
      throw new TypeError('Invalid activation command')
    }
    const body = captureExactRecord(
      args[1], ['expectedVersion', 'specialistId'], 'historical activation command',
    )
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
      || body.expectedVersion >= Number.MAX_SAFE_INTEGER
      || typeof body.specialistId !== 'string'
      || !/^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(body.specialistId)) {
      throw new TypeError('Invalid activation command')
    }
    return Object.freeze({
      historicalClientId: args[0], version: body.expectedVersion + 1,
    })
  } catch {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
}

const historicalActivationReconciled = (state, lock) => {
  if (lock === null) return true
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      state.historicalClientsById, lock.historicalClientId,
    )
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false
    const value = descriptor.value
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return descriptors.status?.value === 'activated'
      && descriptors.version?.value >= lock.version
      && typeof descriptors.activeClientId?.value === 'string'
      && /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/.test(descriptors.activeClientId.value)
  } catch { return false }
}

const ACTIVITY_COMMAND_SPECS = Object.freeze({
  createGroup: Object.freeze({ capture: captureCreateActivityGroupCommand }),
  editGroup: Object.freeze({ capture: captureEditActivityGroupCommand, id: isActivityGroupId }),
  createParticipant: Object.freeze({ capture: captureCreateActivityParticipantCommand }),
  editParticipant: Object.freeze({
    capture: captureEditActivityParticipantCommand, id: isActivityParticipantId,
  }),
  createMembership: Object.freeze({ capture: captureCreateActivityMembershipCommand }),
  editMembership: Object.freeze({
    capture: captureEditActivityMembershipCommand, id: isActivityMembershipId,
  }),
  createClass: Object.freeze({ capture: captureCreateActivityClassCommand, classDate: true }),
  editClass: Object.freeze({
    capture: captureEditActivityClassCommand, id: isActivityClassId,
    classDate: true, existingClass: true,
  }),
  setAttendance: Object.freeze({
    capture: captureSetActivityAttendanceCommand, id: isActivityClassId,
    existingClass: true,
  }),
})

const ACTIVITY_ACK_SPECS = Object.freeze({
  createParticipant: Object.freeze({
    capture: captureActivityParticipant, list: 'participants', map: 'participantsById',
  }),
  editParticipant: Object.freeze({
    capture: captureActivityParticipant, list: 'participants', map: 'participantsById',
  }),
  createMembership: Object.freeze({
    capture: captureActivityMembership, list: 'memberships', map: 'membershipsById',
  }),
  editMembership: Object.freeze({
    capture: captureActivityMembership, list: 'memberships', map: 'membershipsById',
  }),
  createClass: Object.freeze({
    capture: captureActivityClass, list: 'classes', map: 'classesById',
  }),
  editClass: Object.freeze({
    capture: captureActivityClass, list: 'classes', map: 'classesById',
  }),
  setAttendance: Object.freeze({
    capture: captureActivityAttendance, list: 'attendance', map: 'attendanceById',
  }),
})

const captureActivityLeaderAcknowledgements = (value) => {
  let descriptors
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > 20) throw new TypeError('Invalid activity leaders')
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch { throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED') }
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
  const result = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
    }
    result.push(captureActivityGroupLeader(descriptor.value))
  }
  return Object.freeze(result)
}

const sameActivityFields = (value, requested, fields) => fields.every(
  (field) => value[field] === requested[field],
)

const activityAcknowledgementMatchesCall = (name, acknowledgement, call) => {
  const requested = call.command
  const targetId = call.targetId
  const created = targetId === null
  const expectedVersion = created ? 1 : requested.expectedVersion + 1
  const createdExactly = (value) => !created || value.createdAt === value.updatedAt
  if (acknowledgement.kind === 'group') {
    const { group, groupLeaders } = acknowledgement
    const expectedSpecialists = [...requested.leaderSpecialistIds].sort()
    const actualSpecialists = groupLeaders.map(({ specialistId }) => specialistId).sort()
    return (created ? group.programId === requested.programId : group.id === targetId)
      && sameActivityFields(group, requested, ['label', 'details'])
      && group.status === (created ? 'active' : requested.status)
      && group.version === expectedVersion && createdExactly(group)
      && actualSpecialists.length === expectedSpecialists.length
      && actualSpecialists.every((id, index) => id === expectedSpecialists[index])
      && (created || call.previous.programId === group.programId)
  }
  const value = acknowledgement.entity
  if (name === 'createParticipant' || name === 'editParticipant') {
    return (created ? value.programId === requested.programId : value.id === targetId)
      && sameActivityFields(value, requested, ['name', 'clientId', 'historicalClientId'])
      && value.status === (created ? 'active' : requested.status)
      && value.version === expectedVersion && createdExactly(value)
      && (created || call.previous.programId === value.programId)
  }
  if (name === 'createMembership' || name === 'editMembership') {
    return (created
      ? value.participantId === requested.participantId
        && value.groupId === requested.groupId && value.status === 'active'
        && value.programId === call.membershipContext.programId
      : value.id === targetId && value.status === requested.status
        && call.previous.participantId === value.participantId
        && call.previous.groupId === value.groupId
        && call.previous.programId === value.programId)
      && value.membershipKind === 'interval'
      && sameActivityFields(value, requested, ['startsOn', 'endsOn'])
      && value.version === expectedVersion && createdExactly(value)
  }
  if (name === 'createClass' || name === 'editClass') {
    return (created ? value.groupId === requested.groupId : value.id === targetId)
      && sameActivityFields(
        value, requested, ['date', 'time', 'durationMinutes', 'topic', 'status'],
      )
      && value.version === expectedVersion && createdExactly(value)
      && (created || call.previous.groupId === value.groupId)
  }
  return name === 'setAttendance' && value.classId === targetId
    && value.participantId === requested.participantId && value.status === requested.status
    && value.version === requested.expectedVersion + 1
    && (requested.expectedVersion !== 0 || value.createdAt === value.updatedAt)
}

const captureActivityAcknowledgement = (name, value, call) => {
  try {
    let acknowledgement
    if (name === 'createGroup' || name === 'editGroup') {
      const result = captureExactRecord(value, ['group', 'groupLeaders'], 'activity result')
      const group = captureActivityGroup(result.group)
      const groupLeaders = captureActivityLeaderAcknowledgements(result.groupLeaders)
      if (groupLeaders.some((leader) => leader.groupId !== group.id
        || leader.status !== 'active')) throw new TypeError('Invalid activity result')
      acknowledgement = Object.freeze({ kind: 'group', group, groupLeaders })
    } else {
      const spec = ACTIVITY_ACK_SPECS[name]
      if (!spec) throw new TypeError('Invalid activity result')
      acknowledgement = Object.freeze({ kind: 'entity', ...spec, entity: spec.capture(value) })
    }
    if (!activityAcknowledgementMatchesCall(name, acknowledgement, call)) {
      throw new TypeError('Invalid activity result')
    }
    return acknowledgement
  } catch {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
}

const factCovers = (candidate, acknowledged) => candidate !== undefined
  && candidate.id === acknowledged.id
  && candidate.version >= acknowledged.version
  && (candidate.version > acknowledged.version
    || JSON.stringify(candidate) === JSON.stringify(acknowledged))

const exactActiveLeaders = (values, acknowledged) => {
  const actual = values.filter((leader) => (
    leader.groupId === acknowledged.group.id && leader.status === 'active'
  )).sort((left, right) => left.id.localeCompare(right.id))
  const expected = [...acknowledged.groupLeaders]
    .sort((left, right) => left.id.localeCompare(right.id))
  return actual.length === expected.length
    && actual.every((leader, index) => factCovers(leader, expected[index]))
}

const membershipOmissionIsCanonical = (
  membership, workspace, state, omissionProof,
) => {
  const today = workspace.currentDay
  if (membership.membershipKind !== 'interval' || omissionProof?.scope !== 'specialist'
    || (membership.status === 'active'
      && membership.startsOn <= today
      && (membership.endsOn === null || membership.endsOn >= today))) return false
  const payloadGroup = workspace.groups.find(({ id }) => id === membership.groupId)
  const payloadParticipant = workspace.participants.find(
    ({ id }) => id === membership.participantId,
  )
  const stateGroup = state.groupsById[membership.groupId]
  const stateParticipant = state.participantsById[membership.participantId]
  if (payloadGroup?.programId !== membership.programId
    || stateGroup?.programId !== membership.programId) return false
  const participantScopeIsCanonical = (payloadParticipant?.programId === membership.programId
      && stateParticipant?.programId === membership.programId)
    || (payloadParticipant === undefined && stateParticipant === undefined)
  const priorVersionIsCanonical = omissionProof.kind === 'create'
    ? omissionProof.membership === null && membership.version === 1
    : omissionProof.membership?.id === membership.id
      && omissionProof.membership.version + 1 === membership.version
      && omissionProof.membership.participantId === membership.participantId
      && omissionProof.membership.groupId === membership.groupId
      && omissionProof.membership.programId === membership.programId
  return participantScopeIsCanonical && priorVersionIsCanonical
    && omissionProof.group.id === membership.groupId
    && omissionProof.group.programId === membership.programId
    && omissionProof.participant.id === membership.participantId
    && omissionProof.participant.programId === membership.programId
}

const activityAcknowledgedBy = (
  acknowledgement, rawWorkspace, state, omissionProof,
) => {
  try {
    const workspace = captureActivityWorkspace(rawWorkspace)
    if (acknowledgement.kind === 'group') {
      const payloadGroup = workspace.groups.find(
        ({ id }) => id === acknowledgement.group.id,
      )
      const stateGroup = state.groupsById[acknowledgement.group.id]
      if (!factCovers(payloadGroup, acknowledgement.group)
        || !factCovers(stateGroup, acknowledgement.group)) return false
      if (payloadGroup.version > acknowledgement.group.version
        || stateGroup.version > acknowledgement.group.version) return true
      return exactActiveLeaders(workspace.groupLeaders, acknowledgement)
        && exactActiveLeaders(Object.values(state.groupLeadersById), acknowledgement)
    }
    const payloadEntity = workspace[acknowledgement.list]
      .find(({ id }) => id === acknowledgement.entity.id)
    const stateEntity = state[acknowledgement.map][acknowledgement.entity.id]
    if (payloadEntity === undefined && stateEntity === undefined
      && acknowledgement.map === 'membershipsById') {
      return membershipOmissionIsCanonical(
        acknowledgement.entity, workspace, state, omissionProof,
      )
    }
    return factCovers(payloadEntity, acknowledgement.entity)
      && factCovers(stateEntity, acknowledgement.entity)
  } catch { return false }
}

const captureMembershipContext = (name, command, previous, state) => {
  if (!['createMembership', 'editMembership'].includes(name)) return null
  try {
    const membership = name === 'editMembership' ? previous : null
    const participantId = membership?.participantId ?? command.participantId
    const groupId = membership?.groupId ?? command.groupId
    const programId = membership?.programId
      ?? captureActivityParticipant(state.participantsById[participantId]).programId
    const group = captureActivityGroup(state.groupsById[groupId])
    const participant = captureActivityParticipant(
      state.participantsById[participantId],
    )
    if (group.id !== groupId || group.programId !== programId
      || participant.programId !== programId) throw new TypeError('Invalid membership graph')
    return Object.freeze({ membership, group, participant, programId })
  } catch { throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED') }
}

const captureMembershipOmissionProof = (name, context, activityScope) => {
  if (activityScope !== 'specialist' || context === null) return null
  return Object.freeze({
    kind: name === 'createMembership' ? 'create' : 'edit',
    scope: activityScope, membership: context.membership,
    group: context.group, participant: context.participant,
  })
}

const loadedActivityClassMonth = (state, classId) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(state.classesById, classId)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Activity class is not loaded')
    }
    const date = Object.getOwnPropertyDescriptor(descriptor.value, 'date')
    if (!date?.enumerable || !Object.hasOwn(date, 'value')
      || typeof date.value !== 'string') throw new TypeError('Activity class is invalid')
    return date.value.slice(0, 7)
  } catch {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
}

const ACTIVITY_PREVIOUS_SPECS = Object.freeze({
  editGroup: Object.freeze({ map: 'groupsById', capture: captureActivityGroup }),
  editParticipant: Object.freeze({ map: 'participantsById', capture: captureActivityParticipant }),
  editMembership: Object.freeze({ map: 'membershipsById', capture: captureActivityMembership }),
  editClass: Object.freeze({ map: 'classesById', capture: captureActivityClass }),
})

const capturePreviousActivityFact = (name, targetId, command, state) => {
  const spec = ACTIVITY_PREVIOUS_SPECS[name]
  if (!spec) return null
  try {
    const previous = spec.capture(state[spec.map][targetId])
    if (previous.id !== targetId || previous.version !== command.expectedVersion) {
      throw new TypeError('Activity fact version mismatch')
    }
    return previous
  } catch { throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED') }
}

const captureActivityCommandCall = (name, rawArgs, state, activityScope) => {
  const spec = ACTIVITY_COMMAND_SPECS[name]
  if (!spec || !Array.isArray(rawArgs)) fail('Invalid activity command')
  const expectedLength = spec.id ? 3 : 2
  if (rawArgs.length !== expectedLength) fail('Invalid activity command')
  const window = captureActivityMonthWindow(rawArgs.at(-1))
  const repositoryArgs = []
  let targetId = null
  if (spec.id) {
    targetId = rawArgs[0]
    if (!spec.id(targetId)) fail('Invalid activity command ID')
    repositoryArgs.push(targetId)
  }
  const command = spec.capture(rawArgs[spec.id ? 1 : 0])
  const previous = capturePreviousActivityFact(name, targetId, command, state)
  const membershipContext = captureMembershipContext(name, command, previous, state)
  repositoryArgs.push(command)
  const months = [window.from, window.to]
  if (spec.existingClass) months.push(loadedActivityClassMonth(state, targetId))
  if (spec.classDate) months.push(command.date.slice(0, 7))
  const expanded = { from: months.reduce((left, value) => value < left ? value : left),
    to: months.reduce((left, value) => value > left ? value : left) }
  let reconciliation
  try { reconciliation = captureActivityMonthWindow(expanded) } catch {
    throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  }
  return Object.freeze({
    repositoryArgs: Object.freeze(repositoryArgs),
    reconciliation, command, targetId, previous, membershipContext,
    omissionProof: captureMembershipOmissionProof(name, membershipContext, activityScope),
  })
}

export const createWorkspaceProviderController = (options) => {
  const captured = captureExactRecord(options, [
    'repositoryFactory', 'dispatch', 'getState', 'authorityKey', 'clearToasts',
  ], 'workspace provider')
  if (typeof captured.dispatch !== 'function' || typeof captured.getState !== 'function'
    || typeof captured.clearToasts !== 'function' || typeof captured.authorityKey !== 'string') {
    fail('Invalid workspace provider')
  }

  let authorityKey = captured.authorityKey
  let activityScope = activityScopeForAuthorityKey(authorityKey)
  const repositoryFactory = captured.repositoryFactory
  let repository = repositoryFrom(repositoryFactory, captured.dispatch, captured.getState)
  let loadedState = createLoadedWorkspaceState()
  let loadedActivitiesState = createLoadedActivitiesState()
  let pendingLoads = 0
  let pendingActivityLoads = 0
  let readOnly = false
  let clientMutationLocked = false
  let historicalActivationLock = null
  let appointmentMutationLocked = false
  let paymentMutationLock = null
  let activityMutationLocked = false
  let activityLoadSequence = 0
  let infrastructureError = null
  let snapshot
  const listeners = new Set()

  const nextActivityLoadCapture = (requested) => {
    if (activityLoadSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Activity load sequence exhausted')
    }
    activityLoadSequence += 1
    return captureLoadedActivitiesLoad(
      loadedActivitiesState, requested, activityLoadSequence,
    )
  }

  const status = () => readOnly ? 'read-only-error' : pendingLoads > 0 ? 'loading' : 'ready'
  const activityStatus = () => readOnly
    ? 'read-only-error'
    : pendingActivityLoads > 0 || activityMutationLocked ? 'loading' : 'ready'
  const publish = () => {
    const activities = repository?.activities === null || repository?.activities === undefined
      ? null
      : Object.freeze({
        status: activityStatus(),
        loadedMonths: loadedActivitiesState.loadedMonths,
        state: loadedActivitiesState,
        loadWindow: loadActivityWindow,
        createGroup: activityCommands.createGroup,
        editGroup: activityCommands.editGroup,
        createParticipant: activityCommands.createParticipant,
        editParticipant: activityCommands.editParticipant,
        createMembership: activityCommands.createMembership,
        editMembership: activityCommands.editMembership,
        createClass: activityCommands.createClass,
        editClass: activityCommands.editClass,
        setAttendance: activityCommands.setAttendance,
      })
    snapshot = Object.freeze({
      loadedState,
      loadedActivitiesState,
      clientMutationLocked,
      appointmentMutationLocked,
      paymentMutationLocked: paymentMutationLock !== null,
      workspace: Object.freeze({
        status: status(),
        loadedRanges: loadedState.loadedRanges,
        activities,
        loadWindow,
        createClient: commands.createClient,
        editClient: commands.editClient,
        archiveClient: commands.archiveClient,
        activateHistoricalClient: commands.activateHistoricalClient,
        createAppointment: commands.createAppointment,
        editAppointment: commands.editAppointment,
        cancelAppointment: commands.cancelAppointment,
        recordPayment: commands.recordPayment,
        correctPayment: commands.correctPayment,
      }),
    })
    for (const listener of listeners) listener()
  }

  const enterReadOnly = (error, generation) => {
    if (loadedState.authorityGeneration !== generation) return
    readOnly = true
    infrastructureError = error
    publish()
  }

  async function loadWindow(requested) {
    if (readOnly || repository === null) throw readOnlyError()
    let capture = captureLoadedWorkspaceLoad(loadedState, requested)
    const generation = capture.authorityGeneration
    const operationRepository = repository
    pendingLoads += 1
    publish()
    try {
      while (true) {
        let rawPayload
        try {
          rawPayload = await operationRepository.loadWindow(Object.freeze({
            from: capture.from,
            to: capture.to,
          }))
        } catch (error) {
          if (loadedState.authorityGeneration !== generation) throw staleAuthorityError()
          if (infrastructureFailure(error)) enterReadOnly(error, generation)
          throw error
        }
        if (loadedState.authorityGeneration !== generation) throw staleAuthorityError()
        let merged
        try {
          merged = mergeLoadedWorkspaceLoad(loadedState, capture, rawPayload)
        } catch (error) {
          enterReadOnly(error, generation)
          throw error
        }
        loadedState = merged.state
        if (!merged.refetch) {
          if (historicalActivationReconciled(loadedState, historicalActivationLock)) {
            clientMutationLocked = false
            historicalActivationLock = null
          }
          appointmentMutationLocked = false
          if (paymentLockReconciledBy(paymentMutationLock, capture)) paymentMutationLock = null
          publish()
          return rawPayload
        }
        capture = captureLoadedWorkspaceLoad(loadedState, {
          from: capture.from,
          to: capture.to,
        })
      }
    } finally {
      if (loadedState.authorityGeneration === generation) {
        pendingLoads = Math.max(0, pendingLoads - 1)
        publish()
      }
    }
  }

  async function performActivityLoad(requested, {
    operationRepository = repository?.activities,
    expectedGeneration = loadedActivitiesState.authorityGeneration,
  } = {}) {
    if (operationRepository === null || operationRepository === undefined) throw readOnlyError()
    let capture = nextActivityLoadCapture(requested)
    const generation = capture.authorityGeneration
    if (generation !== expectedGeneration) throw staleAuthorityError()
    pendingActivityLoads += 1
    publish()
    let attempts = 0
    try {
      while (true) {
        attempts += 1
        let rawPayload
        try {
          rawPayload = await operationRepository.loadWindow(Object.freeze({
            from: capture.from, to: capture.to,
          }))
        } catch (error) {
          if (loadedActivitiesState.authorityGeneration !== generation) {
            throw staleAuthorityError()
          }
          if (infrastructureFailure(error)) enterReadOnly(error, generation)
          throw error
        }
        if (loadedActivitiesState.authorityGeneration !== generation) {
          throw staleAuthorityError()
        }
        let merged
        try {
          merged = mergeLoadedActivitiesLoad(loadedActivitiesState, capture, rawPayload)
        } catch (error) {
          enterReadOnly(error, generation)
          throw error
        }
        loadedActivitiesState = merged.state
        publish()
        if (!merged.refetch) return rawPayload
        if (attempts >= ACTIVITY_LOAD_MAX_ATTEMPTS) {
          const error = fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
          enterReadOnly(error, generation)
          throw error
        }
        capture = nextActivityLoadCapture({
          from: capture.from, to: capture.to,
        })
      }
    } finally {
      if (loadedActivitiesState.authorityGeneration === generation) {
        pendingActivityLoads = Math.max(0, pendingActivityLoads - 1)
        publish()
      }
    }
  }

  async function loadActivityWindow(requested) {
    if (readOnly || repository?.activities === null || repository?.activities === undefined) {
      throw readOnlyError()
    }
    return performActivityLoad(requested)
  }

  const activityCommands = Object.fromEntries(ACTIVITY_COMMAND_METHODS.map((name) => [name,
    async (...rawArgs) => {
      if (readOnly || repository?.activities === null || repository?.activities === undefined) {
        throw readOnlyError()
      }
      if (activityMutationLocked) throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
      const call = captureActivityCommandCall(
        name, rawArgs, loadedActivitiesState, activityScope,
      )
      const generation = loadedActivitiesState.authorityGeneration
      const operationRepository = repository.activities
      let mutationAccepted = false
      activityMutationLocked = true
      publish()
      try {
        const result = await operationRepository[name](...call.repositoryArgs)
        if (loadedActivitiesState.authorityGeneration !== generation) {
          throw staleAuthorityError()
        }
        mutationAccepted = true
        const acknowledgement = captureActivityAcknowledgement(name, result, call)
        loadedActivitiesState = recordLoadedActivitiesWrite(loadedActivitiesState)
        publish()
        const canonicalWorkspace = await performActivityLoad(call.reconciliation, {
          operationRepository,
          expectedGeneration: generation,
        })
        if (loadedActivitiesState.authorityGeneration !== generation) {
          throw staleAuthorityError()
        }
        if (!activityAcknowledgedBy(
          acknowledgement, canonicalWorkspace, loadedActivitiesState, call.omissionProof,
        )) throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
        activityMutationLocked = false
        publish()
        return result
      } catch (error) {
        if (loadedActivitiesState.authorityGeneration !== generation) {
          throw staleAuthorityError()
        }
        if (mutationAccepted || infrastructureFailure(error)) enterReadOnly(error, generation)
        throw error
      } finally {
        if (loadedActivitiesState.authorityGeneration === generation && !mutationAccepted) {
          activityMutationLocked = false
          publish()
        }
      }
    },
  ]))

  const commands = Object.fromEntries(WORKSPACE_METHODS.map((name) => [name,
    async (...args) => {
      if (readOnly || repository === null) throw readOnlyError()
      if (CLIENT_MUTATION_METHODS.has(name) && clientMutationLocked) {
        throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
      }
      if (APPOINTMENT_MUTATION_METHODS.has(name) && appointmentMutationLocked) {
        throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
      }
      if (PAYMENT_MUTATION_METHODS.has(name) && paymentMutationLock !== null) {
        throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
      }
      const generation = loadedState.authorityGeneration
      const operationRepository = repository
      const nextPaymentMutationLock = PAYMENT_MUTATION_METHODS.has(name)
        ? paymentLockForCommand(name, loadedState, args)
        : null
      const nextHistoricalActivationLock = name === 'activateHistoricalClient'
        ? historicalActivationLockFor(args)
        : null
      try {
        const result = await operationRepository[name](...args)
        if (loadedState.authorityGeneration !== generation) throw staleAuthorityError()
        if (CLIENT_MUTATION_METHODS.has(name)) clientMutationLocked = true
        if (name === 'activateHistoricalClient') {
          historicalActivationLock = nextHistoricalActivationLock
        }
        if (APPOINTMENT_MUTATION_METHODS.has(name)) appointmentMutationLocked = true
        if (PAYMENT_MUTATION_METHODS.has(name)) paymentMutationLock = nextPaymentMutationLock
        loadedState = recordLoadedWorkspaceWrite(loadedState)
        publish()
        return result
      } catch (error) {
        if (loadedState.authorityGeneration !== generation) throw staleAuthorityError()
        if (infrastructureFailure(error)) enterReadOnly(error, generation)
        throw error
      }
    },
  ]))

  const resetAuthority = (nextAuthorityKey) => {
    if (typeof nextAuthorityKey !== 'string') fail('Invalid workspace authority key')
    if (nextAuthorityKey === authorityKey) return false
    authorityKey = nextAuthorityKey
    activityScope = activityScopeForAuthorityKey(nextAuthorityKey)
    repository = null
    loadedState = resetLoadedWorkspaceAuthority(loadedState)
    loadedActivitiesState = resetLoadedActivitiesAuthority(loadedActivitiesState)
    activityLoadSequence = 0
    pendingLoads = 0
    pendingActivityLoads = 0
    readOnly = true
    clientMutationLocked = false
    historicalActivationLock = null
    appointmentMutationLocked = false
    paymentMutationLock = null
    activityMutationLocked = false
    infrastructureError = resetFailedError()
    publish()
    try {
      captured.clearToasts()
      repository = repositoryFrom(repositoryFactory, captured.dispatch, captured.getState)
    } catch {
      throw resetFailedError()
    }
    readOnly = false
    infrastructureError = null
    publish()
    return true
  }

  const subscribe = (listener) => {
    if (typeof listener !== 'function') fail('Invalid workspace subscriber')
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  publish()
  return Object.freeze({
    getSnapshot: () => snapshot,
    resetAuthority,
    subscribe,
  })
}
