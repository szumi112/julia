import assert from 'node:assert/strict'
import test from 'node:test'
import { createApiActivityRepository } from '../../src/activity-repository.js'

const METHODS = [
  'createClass', 'createGroup', 'createMembership', 'createParticipant',
  'editClass', 'editGroup', 'editMembership', 'editParticipant',
  'loadWindow', 'setAttendance',
]

const groupCreate = () => ({
  programId: 'apg_tus', label: 'Grupa TUS', details: null,
  leaderSpecialistIds: ['sp_anna', 'sp_julia'],
})
const groupEdit = () => ({
  expectedVersion: 1, label: 'Grupa TUS A', details: 'Wtorki', status: 'active',
  leaderSpecialistIds: ['sp_julia'],
})
const participantCreate = () => ({
  programId: 'apg_tus', name: 'Fikcyjna Tusia', clientId: null,
  historicalClientId: 'hcl_tusia',
})
const participantEdit = () => ({
  expectedVersion: 1, name: 'Fikcyjna Tusia A', clientId: 'cl_tusia',
  historicalClientId: null, status: 'active',
})
const membershipCreate = () => ({
  participantId: 'acp_tusia', groupId: 'agr_tus', startsOn: '2026-08-01', endsOn: null,
})
const membershipEdit = () => ({
  expectedVersion: 1, startsOn: '2026-08-02', endsOn: '2026-12-31', status: 'active',
})
const classCreate = () => ({
  groupId: 'agr_tus', date: '2026-08-12', time: '16:30', durationMinutes: 90,
  topic: 'Emocje', status: 'scheduled',
})
const classEdit = () => ({
  expectedVersion: 1, date: '2026-09-02', time: null, durationMinutes: null,
  topic: null, status: 'completed',
})
const attendanceSet = () => ({
  participantId: 'acp_tusia', status: 'present', expectedVersion: 0,
})

const NOW = '2026-08-01T10:00:00.000Z'
const LATER = '2026-08-02T10:00:00.000Z'

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const program = (code) => ({
  id: `apg_${code}`, code, label: code === 'tus' ? 'TUS' : 'Angielski',
  status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
})
const group = (overrides = {}) => ({
  id: 'agr_tus', programId: 'apg_tus', label: 'Grupa TUS', details: null,
  status: 'active', version: 1, createdAt: NOW, updatedAt: NOW, ...overrides,
})
const leader = (specialistId, overrides = {}) => ({
  id: `agl_tus_${specialistId.slice(3)}`, groupId: 'agr_tus', specialistId,
  startsOn: '2026-08-01', endsOn: null, status: 'active', version: 1,
  createdAt: NOW, updatedAt: NOW, ...overrides,
})
const participant = (overrides = {}) => ({
  id: 'acp_tusia', programId: 'apg_tus', name: 'Fikcyjna Tusia', clientId: null,
  historicalClientId: 'hcl_tusia', status: 'active', version: 1,
  createdAt: NOW, updatedAt: NOW, ...overrides,
})
const membership = (overrides = {}) => ({
  id: 'amb_tusia', participantId: 'acp_tusia', programId: 'apg_tus',
  groupId: 'agr_tus', membershipKind: 'interval',
  period: { precision: 'unknown', day: null, month: null },
  startsOn: '2026-08-01', endsOn: null, status: 'active', version: 1,
  createdAt: NOW, updatedAt: NOW, ...overrides,
})
const activityClass = (overrides = {}) => ({
  id: 'acl_tus_august', groupId: 'agr_tus', date: '2026-08-12', time: '16:30',
  durationMinutes: 90, topic: 'Emocje', status: 'scheduled', version: 1,
  createdAt: NOW, updatedAt: NOW, ...overrides,
})
const attendance = (overrides = {}) => ({
  id: 'aat_tus_august', classId: 'acl_tus_august', participantId: 'acp_tusia',
  status: 'present', version: 1, createdAt: NOW, updatedAt: NOW, ...overrides,
})

const workspace = ({ from, to = from }, overrides = {}) => deepFreeze({
  from, to, complete: true, currentDay: '2026-08-28',
  latestPopulatedMonths: { tus: null, english: null },
  programs: [], groups: [], groupLeaders: [], participants: [], memberships: [],
  classes: [], attendance: [], charges: [], payments: [], ...overrides,
})

const groupResult = (input, overrides = {}) => deepFreeze({
  group: group({
    programId: input.programId ?? 'apg_tus', label: input.label,
    details: input.details, status: input.status ?? 'active',
    version: input.expectedVersion === undefined ? 1 : input.expectedVersion + 1,
    updatedAt: input.expectedVersion === undefined ? NOW : LATER,
    ...overrides,
  }),
  groupLeaders: input.leaderSpecialistIds.map((specialistId) => leader(specialistId)),
})

const participantResult = (input, overrides = {}) => deepFreeze(participant({
  programId: input.programId ?? 'apg_tus', name: input.name, clientId: input.clientId,
  historicalClientId: input.historicalClientId, status: input.status ?? 'active',
  version: input.expectedVersion === undefined ? 1 : input.expectedVersion + 1,
  updatedAt: input.expectedVersion === undefined ? NOW : LATER,
  ...overrides,
}))

const membershipResult = (input, overrides = {}) => deepFreeze(membership({
  participantId: input.participantId ?? 'acp_tusia', groupId: input.groupId ?? 'agr_tus',
  startsOn: input.startsOn, endsOn: input.endsOn, status: input.status ?? 'active',
  version: input.expectedVersion === undefined ? 1 : input.expectedVersion + 1,
  updatedAt: input.expectedVersion === undefined ? NOW : LATER,
  ...overrides,
}))

const classResult = (input, overrides = {}) => deepFreeze(activityClass({
  groupId: input.groupId ?? 'agr_tus', date: input.date, time: input.time,
  durationMinutes: input.durationMinutes, topic: input.topic, status: input.status,
  version: input.expectedVersion === undefined ? 1 : input.expectedVersion + 1,
  updatedAt: input.expectedVersion === undefined ? NOW : LATER,
  ...overrides,
}))

const apiDouble = () => {
  const calls = []
  let sequence = 0
  const api = {
    loadActivityWorkspace: async (window) => {
      calls.push(['loadActivityWorkspace', window])
      return workspace(window)
    },
    createActivityGroup: async (input, options) => {
      calls.push(['createActivityGroup', input, options])
      return groupResult(input)
    },
    editActivityGroup: async (id, input, options) => {
      calls.push(['editActivityGroup', id, input, options])
      return groupResult(input, { id, programId: 'apg_tus' })
    },
    createActivityParticipant: async (input, options) => {
      calls.push(['createActivityParticipant', input, options])
      return participantResult(input)
    },
    editActivityParticipant: async (id, input, options) => {
      calls.push(['editActivityParticipant', id, input, options])
      return participantResult(input, { id, programId: 'apg_tus' })
    },
    createActivityMembership: async (input, options) => {
      calls.push(['createActivityMembership', input, options])
      return membershipResult(input)
    },
    editActivityMembership: async (id, input, options) => {
      calls.push(['editActivityMembership', id, input, options])
      return membershipResult(input, {
        id, participantId: 'acp_tusia', programId: 'apg_tus', groupId: 'agr_tus',
      })
    },
    createActivityClass: async (input, options) => {
      calls.push(['createActivityClass', input, options])
      return classResult(input)
    },
    editActivityClass: async (id, input, options) => {
      calls.push(['editActivityClass', id, input, options])
      return classResult(input, { id, groupId: 'agr_tus' })
    },
    setActivityAttendance: async (id, input, options) => {
      calls.push(['setActivityAttendance', id, input, options])
      return deepFreeze(attendance({
        classId: id, participantId: input.participantId, status: input.status,
        version: input.expectedVersion + 1,
        updatedAt: input.expectedVersion === 0 ? NOW : LATER,
      }))
    },
    createIdempotencyKey: () => `activity-repository-key-${++sequence}`,
  }
  return { api: Object.freeze(api), calls }
}

test('exposes one exact frozen protected activity repository interface', () => {
  const { api } = apiDouble()
  const repository = createApiActivityRepository({ api })
  assert.deepEqual(Object.keys(repository).sort(), METHODS)
  assert.equal(Object.isFrozen(repository), true)
  for (const method of METHODS) assert.equal(typeof repository[method], 'function')
})

test('delegates exact captured commands with one fresh idempotency key each', async () => {
  const { api, calls } = apiDouble()
  const repository = createApiActivityRepository({ api })
  const values = [
    groupCreate(), groupEdit(), participantCreate(), participantEdit(),
    membershipCreate(), membershipEdit(), classCreate(), classEdit(), attendanceSet(),
  ]
  const results = []
  results.push(await repository.loadWindow({ from: '2026-08', to: '2026-09' }))
  results.push(await repository.createGroup(values[0]))
  results.push(await repository.editGroup('agr_tus', values[1]))
  results.push(await repository.createParticipant(values[2]))
  results.push(await repository.editParticipant('acp_tusia', values[3]))
  results.push(await repository.createMembership(values[4]))
  results.push(await repository.editMembership('amb_tusia', values[5]))
  results.push(await repository.createClass(values[6]))
  results.push(await repository.editClass('acl_tus_august', values[7]))
  results.push(await repository.setAttendance('acl_tus_august', values[8]))

  assert.deepEqual([
    results[0].complete, results[1].group.id, results[2].group.id,
    results[3].id, results[4].id, results[5].id, results[6].id,
    results[7].id, results[8].id, results[9].id,
  ], [
    true, 'agr_tus', 'agr_tus', 'acp_tusia', 'acp_tusia', 'amb_tusia',
    'amb_tusia', 'acl_tus_august', 'acl_tus_august', 'aat_tus_august',
  ])
  const option = (index) => Object.freeze({
    idempotencyKey: `activity-repository-key-${index}`,
  })
  assert.deepEqual(calls, [
    ['loadActivityWorkspace', { from: '2026-08', to: '2026-09' }],
    ['createActivityGroup', values[0], option(1)],
    ['editActivityGroup', 'agr_tus', values[1], option(2)],
    ['createActivityParticipant', values[2], option(3)],
    ['editActivityParticipant', 'acp_tusia', values[3], option(4)],
    ['createActivityMembership', values[4], option(5)],
    ['editActivityMembership', 'amb_tusia', values[5], option(6)],
    ['createActivityClass', values[6], option(7)],
    ['editActivityClass', 'acl_tus_august', values[7], option(8)],
    ['setActivityAttendance', 'acl_tus_august', values[8], option(9)],
  ])
  assert.deepEqual(values, [
    groupCreate(), groupEdit(), participantCreate(), participantEdit(),
    membershipCreate(), membershipEdit(), classCreate(), classEdit(), attendanceSet(),
  ])
})

test('rejects immutable group, participant, membership and class parent swaps on edit', async () => {
  const cases = [
    {
      method: 'editActivityGroup',
      response: async (id, input) => groupResult(input, { id, programId: 'apg_english' }),
      setup: (repository) => repository.createGroup(groupCreate()),
      invoke: (repository) => repository.editGroup('agr_tus', groupEdit()),
    },
    {
      method: 'editActivityParticipant',
      response: async (id, input) => participantResult(input, {
        id, programId: 'apg_english',
      }),
      setup: (repository) => repository.createParticipant(participantCreate()),
      invoke: (repository) => repository.editParticipant('acp_tusia', participantEdit()),
    },
    {
      method: 'editActivityMembership',
      response: async (id, input) => membershipResult(input, {
        id, participantId: 'acp_other', programId: 'apg_english', groupId: 'agr_other',
      }),
      setup: async (repository) => {
        await repository.createGroup(groupCreate())
        await repository.createParticipant(participantCreate())
        await repository.createMembership(membershipCreate())
      },
      invoke: (repository) => repository.editMembership('amb_tusia', membershipEdit()),
    },
    {
      method: 'editActivityClass',
      response: async (id, input) => classResult(input, { id, groupId: 'agr_other' }),
      setup: async (repository) => {
        await repository.createGroup(groupCreate())
        await repository.createClass(classCreate())
      },
      invoke: (repository) => repository.editClass('acl_tus_august', classEdit()),
    },
  ]

  for (const item of cases) {
    const { api: baseApi } = apiDouble()
    const repository = createApiActivityRepository({
      api: Object.freeze({ ...baseApi, [item.method]: item.response }),
    })
    await item.setup(repository)
    await assert.rejects(item.invoke(repository), { code: 'INVALID_RESPONSE' })
  }
})

test('rejects same-ID reparenting from later workspace loads and create results', async () => {
  const programs = [program('english'), program('tus')]
  const original = workspace({ from: '2026-08' }, { programs, groups: [group()] })
  const reparented = workspace({ from: '2026-09' }, {
    programs, groups: [group({ programId: 'apg_english' })],
  })
  let loadIndex = 0
  const { api: loadApi } = apiDouble()
  const loadRepository = createApiActivityRepository({
    api: Object.freeze({
      ...loadApi,
      loadActivityWorkspace: async () => [original, reparented][loadIndex++],
    }),
  })
  await loadRepository.loadWindow({ from: '2026-08', to: '2026-08' })
  await assert.rejects(
    loadRepository.loadWindow({ from: '2026-09', to: '2026-09' }),
    { code: 'INVALID_RESPONSE' },
  )

  const { api: createApi } = apiDouble()
  const createRepository = createApiActivityRepository({
    api: Object.freeze({
      ...createApi,
      loadActivityWorkspace: async () => original,
      createActivityGroup: async (input) => groupResult(input, {
        id: 'agr_tus', programId: 'apg_english',
      }),
    }),
  })
  await createRepository.loadWindow({ from: '2026-08', to: '2026-08' })
  await assert.rejects(createRepository.createGroup({
    programId: 'apg_english', label: 'Nowa grupa', details: null,
    leaderSpecialistIds: [],
  }), { code: 'INVALID_RESPONSE' })
})

test('requires membership result program to match its known participant and group', async () => {
  const { api: baseApi } = apiDouble()
  const repository = createApiActivityRepository({
    api: Object.freeze({
      ...baseApi,
      createActivityMembership: async (input) => membershipResult(input, {
        programId: 'apg_english',
      }),
    }),
  })
  await repository.createGroup(groupCreate())
  await repository.createParticipant(participantCreate())
  await assert.rejects(repository.createMembership(membershipCreate()), {
    code: 'INVALID_RESPONSE',
  })
})

test('rejects hostile dependencies, malformed IDs and commands before keys or API calls', async () => {
  const { api, calls } = apiDouble()
  let reads = 0
  const accessor = { ...api }
  Object.defineProperty(accessor, 'createActivityGroup', {
    enumerable: true,
    get() { reads += 1; return api.createActivityGroup },
  })
  assert.throws(() => createApiActivityRepository({ api: accessor }), /VALIDATION_FAILED/)
  assert.equal(reads, 0)
  assert.throws(
    () => createApiActivityRepository({ api: { ...api, extra() {} } }),
    /VALIDATION_FAILED/,
  )

  const repository = createApiActivityRepository({ api })
  const hostile = Object.defineProperty(groupCreate(), 'label', {
    enumerable: true,
    get() { reads += 1; return 'Private' },
  })
  await assert.rejects(repository.createGroup(hostile), /activity group command/i)
  await assert.rejects(repository.editGroup('cl_wrong_kind', groupEdit()), /group/i)
  await assert.rejects(repository.setAttendance('agr_wrong_kind', attendanceSet()), /class/i)
  await assert.rejects(repository.loadWindow({ from: '2026-01', to: '2027-01' }), /month window/i)
  assert.equal(reads, 0)
  assert.deepEqual(calls, [])
})

test('rejects a malformed generated key without partially invoking a command', async () => {
  const { api, calls } = apiDouble()
  const repository = createApiActivityRepository({
    api: Object.freeze({ ...api, createIdempotencyKey: () => 'bad key' }),
  })
  await assert.rejects(repository.createGroup(groupCreate()), /VALIDATION_FAILED\/idempotencyKey/)
  assert.deepEqual(calls, [])
})

test('rejects malformed group leader results instead of returning untrusted nested facts', async () => {
  const { api: baseApi } = apiDouble()
  const repository = createApiActivityRepository({
    api: Object.freeze({
      ...baseApi,
      createActivityGroup: async (input) => deepFreeze({
        group: groupResult(input).group,
        groupLeaders: [{ private: 'unvalidated' }],
      }),
    }),
  })

  await assert.rejects(repository.createGroup(groupCreate()), { code: 'INVALID_RESPONSE' })
})

test('returns canonical group leaders and binds them to the requested specialist set', async () => {
  const { api } = apiDouble()
  const repository = createApiActivityRepository({ api })

  const result = await repository.createGroup(groupCreate())

  assert.deepEqual(result.groupLeaders.map(({ specialistId }) => specialistId), [
    'sp_anna', 'sp_julia',
  ])
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.groupLeaders), true)
  assert.equal(Object.isFrozen(result.groupLeaders[0]), true)
})

test('captures and binds attendance results before returning them', async () => {
  const loaded = workspace({ from: '2026-08' }, {
    latestPopulatedMonths: { tus: '2026-08', english: null },
    programs: [program('tus')], groups: [group()], participants: [participant()],
    memberships: [membership()], classes: [activityClass()], attendance: [],
  })
  const { api: baseApi } = apiDouble()
  const validRepository = createApiActivityRepository({
    api: Object.freeze({ ...baseApi, loadActivityWorkspace: async () => loaded }),
  })
  await validRepository.loadWindow({ from: '2026-08', to: '2026-08' })
  const result = await validRepository.setAttendance('acl_tus_august', attendanceSet())
  assert.deepEqual(result, attendance())
  assert.equal(Object.isFrozen(result), true)

  for (const response of [
    attendance({ classId: 'acl_other' }),
    attendance({ participantId: 'acp_other' }),
    attendance({ status: 'absent' }),
    attendance({ version: 2, updatedAt: LATER }),
    { private: 'unvalidated' },
  ]) {
    const repository = createApiActivityRepository({
      api: Object.freeze({
        ...baseApi,
        loadActivityWorkspace: async () => loaded,
        setActivityAttendance: async () => deepFreeze(response),
      }),
    })
    await repository.loadWindow({ from: '2026-08', to: '2026-08' })
    await assert.rejects(
      repository.setAttendance('acl_tus_august', attendanceSet()),
      { code: 'INVALID_RESPONSE' },
    )
  }
})
