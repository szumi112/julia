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

const API_METHODS = Object.freeze([
  'loadActivityWorkspace',
  'createActivityGroup', 'editActivityGroup',
  'createActivityParticipant', 'editActivityParticipant',
  'createActivityMembership', 'editActivityMembership',
  'createActivityClass', 'editActivityClass', 'setActivityAttendance',
  'createIdempotencyKey',
])

const REPOSITORY_METHODS = Object.freeze([
  'loadWindow',
  'createGroup', 'editGroup',
  'createParticipant', 'editParticipant',
  'createMembership', 'editMembership',
  'createClass', 'editClass', 'setAttendance',
])

const ACTION_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/

const fail = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }

const fixedError = (code) => Object.assign(new Error(code), { code })
const invalidResponse = () => { throw fixedError('INVALID_RESPONSE') }

const exact = (value, keys, field, { frozen = false } = {}) => {
  let descriptors
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || (frozen && !Object.isFrozen(value))) fail(field)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch { fail(field) }
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) fail(field)
  const captured = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(field)
    captured[key] = descriptor.value
  }
  return captured
}

const apiDependency = (value) => {
  const captured = exact(value, API_METHODS, 'api', { frozen: true })
  for (const name of API_METHODS) if (typeof captured[name] !== 'function') fail('api')
  return captured
}

const checkedId = (value, predicate, field) => {
  if (!predicate(value)) fail(field)
  return value
}

const capturedResponse = (value, capture) => {
  try {
    if (!Object.isFrozen(value)) invalidResponse()
    return capture(value)
  } catch {
    invalidResponse()
  }
}

const capturedGroupResponse = (value) => {
  try {
    const result = exact(value, ['group', 'groupLeaders'], 'response', { frozen: true })
    if (!Object.isFrozen(result.group) || !Object.isFrozen(result.groupLeaders)) {
      invalidResponse()
    }
    const group = captureActivityGroup(result.group)
    if (!Array.isArray(result.groupLeaders)
      || Object.getPrototypeOf(result.groupLeaders) !== Array.prototype
      || result.groupLeaders.length > 20) invalidResponse()
    const descriptors = Object.getOwnPropertyDescriptors(result.groupLeaders)
    if (Reflect.ownKeys(descriptors).length !== result.groupLeaders.length + 1) {
      invalidResponse()
    }
    const groupLeaders = []
    let previous = null
    for (let index = 0; index < result.groupLeaders.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
        || !Object.isFrozen(descriptor.value)) invalidResponse()
      const leader = captureActivityGroupLeader(descriptor.value)
      if (leader.groupId !== group.id || leader.status !== 'active'
        || (previous !== null && leader.id <= previous)) invalidResponse()
      previous = leader.id
      groupLeaders.push(leader)
    }
    return Object.freeze({ group, groupLeaders: Object.freeze(groupLeaders) })
  } catch {
    invalidResponse()
  }
}

const groupResponseFor = (value, leaderSpecialistIds) => {
  const result = capturedGroupResponse(value)
  const returned = result.groupLeaders.map(({ specialistId }) => specialistId)
    .sort((left, right) => left.localeCompare(right))
  if (returned.length !== leaderSpecialistIds.length
    || returned.some((id, index) => id !== leaderSpecialistIds[index])) invalidResponse()
  return result
}

const emptyIdentityRegistry = () => ({
  groups: new Map(), participants: new Map(), memberships: new Map(), classes: new Map(),
})

const clonedIdentityRegistry = (source) => ({
  groups: new Map(source.groups),
  participants: new Map(source.participants),
  memberships: new Map(source.memberships),
  classes: new Map(source.classes),
})

const membershipIdentity = ({ participantId, programId, groupId }) => (
  `${participantId}\n${programId}\n${groupId}`
)

const registerIdentity = (registry, kind, id, identity) => {
  const current = registry[kind].get(id)
  if (current !== undefined && current !== identity) invalidResponse()
  registry[kind].set(id, identity)
}

const knownIdentity = (registry, kind, id) => {
  const identity = registry[kind].get(id)
  if (identity === undefined) throw fixedError('WORKSPACE_RECONCILIATION_REQUIRED')
  return identity
}

const registryWithWorkspace = (current, workspace) => {
  const next = clonedIdentityRegistry(current)
  for (const group of workspace.groups) {
    registerIdentity(next, 'groups', group.id, group.programId)
  }
  for (const participant of workspace.participants) {
    registerIdentity(next, 'participants', participant.id, participant.programId)
  }
  for (const membership of workspace.memberships) {
    registerIdentity(next, 'memberships', membership.id, membershipIdentity(membership))
    if (next.participants.get(membership.participantId) !== membership.programId
      || next.groups.get(membership.groupId) !== membership.programId) invalidResponse()
  }
  for (const activityClass of workspace.classes) {
    registerIdentity(next, 'classes', activityClass.id, activityClass.groupId)
    if (!next.groups.has(activityClass.groupId)) invalidResponse()
  }
  return next
}

export function createApiActivityRepository(options) {
  const { api: source } = exact(options, ['api'], 'repository')
  const api = apiDependency(source)
  let identities = emptyIdentityRegistry()
  const action = async (invoke) => {
    const idempotencyKey = api.createIdempotencyKey()
    if (typeof idempotencyKey !== 'string' || !ACTION_KEY.test(idempotencyKey)) {
      fail('idempotencyKey')
    }
    return invoke(Object.freeze({ idempotencyKey }))
  }
  const commitIdentity = (kind, id, identity) => {
    const next = clonedIdentityRegistry(identities)
    registerIdentity(next, kind, id, identity)
    identities = next
  }

  const repository = {
    async loadWindow(input) {
      const result = capturedResponse(
        await api.loadActivityWorkspace(captureActivityMonthWindow(input)),
        captureActivityWorkspace,
      )
      identities = registryWithWorkspace(identities, result)
      return result
    },
    async createGroup(input) {
      const command = captureCreateActivityGroupCommand(input)
      const result = await action(
        (requestOptions) => api.createActivityGroup(command, requestOptions),
      )
      const captured = groupResponseFor(result, command.leaderSpecialistIds)
      const group = captured.group
      if (group.programId !== command.programId) invalidResponse()
      commitIdentity('groups', group.id, group.programId)
      return captured
    },
    async editGroup(id, input) {
      checkedId(id, isActivityGroupId, 'groupId')
      const command = captureEditActivityGroupCommand(input)
      const expectedProgramId = knownIdentity(identities, 'groups', id)
      const result = await action(
        (requestOptions) => api.editActivityGroup(id, command, requestOptions),
      )
      const captured = groupResponseFor(result, command.leaderSpecialistIds)
      const group = captured.group
      if (group.id !== id || group.programId !== expectedProgramId) invalidResponse()
      commitIdentity('groups', group.id, group.programId)
      return captured
    },
    async createParticipant(input) {
      const command = captureCreateActivityParticipantCommand(input)
      const result = await action(
        (requestOptions) => api.createActivityParticipant(command, requestOptions),
      )
      const participant = capturedResponse(result, captureActivityParticipant)
      if (participant.programId !== command.programId) invalidResponse()
      commitIdentity('participants', participant.id, participant.programId)
      return result
    },
    async editParticipant(id, input) {
      checkedId(id, isActivityParticipantId, 'participantId')
      const command = captureEditActivityParticipantCommand(input)
      const expectedProgramId = knownIdentity(identities, 'participants', id)
      const result = await action(
        (requestOptions) => api.editActivityParticipant(id, command, requestOptions),
      )
      const participant = capturedResponse(result, captureActivityParticipant)
      if (participant.id !== id || participant.programId !== expectedProgramId) invalidResponse()
      commitIdentity('participants', participant.id, participant.programId)
      return result
    },
    async createMembership(input) {
      const command = captureCreateActivityMembershipCommand(input)
      const participantProgramId = knownIdentity(
        identities, 'participants', command.participantId,
      )
      const groupProgramId = knownIdentity(identities, 'groups', command.groupId)
      if (participantProgramId !== groupProgramId) fail('membership')
      const result = await action(
        (requestOptions) => api.createActivityMembership(command, requestOptions),
      )
      const membership = capturedResponse(result, captureActivityMembership)
      if (membership.participantId !== command.participantId
        || membership.groupId !== command.groupId
        || membership.programId !== participantProgramId) invalidResponse()
      commitIdentity('memberships', membership.id, membershipIdentity(membership))
      return result
    },
    async editMembership(id, input) {
      checkedId(id, isActivityMembershipId, 'membershipId')
      const command = captureEditActivityMembershipCommand(input)
      const expectedIdentity = knownIdentity(identities, 'memberships', id)
      const result = await action(
        (requestOptions) => api.editActivityMembership(id, command, requestOptions),
      )
      const membership = capturedResponse(result, captureActivityMembership)
      if (membership.id !== id || membershipIdentity(membership) !== expectedIdentity) {
        invalidResponse()
      }
      commitIdentity('memberships', membership.id, expectedIdentity)
      return result
    },
    async createClass(input) {
      const command = captureCreateActivityClassCommand(input)
      knownIdentity(identities, 'groups', command.groupId)
      const result = await action(
        (requestOptions) => api.createActivityClass(command, requestOptions),
      )
      const activityClass = capturedResponse(result, captureActivityClass)
      if (activityClass.groupId !== command.groupId) invalidResponse()
      commitIdentity('classes', activityClass.id, activityClass.groupId)
      return result
    },
    async editClass(id, input) {
      checkedId(id, isActivityClassId, 'classId')
      const command = captureEditActivityClassCommand(input)
      const expectedGroupId = knownIdentity(identities, 'classes', id)
      const result = await action(
        (requestOptions) => api.editActivityClass(id, command, requestOptions),
      )
      const activityClass = capturedResponse(result, captureActivityClass)
      if (activityClass.id !== id || activityClass.groupId !== expectedGroupId) invalidResponse()
      commitIdentity('classes', activityClass.id, activityClass.groupId)
      return result
    },
    async setAttendance(classId, input) {
      checkedId(classId, isActivityClassId, 'classId')
      const command = captureSetActivityAttendanceCommand(input)
      const groupId = knownIdentity(identities, 'classes', classId)
      const groupProgramId = knownIdentity(identities, 'groups', groupId)
      const participantProgramId = knownIdentity(
        identities, 'participants', command.participantId,
      )
      if (groupProgramId !== participantProgramId) fail('attendance')
      const result = await action((requestOptions) => api.setActivityAttendance(
        classId, command, requestOptions,
      ))
      const captured = capturedResponse(result, captureActivityAttendance)
      if (captured.classId !== classId || captured.participantId !== command.participantId
        || captured.status !== command.status
        || captured.version !== command.expectedVersion + 1
        || (command.expectedVersion === 0 && captured.updatedAt !== captured.createdAt)) {
        invalidResponse()
      }
      return captured
    },
  }
  if (Object.keys(repository).some((name) => !REPOSITORY_METHODS.includes(name))) {
    fail('repository')
  }
  return Object.freeze(repository)
}
