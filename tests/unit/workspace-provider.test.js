import test from 'node:test'
import assert from 'node:assert/strict'

import * as workspaceProvider from '../../src/workspace-provider.js'
import { captureActivityWorkspace } from '../../src/activity-records.js'
import { createApiActivityRepository } from '../../src/activity-repository.js'

const { createWorkspaceAuthorityKey, createWorkspaceProviderController } = workspaceProvider

const WORKSPACE_KEYS = [
  'activateHistoricalClient', 'activities', 'archiveClient', 'cancelAppointment', 'correctPayment',
  'createAppointment', 'createClient', 'editAppointment', 'editClient', 'loadWindow',
  'loadedRanges', 'recordPayment', 'status',
]
const ACTIVITY_KEYS = [
  'createClass', 'createGroup', 'createMembership', 'createParticipant',
  'editClass', 'editGroup', 'editMembership', 'editParticipant',
  'loadWindow', 'loadedMonths', 'setAttendance', 'state', 'status',
]
const range = (from, to = from) => ({ from, to })
const specialist = () => ({
  id: 'sp_anna', displayName: 'Anna', professionalTitle: 'Specjalistka',
  status: 'active', version: 1,
})
const client = () => ({
  id: 'cl_ola', name: 'Ola', status: 'active', readOnly: false,
  assignment: { id: 'asg_ola', specialistId: 'sp_anna' },
})
const paymentAppointment = (paymentEntries = []) => ({
  id: 'apt_ola', clientId: 'cl_ola', specialistId: 'sp_anna',
  startsAt: '2026-08-04T10:00:00.000Z',
  charge: { id: 'chg_ola' }, paymentEntries,
})
const paymentEntry = (overrides = {}) => ({
  id: 'pay_ola', amountGrosze: 100, method: 'cash',
  receivedAt: '2026-08-04T10:00:00.000Z', correctedAt: null, replacementEntryId: null,
  ...overrides,
})
const historicalClient = (overrides = {}) => ({
  id: 'hcl_ola', name: 'Ola Historyczna', status: 'historical', activeClientId: null,
  version: 1, createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-01T08:00:00.000Z', ...overrides,
})
const historicalOccurrence = () => ({
  id: 'hoc_ola', historicalClientId: 'hcl_ola', counterparty: null,
  specialistId: 'sp_anna', serviceId: null, serviceLabel: 'Usługa historyczna',
  period: { precision: 'month', day: null, month: '2026-07' }, status: 'recorded',
  version: 1, sourceRecordId: 'wbs_ola', createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-07-01T08:00:00.000Z',
})
const payload = (from, to = from, appointments = [], historical = null) => ({
  window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
  specialists: [specialist()], clients: [client()], appointments,
  historicalClients: historical === null ? [] : [historicalClient(historical)],
  historicalOccurrences: historical === null ? [] : [historicalOccurrence()],
  latestPopulatedMonth: historical === null ? null : '2026-07',
})
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const withFixedDate = async (value, callback) => {
  const NativeDate = globalThis.Date
  class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length === 0 ? [value] : args)) }
    static now() { return new NativeDate(value).getTime() }
  }
  globalThis.Date = FixedDate
  try { return await callback() } finally { globalThis.Date = NativeDate }
}
const repositoryWith = (overrides = {}) => Object.freeze({
  loadWindow: async ({ from, to }) => payload(from, to),
  createClient: async (input) => ({ id: 'cl_created', input }),
  editClient: async () => ({}), archiveClient: async () => ({}),
  activateHistoricalClient: async () => ({}),
  createAppointment: async () => ({}), editAppointment: async () => ({}),
  cancelAppointment: async () => ({}), recordPayment: async () => ({}),
  correctPayment: async () => ({}), activities: null, ...overrides,
})

const activityPayload = (from, to = from, overrides = {}) => ({
  from, to, complete: true, currentDay: '2026-08-28',
  latestPopulatedMonths: { tus: null, english: null },
  programs: [], groups: [], groupLeaders: [], participants: [], memberships: [],
  classes: [], attendance: [], charges: [], payments: [], ...overrides,
})

const activityRepositoryWith = (overrides = {}) => Object.freeze({
  loadWindow: async ({ from, to }) => activityPayload(from, to),
  createGroup: async () => ({}), editGroup: async () => ({}),
  createParticipant: async () => ({}), editParticipant: async () => ({}),
  createMembership: async () => ({}), editMembership: async () => ({}),
  createClass: async () => ({}), editClass: async () => ({}),
  setAttendance: async () => ({}), ...overrides,
})

const activityProgram = () => ({
  id: 'apg_tus', code: 'tus', label: 'TUS', status: 'active', version: 1,
  createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z',
})
const activityGroup = () => ({
  id: 'agr_tus', programId: 'apg_tus', label: 'Grupa TUS', details: null,
  status: 'active', version: 1, createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
})
const activityLeader = (overrides = {}) => ({
  id: 'agl_tus', groupId: 'agr_tus', specialistId: 'sp_anna',
  startsOn: '2026-08-01', endsOn: null, status: 'active', version: 1,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z', ...overrides,
})
const activityGroupResult = (overrides = {}) => ({
  group: { ...activityGroup(), ...overrides }, groupLeaders: [],
})
const activityParticipant = (overrides = {}) => ({
  id: 'acp_tus', programId: 'apg_tus', name: 'Fikcyjna Tusia', clientId: null,
  historicalClientId: null, status: 'active', version: 1,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z', ...overrides,
})
const activityMembership = (overrides = {}) => ({
  id: 'amb_tus', participantId: 'acp_tus', programId: 'apg_tus',
  groupId: 'agr_tus', membershipKind: 'interval',
  period: { precision: 'unknown', day: null, month: null },
  startsOn: '2026-08-01', endsOn: '2026-08-31', status: 'inactive', version: 2,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z', ...overrides,
})
const activityDirectoryPayload = (from, to = from, overrides = {}) => activityPayload(from, to, {
  programs: [activityProgram()], groups: [activityGroup()], ...overrides,
})
const activityClass = (month = '2026-08', overrides = {}) => ({
  id: 'acl_tus', groupId: 'agr_tus', date: `${month}-12`, time: '16:30',
  durationMinutes: 90, topic: 'Emocje', status: 'scheduled', version: 1,
  createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z',
  ...overrides,
})
const activityClassPayload = (from, to, month, overrides = {}) => activityPayload(from, to, {
  programs: [activityProgram()], groups: [activityGroup()],
  classes: [activityClass(month, overrides)],
})

const makeController = (repositoryFactory, overrides = {}) => createWorkspaceProviderController({
  repositoryFactory,
  dispatch: overrides.dispatch || (() => {}),
  getState: overrides.getState || (() => ({ demoRoleId: 'owner' })),
  authorityKey: overrides.authorityKey || 'authority-one',
  clearToasts: overrides.clearToasts || (() => {}),
})

const protectedAuthorityKey = (role) => createWorkspaceAuthorityKey({
  repositoryMode: 'api', dataMode: 'fictional', actorId: `stf_${role}`,
  actorVersion: 1, role, specialistId: role === 'specialist' ? 'sp_anna' : null,
  capabilities: [], demoRoleId: null, demoAuthGeneration: null,
})

const stale = { code: 'WORKSPACE_AUTHORITY_STALE', message: 'WORKSPACE_AUTHORITY_STALE' }

test('exposes the exact workspace contract and constructs one repository with exact dependencies', () => {
  const dispatch = () => {}
  const getState = () => ({})
  let dependencies
  let factoryCalls = 0
  const controller = makeController((received) => {
    factoryCalls += 1
    dependencies = received
    return repositoryWith()
  }, { dispatch, getState })
  assert.deepEqual(Object.keys(controller.getSnapshot().workspace).sort(), WORKSPACE_KEYS)
  assert.deepEqual(Reflect.ownKeys(dependencies).sort(), ['dispatch', 'getState'])
  assert.equal(dependencies.dispatch, dispatch)
  assert.equal(dependencies.getState, getState)
  assert.ok(Object.isFrozen(dependencies))
  assert.equal(controller.getSnapshot().workspace.activities, null)
  controller.getSnapshot()
  assert.equal(factoryCalls, 1)
})

test('protected activities expose an exact frozen boundary and load without touching demo reducer state', async () => {
  const state = { tusGroups: [{ id: 'demo-group' }], tusKids: [], tusClasses: [], tusPayments: [] }
  const activityCalls = []
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      loadWindow: async (window) => {
        activityCalls.push(window)
        return activityPayload(window.from, window.to)
      },
    }),
  }), { getState: () => state })
  const activities = controller.getSnapshot().workspace.activities
  assert.deepEqual(Object.keys(activities).sort(), ACTIVITY_KEYS)
  assert.equal(Object.isFrozen(activities), true)
  assert.equal(Object.isFrozen(activities.state), true)
  assert.deepEqual(activities.loadedMonths, [])

  await activities.loadWindow({ from: '2026-08', to: '2026-09' })
  assert.deepEqual(activityCalls, [{ from: '2026-08', to: '2026-09' }])
  assert.deepEqual(controller.getSnapshot().workspace.activities.loadedMonths, [
    { from: '2026-08', to: '2026-09' },
  ])
  assert.deepEqual(state.tusGroups, [{ id: 'demo-group' }])
  assert.deepEqual(controller.getSnapshot().loadedState.loadedRanges, [])
})

test('activity commands resolve only after their explicit reconciliation window reloads', async () => {
  const reload = deferred()
  const events = []
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      createGroup: async (body) => {
        events.push(['command', body])
        return activityGroupResult()
      },
      loadWindow: async (window) => {
        events.push(['load', window])
        return reload.promise
      },
    }),
  }))
  const body = {
    programId: 'apg_tus', label: 'Grupa TUS', details: null, leaderSpecialistIds: [],
  }
  let settled = false
  const pending = controller.getSnapshot().workspace.activities
    .createGroup(body, { from: '2026-08', to: '2026-08' })
    .finally(() => { settled = true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(controller.getSnapshot().workspace.activities.status, 'loading')
  assert.deepEqual(events, [
    ['command', body], ['load', { from: '2026-08', to: '2026-08' }],
  ])

  reload.resolve(activityDirectoryPayload('2026-08'))
  assert.deepEqual(await pending, activityGroupResult())
  assert.equal(controller.getSnapshot().loadedActivitiesState.writeEpoch, 1)
  assert.equal(controller.getSnapshot().workspace.activities.status, 'ready')
})

test('activity acknowledgement recapture preserves the reconciliation request month', async () => {
  const reload = deferred()
  let pending
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      createParticipant: async () => activityParticipant(),
      loadWindow: async () => reload.promise,
    }),
  }))
  await withFixedDate('2026-08-31T21:59:59.000Z', async () => {
    pending = controller.getSnapshot().workspace.activities.createParticipant({
      programId: 'apg_tus', name: 'Fikcyjna Tusia', clientId: null,
      historicalClientId: null,
    }, { from: '2026-09', to: '2026-09' })
    await Promise.resolve()
    await Promise.resolve()
  })
  const observation = {
    ...activityMembership(), id: 'amb_observed_tus', membershipKind: 'observation',
    period: { precision: 'month', day: null, month: '2026-09' },
    startsOn: null, endsOn: null, status: 'active', version: 1,
    updatedAt: '2026-08-01T10:00:00.000Z',
  }

  await withFixedDate('2026-08-31T22:00:01.000Z', async () => {
    reload.resolve(activityDirectoryPayload('2026-09', '2026-09', {
      participants: [activityParticipant()], memberships: [observation],
    }))
    await assert.doesNotReject(pending)
  })
  assert.equal(controller.getSnapshot().workspace.activities.status, 'ready')
})

test('accepted activity commands fail closed when reload omits the acknowledged entity', async () => {
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      createGroup: async () => activityGroupResult(),
      loadWindow: async ({ from, to }) => activityPayload(from, to),
    }),
  }))

  await assert.rejects(controller.getSnapshot().workspace.activities.createGroup({
    programId: 'apg_tus', label: 'Grupa TUS', details: null, leaderSpecialistIds: [],
  }, { from: '2026-08', to: '2026-08' }), {
    code: 'WORKSPACE_RECONCILIATION_REQUIRED',
  })
  assert.equal(controller.getSnapshot().workspace.activities.status, 'read-only-error')
  await assert.rejects(
    controller.getSnapshot().workspace.activities.createGroup({}, {}),
    { code: 'WORKSPACE_READ_ONLY' },
  )
})

test('centre authorities reject an omitted inactive membership acknowledgement', async () => {
  for (const role of ['owner', 'coordinator']) {
    let loads = 0
    const controller = makeController(() => repositoryWith({
      activities: activityRepositoryWith({
        editMembership: async () => activityMembership(),
        loadWindow: async ({ from, to }) => {
          loads += 1
          return activityDirectoryPayload(from, to, {
            participants: [activityParticipant()],
            memberships: loads === 1 ? [activityMembership({
              endsOn: null, status: 'active', version: 1,
              updatedAt: '2026-08-01T10:00:00.000Z',
            })] : [],
          })
        },
      }),
    }), { authorityKey: protectedAuthorityKey(role) })
    const activities = controller.getSnapshot().workspace.activities
    await activities.loadWindow({ from: '2026-08', to: '2026-08' })

    await assert.rejects(activities.editMembership('amb_tus', {
      expectedVersion: 1, startsOn: '2026-08-01', endsOn: '2026-08-31',
      status: 'inactive',
    }, { from: '2026-08', to: '2026-08' }), {
      code: 'WORKSPACE_RECONCILIATION_REQUIRED',
    })
    assert.equal(controller.getSnapshot().workspace.activities.status, 'read-only-error')
  }
})

test('provider binds a repository membership acknowledgement to the captured command', async () => {
  let loads = 0
  const api = Object.freeze({
    loadActivityWorkspace: async ({ from, to }) => {
      loads += 1
      return captureActivityWorkspace(activityDirectoryPayload(from, to, {
        participants: [activityParticipant()],
        memberships: loads === 1 ? [activityMembership({
          endsOn: null, status: 'active', version: 1,
          updatedAt: '2026-08-01T10:00:00.000Z',
        })] : [],
      }))
    },
    createActivityGroup: async () => {}, editActivityGroup: async () => {},
    createActivityParticipant: async () => {}, editActivityParticipant: async () => {},
    createActivityMembership: async () => {},
    editActivityMembership: async () => Object.freeze(activityMembership()),
    createActivityClass: async () => {}, editActivityClass: async () => {},
    setActivityAttendance: async () => {},
    createIdempotencyKey: () => 'activity-test-key',
  })
  const controller = makeController(() => repositoryWith({
    activities: createApiActivityRepository({ api }),
  }), { authorityKey: protectedAuthorityKey('specialist') })
  const activities = controller.getSnapshot().workspace.activities
  await activities.loadWindow({ from: '2026-08', to: '2026-08' })

  await assert.rejects(activities.editMembership('amb_tus', {
    expectedVersion: 1, startsOn: '2026-08-01', endsOn: '2026-08-31',
    status: 'active',
  }, { from: '2026-08', to: '2026-08' }), {
    code: 'WORKSPACE_RECONCILIATION_REQUIRED',
  })
  assert.equal(loads, 1)
  assert.equal(controller.getSnapshot().workspace.activities.status, 'read-only-error')
})

test('ending the sole scoped membership reconciles when its participant leaves the reload', async () => {
  let loads = 0
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      editMembership: async () => activityMembership(),
      loadWindow: async ({ from, to }) => {
        loads += 1
        if (loads === 1) {
          return activityDirectoryPayload(from, to, {
            participants: [activityParticipant()],
            memberships: [activityMembership({
              endsOn: null, status: 'active', version: 1,
              updatedAt: '2026-08-01T10:00:00.000Z',
            })],
          })
        }
        return activityDirectoryPayload(from, to)
      },
    }),
  }), { authorityKey: protectedAuthorityKey('specialist') })
  const activities = controller.getSnapshot().workspace.activities
  await activities.loadWindow({ from: '2026-08', to: '2026-08' })

  await assert.doesNotReject(activities.editMembership('amb_tus', {
    expectedVersion: 1, startsOn: '2026-08-01', endsOn: '2026-08-31',
    status: 'inactive',
  }, { from: '2026-08', to: '2026-08' }))
  assert.equal(loads, 2)
  assert.equal(controller.getSnapshot().workspace.activities.status, 'ready')
  assert.equal(
    controller.getSnapshot().workspace.activities.state.participantsById.acp_tus,
    undefined,
  )
})

test('a specialist reconciles a newly created future interval omitted by scoped reload', async () => {
  let loads = 0
  const future = activityMembership({
    startsOn: '9999-01-01', endsOn: null, status: 'active', version: 1,
    updatedAt: '2026-08-01T10:00:00.000Z',
  })
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      createMembership: async () => future,
      loadWindow: async ({ from, to }) => {
        loads += 1
        return activityDirectoryPayload(from, to, loads === 1
          ? { participants: [activityParticipant()] }
          : {})
      },
    }),
  }), { authorityKey: protectedAuthorityKey('specialist') })
  const activities = controller.getSnapshot().workspace.activities
  await activities.loadWindow({ from: '2026-08', to: '2026-08' })

  await assert.doesNotReject(activities.createMembership({
    participantId: 'acp_tus', groupId: 'agr_tus', startsOn: '9999-01-01', endsOn: null,
  }, { from: '2026-08', to: '2026-08' }))
  assert.equal(controller.getSnapshot().workspace.activities.status, 'ready')
  assert.equal(controller.getSnapshot().loadedActivitiesState.membershipsById.amb_tus, undefined)
})

test('a specialist rejects omission of a currently effective created interval', async () => {
  let loads = 0
  const current = activityMembership({
    startsOn: '2020-01-01', endsOn: null, status: 'active', version: 1,
    updatedAt: '2026-08-01T10:00:00.000Z',
  })
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      createMembership: async () => current,
      loadWindow: async ({ from, to }) => {
        loads += 1
        return activityDirectoryPayload(from, to, loads === 1
          ? { participants: [activityParticipant()] }
          : {})
      },
    }),
  }), { authorityKey: protectedAuthorityKey('specialist') })
  const activities = controller.getSnapshot().workspace.activities
  await activities.loadWindow({ from: '2026-08', to: '2026-08' })

  await assert.rejects(activities.createMembership({
    participantId: 'acp_tus', groupId: 'agr_tus', startsOn: '2020-01-01', endsOn: null,
  }, { from: '2026-08', to: '2026-08' }), {
    code: 'WORKSPACE_RECONCILIATION_REQUIRED',
  })
  assert.equal(controller.getSnapshot().workspace.activities.status, 'read-only-error')
})

test('specialist membership visibility uses the server-trusted day, not the browser clock', async () => {
  let loads = 0
  const currentAtServer = activityMembership({
    startsOn: '2026-08-01', endsOn: '2026-08-31', status: 'active', version: 1,
    updatedAt: '2026-08-01T10:00:00.000Z',
  })
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      createMembership: async () => currentAtServer,
      loadWindow: async ({ from, to }) => {
        loads += 1
        return activityDirectoryPayload(from, to, loads === 1
          ? { participants: [activityParticipant()] }
          : { currentDay: '2026-08-28' })
      },
    }),
  }), { authorityKey: protectedAuthorityKey('specialist') })
  const activities = controller.getSnapshot().workspace.activities
  await activities.loadWindow({ from: '2026-08', to: '2026-08' })

  await withFixedDate('2026-09-01T10:00:00.000Z', async () => {
    await assert.rejects(activities.createMembership({
      participantId: 'acp_tus', groupId: 'agr_tus',
      startsOn: '2026-08-01', endsOn: '2026-08-31',
    }, { from: '2026-08', to: '2026-08' }), {
      code: 'WORKSPACE_RECONCILIATION_REQUIRED',
    })
  })
  assert.equal(controller.getSnapshot().workspace.activities.status, 'read-only-error')
})

test('a specialist reconciles an omitted active interval that ended in the past', async () => {
  let loads = 0
  const historical = activityMembership({
    startsOn: '2019-01-01', endsOn: '2020-01-01', status: 'active', version: 1,
    updatedAt: '2026-08-01T10:00:00.000Z',
  })
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      createMembership: async () => historical,
      loadWindow: async ({ from, to }) => {
        loads += 1
        return activityDirectoryPayload(from, to, loads === 1
          ? { participants: [activityParticipant()] }
          : { currentDay: '2026-08-28' })
      },
    }),
  }), { authorityKey: protectedAuthorityKey('specialist') })
  const activities = controller.getSnapshot().workspace.activities
  await activities.loadWindow({ from: '2026-08', to: '2026-08' })

  await assert.doesNotReject(activities.createMembership({
    participantId: 'acp_tus', groupId: 'agr_tus',
    startsOn: '2019-01-01', endsOn: '2020-01-01',
  }, { from: '2026-08', to: '2026-08' }))
  assert.equal(controller.getSnapshot().workspace.activities.status, 'ready')
})

test('a specialist reconciles a future interval edit omitted by scoped reload', async () => {
  let loads = 0
  const future = activityMembership({
    startsOn: '9999-01-01', endsOn: null, status: 'active', version: 2,
  })
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      editMembership: async () => future,
      loadWindow: async ({ from, to }) => {
        loads += 1
        return activityDirectoryPayload(from, to, loads === 1 ? {
          participants: [activityParticipant()],
          memberships: [activityMembership({
            endsOn: null, status: 'active', version: 1,
            updatedAt: '2026-08-01T10:00:00.000Z',
          })],
        } : {})
      },
    }),
  }), { authorityKey: protectedAuthorityKey('specialist') })
  const activities = controller.getSnapshot().workspace.activities
  await activities.loadWindow({ from: '2026-08', to: '2026-08' })

  await assert.doesNotReject(activities.editMembership('amb_tus', {
    expectedVersion: 1, startsOn: '9999-01-01', endsOn: null, status: 'active',
  }, { from: '2026-08', to: '2026-08' }))
  assert.equal(controller.getSnapshot().workspace.activities.status, 'ready')
  assert.equal(controller.getSnapshot().loadedActivitiesState.membershipsById.amb_tus, undefined)
})

test('group reconciliation requires every acknowledged active leader at the same version', async () => {
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      createGroup: async () => ({
        group: activityGroup(), groupLeaders: [activityLeader()],
      }),
      loadWindow: async ({ from, to }) => activityDirectoryPayload(from, to),
    }),
  }))

  await assert.rejects(controller.getSnapshot().workspace.activities.createGroup({
    programId: 'apg_tus', label: 'Grupa TUS', details: null,
    leaderSpecialistIds: ['sp_anna'],
  }, { from: '2026-08', to: '2026-08' }), {
    code: 'WORKSPACE_RECONCILIATION_REQUIRED',
  })
  assert.equal(controller.getSnapshot().workspace.activities.status, 'read-only-error')
})

test('successful activity mutation followed by failed canonical reload is read-only and rejects', async () => {
  const privateFailure = Object.assign(new Error('private transport'), { code: 'NETWORK_ERROR' })
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      createGroup: async () => activityGroupResult(),
      loadWindow: async () => { throw privateFailure },
    }),
  }))
  await assert.rejects(controller.getSnapshot().workspace.activities.createGroup({
    programId: 'apg_tus', label: 'Grupa TUS', details: null, leaderSpecialistIds: [],
  }, { from: '2026-08', to: '2026-08' }), { code: 'NETWORK_ERROR' })
  assert.equal(controller.getSnapshot().workspace.status, 'read-only-error')
  assert.equal(controller.getSnapshot().workspace.activities.status, 'read-only-error')
  await assert.rejects(
    controller.getSnapshot().workspace.activities.createGroup({ private: true }, { bad: true }),
    { code: 'WORKSPACE_READ_ONLY', message: 'WORKSPACE_READ_ONLY' },
  )
})

test('activity loads keep refetching until they cover a window after consecutive writes', async () => {
  const turns = Array.from({ length: 5 }, deferred)
  const requests = []
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      loadWindow: (window) => {
        requests.push(window)
        return turns[requests.length - 1].promise
      },
      createGroup: async () => activityGroupResult(),
    }),
  }))
  const body = {
    programId: 'apg_tus', label: 'Grupa TUS', details: null, leaderSpecialistIds: [],
  }
  const waitForRequests = async (count) => {
    for (let turn = 0; turn < 20 && requests.length < count; turn += 1) {
      await Promise.resolve()
    }
    assert.equal(requests.length, count)
  }

  let augustSettled = false
  const august = controller.getSnapshot().workspace.activities
    .loadWindow({ from: '2026-08', to: '2026-08' })
    .finally(() => { augustSettled = true })
  await waitForRequests(1)

  const septemberWrite = controller.getSnapshot().workspace.activities
    .createGroup(body, { from: '2026-09', to: '2026-09' })
  await waitForRequests(2)
  turns[1].resolve(activityDirectoryPayload('2026-09'))
  await septemberWrite

  turns[0].resolve(activityPayload('2026-08'))
  await waitForRequests(3)

  const octoberWrite = controller.getSnapshot().workspace.activities
    .createGroup(body, { from: '2026-10', to: '2026-10' })
  await waitForRequests(4)
  turns[3].resolve(activityDirectoryPayload('2026-10'))
  await octoberWrite

  turns[2].resolve(activityPayload('2026-08'))
  await waitForRequests(5)
  assert.equal(augustSettled, false)

  turns[4].resolve(activityDirectoryPayload('2026-08'))
  await august
  assert.deepEqual(requests, [
    { from: '2026-08', to: '2026-08' },
    { from: '2026-09', to: '2026-09' },
    { from: '2026-08', to: '2026-08' },
    { from: '2026-10', to: '2026-10' },
    { from: '2026-08', to: '2026-08' },
  ])
  assert.deepEqual(controller.getSnapshot().workspace.activities.loadedMonths, [
    { from: '2026-08', to: '2026-10' },
  ])
})

test('activity loads bound repeated same-generation stale-directory refetches', async () => {
  let loads = 0
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      loadWindow: async ({ from, to }) => {
        loads += 1
        return activityDirectoryPayload(from, to, {
          groupLeaders: [activityLeader(loads === 1 ? {
            version: 2, updatedAt: '2026-08-02T10:00:00.000Z',
          } : {})],
        })
      },
    }),
  }))
  const activities = controller.getSnapshot().workspace.activities
  await activities.loadWindow({ from: '2026-08', to: '2026-08' })

  await assert.rejects(
    activities.loadWindow({ from: '2026-09', to: '2026-09' }),
    { code: 'WORKSPACE_RECONCILIATION_REQUIRED' },
  )
  assert.equal(loads, 4)
  assert.equal(controller.getSnapshot().workspace.activities.status, 'read-only-error')
})

test('activity class edit reconciliation expands across cached old and requested new months', async () => {
  const loads = []
  const edits = []
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      loadWindow: async (window) => {
        loads.push(window)
        return loads.length === 1
          ? activityClassPayload('2026-08', '2026-08', '2026-08')
          : activityClassPayload('2026-08', '2026-09', '2026-09', {
            date: '2026-09-02', time: null, durationMinutes: null, topic: null,
            status: 'completed', version: 2, updatedAt: '2026-09-02T10:00:00.000Z',
          })
      },
      editClass: async (...args) => {
        edits.push(args)
        return activityClass('2026-09', {
          date: '2026-09-02', time: null, durationMinutes: null, topic: null,
          status: 'completed', version: 2, updatedAt: '2026-09-02T10:00:00.000Z',
        })
      },
    }),
  }))
  await controller.getSnapshot().workspace.activities.loadWindow({
    from: '2026-08', to: '2026-08',
  })
  const body = {
    expectedVersion: 1, date: '2026-09-02', time: null, durationMinutes: null,
    topic: null, status: 'completed',
  }
  await controller.getSnapshot().workspace.activities.editClass(
    'acl_tus', body, { from: '2026-09', to: '2026-09' },
  )
  assert.deepEqual(edits, [['acl_tus', body]])
  assert.deepEqual(loads, [
    { from: '2026-08', to: '2026-08' },
    { from: '2026-08', to: '2026-09' },
  ])
  assert.equal(
    controller.getSnapshot().workspace.activities.state.classesById.acl_tus.date,
    '2026-09-02',
  )
})

test('concurrent activity loads refetch an older directory response before it can roll facts back', async () => {
  const older = deferred()
  const newer = deferred()
  const refetched = deferred()
  const requests = []
  const controller = makeController(() => repositoryWith({
    activities: activityRepositoryWith({
      loadWindow: (window) => {
        requests.push(window)
        return [older.promise, newer.promise, refetched.promise][requests.length - 1]
      },
    }),
  }))
  const olderLoad = controller.getSnapshot().workspace.activities.loadWindow({
    from: '2026-08', to: '2026-08',
  })
  const newerLoad = controller.getSnapshot().workspace.activities.loadWindow({
    from: '2026-09', to: '2026-09',
  })
  newer.resolve(activityDirectoryPayload('2026-09', '2026-09', {
    groupLeaders: [activityLeader({
      endsOn: '2026-08-31', status: 'inactive', version: 2,
      updatedAt: '2026-09-01T10:00:00.000Z',
    })],
  }))
  await newerLoad
  older.resolve(activityDirectoryPayload('2026-08', '2026-08', {
    groupLeaders: [activityLeader()],
  }))
  for (let turn = 0; turn < 20 && requests.length < 3; turn += 1) await Promise.resolve()
  assert.equal(requests.length, 3)
  refetched.resolve(activityDirectoryPayload('2026-08', '2026-08', {
    groupLeaders: [activityLeader({
      endsOn: '2026-08-31', status: 'inactive', version: 2,
      updatedAt: '2026-09-01T10:00:00.000Z',
    })],
  }))
  await olderLoad

  const leader = controller.getSnapshot().workspace.activities.state
    .groupLeadersById.agl_tus
  assert.equal(leader.version, 2)
  assert.equal(leader.status, 'inactive')
  assert.deepEqual(requests, [
    { from: '2026-08', to: '2026-08' },
    { from: '2026-09', to: '2026-09' },
    { from: '2026-08', to: '2026-08' },
  ])
})

test('authority reset clears activity cache and masks old activity completion', async () => {
  const oldLoad = deferred()
  let factories = 0
  const controller = makeController(() => {
    factories += 1
    return repositoryWith({
      activities: activityRepositoryWith({
        loadWindow: factories === 1
          ? () => oldLoad.promise
          : async ({ from, to }) => activityPayload(from, to),
      }),
    })
  })
  const pending = controller.getSnapshot().workspace.activities.loadWindow({
    from: '2026-08', to: '2026-08',
  })
  controller.resetAuthority('authority-two')
  oldLoad.resolve(activityPayload('2026-08'))
  await assert.rejects(pending, stale)
  assert.deepEqual(controller.getSnapshot().workspace.activities.loadedMonths, [])
  assert.equal(controller.getSnapshot().loadedActivitiesState.authorityGeneration, 1)
})

test('rejects accessor-backed repositories without invoking their methods', () => {
  const repository = { ...repositoryWith() }
  let reads = 0
  Object.defineProperty(repository, 'loadWindow', {
    enumerable: true,
    get() { reads += 1; return async () => ({}) },
  })
  assert.throws(() => makeController(() => repository), TypeError)
  assert.equal(reads, 0)
})

test('tracks concurrent current-authority loads until all finish and normalizes coverage', async () => {
  const first = deferred()
  const second = deferred()
  let calls = 0
  const controller = makeController(() => repositoryWith({
    loadWindow: () => (++calls === 1 ? first.promise : second.promise),
  }))
  const one = controller.getSnapshot().workspace.loadWindow(range('2026-08-01', '2026-08-03'))
  const two = controller.getSnapshot().workspace.loadWindow(range('2026-08-03', '2026-08-05'))
  assert.equal(controller.getSnapshot().workspace.status, 'loading')
  second.resolve(payload('2026-08-03', '2026-08-05'))
  await two
  assert.equal(controller.getSnapshot().workspace.status, 'loading')
  first.resolve(payload('2026-08-01', '2026-08-03'))
  await one
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [range('2026-08-01', '2026-08-05')])
})

test('authority reset replaces repository, clears state and toasts, and rejects old completion', async () => {
  const oldLoad = deferred()
  let factoryCalls = 0
  let toastClears = 0
  const controller = makeController(() => {
    factoryCalls += 1
    return factoryCalls === 1
      ? repositoryWith({ loadWindow: () => oldLoad.promise })
      : repositoryWith()
  }, { clearToasts: () => { toastClears += 1 } })
  const pending = controller.getSnapshot().workspace.loadWindow(range('2026-08-01'))
  controller.resetAuthority('authority-two')
  assert.equal(factoryCalls, 2)
  assert.equal(toastClears, 1)
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
  oldLoad.resolve(payload('2026-08-01'))
  await assert.rejects(pending, stale)
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
})

test('every old-authority mutation completion is replaced by one fixed stale error', async () => {
  const methods = [
    'createClient', 'editClient', 'archiveClient', 'activateHistoricalClient', 'createAppointment',
    'editAppointment', 'cancelAppointment', 'recordPayment', 'correctPayment',
  ]
  for (const method of methods) {
    const turn = deferred()
    let factories = 0
    const controller = makeController(() => {
      factories += 1
      return factories === 1 ? repositoryWith({
        loadWindow: async ({ from, to }) => payload(from, to, method === 'recordPayment'
          ? [paymentAppointment()]
          : method === 'correctPayment'
            ? [paymentAppointment([paymentEntry()])]
          : []),
        [method]: () => turn.promise,
      }) : repositoryWith()
    })
    if (method === 'recordPayment' || method === 'correctPayment') {
      await controller.getSnapshot().workspace.loadWindow(range('2026-08-04'))
    }
    const command = method === 'recordPayment'
      ? controller.getSnapshot().workspace.recordPayment('apt_ola', 1, { amountGrosze: 100 })
      : method === 'correctPayment'
        ? controller.getSnapshot().workspace.correctPayment('pay_ola', 1, {
          reason: 'Korekta', replacement: null,
        })
        : method === 'activateHistoricalClient'
          ? controller.getSnapshot().workspace.activateHistoricalClient('hcl_ola', {
            expectedVersion: 1, specialistId: 'sp_anna',
          })
        : controller.getSnapshot().workspace[method]('private-input', { secret: true })
    controller.resetAuthority(`next-${method}`)
    turn.resolve({ secretDto: method })
    await assert.rejects(command, stale, method)
    assert.equal(controller.getSnapshot().loadedState.writeEpoch, 0)
    assert.equal(controller.getSnapshot().workspace.status, 'ready')
  }
})

test('old-authority load and mutation failures never disclose their original errors', async () => {
  const oldLoad = deferred()
  const oldMutation = deferred()
  let factories = 0
  const controller = makeController(() => {
    factories += 1
    return factories === 1
      ? repositoryWith({ loadWindow: () => oldLoad.promise, createClient: () => oldMutation.promise })
      : repositoryWith()
  })
  const loading = controller.getSnapshot().workspace.loadWindow(range('2026-08-01'))
  const mutating = controller.getSnapshot().workspace.createClient({ secret: true })
  controller.resetAuthority('authority-two')
  oldLoad.reject(Object.assign(new Error('private load'), { code: 'NETWORK_ERROR' }))
  oldMutation.reject(Object.assign(new Error('private mutation'), { code: 'VERSION_CONFLICT' }))
  await assert.rejects(loading, stale)
  await assert.rejects(mutating, stale)
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
})

test('failed replacement construction leaves the new authority empty and read-only', async () => {
  const events = []
  let oldCalls = 0
  let factories = 0
  const controller = makeController(() => {
    factories += 1
    events.push(`factory-${factories}`)
    if (factories === 2) throw new Error('private factory failure')
    return repositoryWith({ createClient: async () => { oldCalls += 1; return {} } })
  }, { clearToasts: () => { events.push('clear-toasts') } })
  await controller.getSnapshot().workspace.loadWindow(range('2026-08-01'))
  await controller.getSnapshot().workspace.createClient({})
  assert.throws(() => controller.resetAuthority('authority-broken'), {
    code: 'WORKSPACE_RESET_FAILED', message: 'WORKSPACE_RESET_FAILED',
  })
  assert.deepEqual(events, ['factory-1', 'clear-toasts', 'factory-2'])
  assert.equal(controller.getSnapshot().workspace.status, 'read-only-error')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
  assert.deepEqual([
    controller.getSnapshot().loadedState.authorityGeneration,
    controller.getSnapshot().loadedState.writeEpoch,
  ], [1, 0])
  await assert.rejects(controller.getSnapshot().workspace.loadWindow(range('2026-08-02')), {
    code: 'WORKSPACE_READ_ONLY', message: 'WORKSPACE_READ_ONLY',
  })
  await assert.rejects(controller.getSnapshot().workspace.createClient({}), {
    code: 'WORKSPACE_READ_ONLY', message: 'WORKSPACE_READ_ONLY',
  })
  assert.equal(oldCalls, 1)
})

test('toast reset failure prevents replacement construction and remains fail closed', () => {
  let factories = 0
  const controller = makeController(() => {
    factories += 1
    return repositoryWith()
  }, { clearToasts: () => { throw new Error('private toast failure') } })
  assert.throws(() => controller.resetAuthority('authority-broken'), {
    code: 'WORKSPACE_RESET_FAILED', message: 'WORKSPACE_RESET_FAILED',
  })
  assert.equal(factories, 1)
  assert.equal(controller.getSnapshot().workspace.status, 'read-only-error')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
})

test('demo role dispatch resets authority synchronously only for an accepted changed role', () => {
  const events = []
  let state = { demoRoleId: 'owner' }
  const dispatch = workspaceProvider.createAuthorityBoundDispatch({
    dispatch: (action) => { events.push(`dispatch-${action.roleId}`); state = { ...state, demoRoleId: action.roleId } },
    getState: () => state,
    resetAuthority: (key) => { events.push(`reset-${key}`) },
    authorityKeyFor: (next) => `role-${next.demoRoleId}`,
    demoRoleIds: ['owner', 'coordinator', 'therapist'],
  })
  dispatch({ type: 'SET_DEMO_ROLE', roleId: 'therapist' })
  assert.deepEqual(events, ['reset-role-therapist', 'dispatch-therapist'])
  events.length = 0
  dispatch({ type: 'SET_DEMO_ROLE', roleId: 'therapist' })
  dispatch({ type: 'SET_DEMO_ROLE', roleId: 'invalid' })
  assert.deepEqual(events, ['dispatch-therapist', 'dispatch-invalid'])
})

test('authority dispatch rejects unauthenticated action type descriptors before reducer access', () => {
  const calls = { dispatch: 0, getState: 0, getter: 0, reset: 0 }
  const dispatch = workspaceProvider.createAuthorityBoundDispatch({
    dispatch: () => { calls.dispatch += 1 },
    getState: () => { calls.getState += 1; return { demoRoleId: 'owner' } },
    resetAuthority: () => { calls.reset += 1 },
    authorityKeyFor: () => 'next',
    demoRoleIds: ['owner', 'coordinator', 'therapist'],
  })
  const inherited = Object.create({ type: 'SET_DEMO_ROLE' })
  const hidden = { roleId: 'therapist' }
  Object.defineProperty(hidden, 'type', { value: 'SET_DEMO_ROLE', enumerable: false })
  const accessor = { roleId: 'therapist' }
  Object.defineProperty(accessor, 'type', {
    enumerable: true,
    get() { calls.getter += 1; return 'SET_DEMO_ROLE' },
  })
  const trapped = new Proxy({ type: 'SET_DEMO_ROLE', roleId: 'therapist' }, {
    ownKeys() { throw new Error('private trap') },
  })
  const prototypeTrapped = new Proxy({ type: 'UPDATE_CLIENT' }, {
    getPrototypeOf() { throw new Error('private prototype trap') },
  })
  for (const action of [
    null, [], {}, inherited, hidden, accessor, trapped, prototypeTrapped,
    { type: Symbol('private') },
  ]) {
    assert.throws(() => dispatch(action), { name: 'TypeError', message: 'Invalid authority action' })
  }
  assert.deepEqual(calls, { dispatch: 0, getState: 0, getter: 0, reset: 0 })
})

test('role actions reject unauthenticated role descriptors without state or reducer access', () => {
  const calls = { dispatch: 0, getState: 0, getter: 0, reset: 0 }
  const dispatch = workspaceProvider.createAuthorityBoundDispatch({
    dispatch: () => { calls.dispatch += 1 },
    getState: () => { calls.getState += 1; return { demoRoleId: 'owner' } },
    resetAuthority: () => { calls.reset += 1 },
    authorityKeyFor: () => 'next',
    demoRoleIds: ['owner', 'coordinator', 'therapist'],
  })
  const inherited = Object.create({ roleId: 'therapist' })
  inherited.type = 'SET_DEMO_ROLE'
  const hidden = { type: 'SET_DEMO_ROLE' }
  Object.defineProperty(hidden, 'roleId', { value: 'therapist', enumerable: false })
  const accessor = { type: 'SET_DEMO_ROLE' }
  Object.defineProperty(accessor, 'roleId', {
    enumerable: true,
    get() { calls.getter += 1; return 'therapist' },
  })
  for (const action of [
    { type: 'SET_DEMO_ROLE' }, inherited, hidden, accessor,
    { type: 'SET_DEMO_ROLE', roleId: 7 },
    { type: 'SET_DEMO_ROLE', roleId: Symbol('private') },
  ]) assert.throws(() => dispatch(action), { name: 'TypeError', message: 'Invalid authority action' })
  assert.deepEqual(calls, { dispatch: 0, getState: 0, getter: 0, reset: 0 })
})

test('authority dispatch forwards one plain shallow snapshot and never the caller action', () => {
  const actions = []
  const dispatch = workspaceProvider.createAuthorityBoundDispatch({
    dispatch: (action) => { actions.push(action); return 'forwarded' },
    getState: () => { throw new Error('ordinary action read state') },
    resetAuthority: () => { throw new Error('ordinary action reset') },
    authorityKeyFor: () => { throw new Error('ordinary action key') },
    demoRoleIds: ['owner', 'coordinator', 'therapist'],
  })
  const nested = { patch: true }
  const action = { nested, type: 'UPDATE_CLIENT' }
  assert.equal(dispatch(action), 'forwarded')
  assert.notEqual(actions[0], action)
  assert.equal(Object.getPrototypeOf(actions[0]), Object.prototype)
  assert.deepEqual(actions[0], { nested, type: 'UPDATE_CLIENT' })
  assert.equal(actions[0].nested, nested)
  action.type = 'SET_DEMO_ROLE'
  assert.equal(actions[0].type, 'UPDATE_CLIENT')
})

test('authority dispatch defeats an equivocal proxy without invoking its get trap', () => {
  const actions = []
  let gets = 0
  let resets = 0
  const dispatch = workspaceProvider.createAuthorityBoundDispatch({
    dispatch: (action) => { actions.push(action) },
    getState: () => { throw new Error('proxy read state') },
    resetAuthority: () => { resets += 1 },
    authorityKeyFor: () => { throw new Error('proxy authority key') },
    demoRoleIds: ['owner', 'coordinator', 'therapist'],
  })
  const source = { type: 'UPDATE_CLIENT', id: 'cl_one' }
  const action = new Proxy(source, {
    get(target, key, receiver) {
      gets += 1
      if (key === 'type') return 'SET_DEMO_ROLE'
      if (key === 'roleId') return 'therapist'
      return Reflect.get(target, key, receiver)
    },
  })
  dispatch(action)
  assert.equal(gets, 0)
  assert.equal(resets, 0)
  assert.equal(actions.length, 1)
  assert.notEqual(actions[0], action)
  assert.deepEqual(actions[0], { type: 'UPDATE_CLIENT', id: 'cl_one' })
})

test('authority dispatch rejects malformed extra descriptors and oversized snapshots', () => {
  let reducerCalls = 0
  let getterCalls = 0
  const dispatch = workspaceProvider.createAuthorityBoundDispatch({
    dispatch: () => { reducerCalls += 1 },
    getState: () => ({ demoRoleId: 'owner' }),
    resetAuthority: () => {},
    authorityKeyFor: () => 'next',
    demoRoleIds: ['owner', 'coordinator', 'therapist'],
  })
  const accessor = { type: 'UPDATE_CLIENT' }
  Object.defineProperty(accessor, 'unused', {
    enumerable: true,
    get() { getterCalls += 1; return 'private' },
  })
  const hidden = { type: 'UPDATE_CLIENT' }
  Object.defineProperty(hidden, 'unused', { enumerable: false, value: true })
  const symbol = { type: 'UPDATE_CLIENT', [Symbol('private')]: true }
  const oversized = { type: 'UPDATE_CLIENT' }
  for (let index = 0; index < 32; index += 1) oversized[`field${index}`] = index
  for (const action of [accessor, hidden, symbol, oversized]) {
    assert.throws(() => dispatch(action), { name: 'TypeError', message: 'Invalid authority action' })
  }
  assert.equal(getterCalls, 0)
  assert.equal(reducerCalls, 0)
})

test('a successful write invalidates a captured load and causes one exact bounded refetch', async () => {
  const stale = deferred()
  const requests = []
  const controller = makeController(() => repositoryWith({
    loadWindow: (requested) => {
      requests.push(requested)
      return requests.length === 1 ? stale.promise : Promise.resolve(payload(requested.from, requested.to))
    },
  }))
  const requested = range('2026-08-10', '2026-08-12')
  const loading = controller.getSnapshot().workspace.loadWindow(requested)
  await controller.getSnapshot().workspace.createClient({ name: 'caller draft' })
  assert.equal(controller.getSnapshot().loadedState.writeEpoch, 1)
  stale.resolve(payload(requested.from, requested.to))
  await loading
  assert.deepEqual(requests, [requested, requested])
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [requested])
})

test('successful client commands stay locked until canonical reconciliation or authority reset', async () => {
  const controller = makeController(() => repositoryWith())
  await controller.getSnapshot().workspace.createClient({ name: 'Ola' })
  assert.equal(controller.getSnapshot().clientMutationLocked, true)
  await assert.rejects(
    controller.getSnapshot().workspace.createClient({ name: 'Ola ponownie' }),
    { code: 'WORKSPACE_RECONCILIATION_REQUIRED' }
  )

  await controller.getSnapshot().workspace.loadWindow(range('2026-08-04'))
  assert.equal(controller.getSnapshot().clientMutationLocked, false)

  await controller.getSnapshot().workspace.archiveClient('cl_ola', 1)
  assert.equal(controller.getSnapshot().clientMutationLocked, true)
  controller.resetAuthority('authority-two')
  assert.equal(controller.getSnapshot().clientMutationLocked, false)
})

test('accepted historical activation shares the client lock and unlocks only after the activated version is canonically reloaded', async () => {
  const conflict = Object.assign(new Error('conflict'), {
    code: 'VERSION_CONFLICT', status: 409,
  })
  let julyLoads = 0
  let activationCalls = 0
  const controller = makeController(() => repositoryWith({
    loadWindow: async ({ from, to }) => {
      if (from.startsWith('2026-07')) {
        julyLoads += 1
        if (julyLoads === 2) throw conflict
        return payload(from, to, [], julyLoads === 1 ? {} : {
          status: 'activated', activeClientId: 'cl_ola', version: 2,
          updatedAt: '2026-07-20T08:00:00.000Z',
        })
      }
      return {
        ...payload(from, to),
        latestPopulatedMonth: '2026-07',
      }
    },
    activateHistoricalClient: async () => { activationCalls += 1; return {} },
  }))
  await controller.getSnapshot().workspace.loadWindow(range('2026-07-01', '2026-07-31'))
  await controller.getSnapshot().workspace.activateHistoricalClient('hcl_ola', {
    expectedVersion: 1, specialistId: 'sp_anna',
  })
  assert.equal(controller.getSnapshot().clientMutationLocked, true)
  await assert.rejects(controller.getSnapshot().workspace.activateHistoricalClient('hcl_ola', {
    expectedVersion: 1, specialistId: 'sp_anna',
  }), { code: 'WORKSPACE_RECONCILIATION_REQUIRED' })

  await controller.getSnapshot().workspace.loadWindow(range('2026-08-01'))
  assert.equal(controller.getSnapshot().clientMutationLocked, true)
  await assert.rejects(
    controller.getSnapshot().workspace.loadWindow(range('2026-07-01', '2026-07-31')),
    conflict,
  )
  assert.equal(controller.getSnapshot().clientMutationLocked, true)

  await controller.getSnapshot().workspace.loadWindow(range('2026-07-01', '2026-07-31'))
  assert.equal(controller.getSnapshot().clientMutationLocked, false)
  assert.equal(controller.getSnapshot().loadedState.historicalClientsById.hcl_ola.status,
    'activated')
  assert.equal(activationCalls, 1)
})

test('successful appointment create, edit, and cancellation stay locked until canonical reconciliation', async () => {
  const controller = makeController(() => repositoryWith())
  await controller.getSnapshot().workspace.createAppointment({ id: 'draft' })
  assert.equal(controller.getSnapshot().appointmentMutationLocked, true)
  await assert.rejects(
    controller.getSnapshot().workspace.editAppointment('apt_ola', 1, { id: 'draft' }),
    { code: 'WORKSPACE_RECONCILIATION_REQUIRED' }
  )

  await controller.getSnapshot().workspace.loadWindow(range('2026-08-04'))
  assert.equal(controller.getSnapshot().appointmentMutationLocked, false)

  await controller.getSnapshot().workspace.editAppointment('apt_ola', 1, { id: 'draft' })
  assert.equal(controller.getSnapshot().appointmentMutationLocked, true)
  await assert.rejects(
    controller.getSnapshot().workspace.cancelAppointment('apt_ola', 1),
    { code: 'WORKSPACE_RECONCILIATION_REQUIRED' }
  )
  controller.resetAuthority('authority-two')
  assert.equal(controller.getSnapshot().appointmentMutationLocked, false)
})

test('accepted payments stay locked through failed selected-date reloads and unrelated reconciliation', async () => {
  const calls = []
  const conflict = Object.assign(new Error('conflict'), { code: 'VERSION_CONFLICT', status: 409 })
  let loads = 0
  const controller = makeController(() => repositoryWith({
    loadWindow: async ({ from, to }) => {
      loads += 1
      if (loads === 2) throw conflict
      return payload(from, to, from <= '2026-08-04' && to >= '2026-08-04'
        ? [paymentAppointment()]
        : [])
    },
    recordPayment: async (...args) => { calls.push(args); return {} },
  }))
  await controller.getSnapshot().workspace.loadWindow(range('2026-08-04'))
  await controller.getSnapshot().workspace.recordPayment('apt_ola', 1, { amountGrosze: 100 })
  assert.equal(controller.getSnapshot().paymentMutationLocked, true)
  await assert.rejects(controller.getSnapshot().workspace.loadWindow(range('2026-08-04')), conflict)
  assert.equal(controller.getSnapshot().workspace.status, 'ready')

  await controller.getSnapshot().workspace.loadWindow(range('2026-08-05'))
  assert.equal(controller.getSnapshot().paymentMutationLocked, true)
  await assert.rejects(
    controller.getSnapshot().workspace.recordPayment('apt_ola', 1, { amountGrosze: 100 }),
    { code: 'WORKSPACE_RECONCILIATION_REQUIRED' }
  )
  assert.equal(calls.length, 1)

  await controller.getSnapshot().workspace.loadWindow(range('2026-08-04'))
  assert.equal(controller.getSnapshot().paymentMutationLocked, false)
  await controller.getSnapshot().workspace.recordPayment('apt_ola', 2, { amountGrosze: 100 })
  assert.equal(calls.length, 2)
})

test('payment recording fails closed until its exact canonical appointment is loaded', async () => {
  let calls = 0
  const controller = makeController(() => repositoryWith({
    recordPayment: async () => { calls += 1; return {} },
  }))
  await assert.rejects(
    controller.getSnapshot().workspace.recordPayment('apt_ola', 1, { amountGrosze: 100 }),
    { code: 'WORKSPACE_RECONCILIATION_REQUIRED' }
  )
  assert.equal(calls, 0)
})

test('payment correction resolves its canonical entry and unlocks only after its covering load', async () => {
  const calls = []
  const entry = paymentEntry()
  const controller = makeController(() => repositoryWith({
    loadWindow: async ({ from, to }) => payload(from, to, from <= '2026-08-04' && to >= '2026-08-04'
      ? [paymentAppointment([entry])]
      : []),
    correctPayment: async (...args) => { calls.push(args); return {} },
  }))
  await controller.getSnapshot().workspace.loadWindow(range('2026-08-04'))
  await controller.getSnapshot().workspace.correctPayment('pay_ola', 1, {
    reason: 'Błędna forma płatności', replacement: null,
  })
  assert.equal(calls.length, 1)
  assert.equal(controller.getSnapshot().paymentMutationLocked, true)

  await controller.getSnapshot().workspace.loadWindow(range('2026-08-05'))
  assert.equal(controller.getSnapshot().paymentMutationLocked, true)
  await assert.rejects(
    controller.getSnapshot().workspace.correctPayment('pay_ola', 1, {
      reason: 'Błędna forma płatności', replacement: null,
    }),
    { code: 'WORKSPACE_RECONCILIATION_REQUIRED' },
  )
  await controller.getSnapshot().workspace.loadWindow(range('2026-08-04'))
  assert.equal(controller.getSnapshot().paymentMutationLocked, false)
})

test('payment correction fails closed when its target entry is not canonically loaded', async () => {
  let calls = 0
  const controller = makeController(() => repositoryWith({
    correctPayment: async () => { calls += 1; return {} },
  }))
  await assert.rejects(
    controller.getSnapshot().workspace.correctPayment('pay_missing', 1, {
      reason: 'Błędna forma płatności', replacement: null,
    }),
    { code: 'WORKSPACE_RECONCILIATION_REQUIRED' },
  )
  assert.equal(calls, 0)
})

test('payment correction fails closed when its loaded target entry is malformed', async () => {
  let calls = 0
  const controller = makeController(() => repositoryWith({
    loadWindow: async ({ from, to }) => payload(from, to, [paymentAppointment([{ id: 'pay_ola' }])]),
    correctPayment: async () => { calls += 1; return {} },
  }))
  await controller.getSnapshot().workspace.loadWindow(range('2026-08-04'))
  await assert.rejects(
    controller.getSnapshot().workspace.correctPayment('pay_ola', 1, {
      reason: 'Błędna forma płatności', replacement: null,
    }),
    { code: 'WORKSPACE_RECONCILIATION_REQUIRED' },
  )
  assert.equal(calls, 0)
})

test('business errors do not advance the epoch or make the workspace read-only', async () => {
  const conflict = Object.assign(new Error('conflict'), { code: 'VERSION_CONFLICT', status: 409 })
  const controller = makeController(() => repositoryWith({
    editClient: async () => { throw conflict },
  }))
  await assert.rejects(controller.getSnapshot().workspace.editClient('cl_ola', 1, {}), conflict)
  assert.equal(controller.getSnapshot().loadedState.writeEpoch, 0)
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
})

test('demo validation failures remain command errors instead of outages', async () => {
  const controller = makeController(() => repositoryWith({
    createClient: async () => { throw new TypeError('VALIDATION_FAILED/body') },
  }))
  await assert.rejects(controller.getSnapshot().workspace.createClient({}), TypeError)
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
  assert.equal(controller.getSnapshot().loadedState.writeEpoch, 0)
})

test('infrastructure failure preserves caller input and disables later mutations', async () => {
  const input = { name: 'Niezapisany szkic', nested: { untouched: true } }
  const before = JSON.stringify(input)
  let calls = 0
  const outage = Object.assign(new Error('offline'), { code: 'NETWORK_ERROR', status: 0 })
  const controller = makeController(() => repositoryWith({
    createClient: async () => { calls += 1; throw outage },
  }))
  await assert.rejects(controller.getSnapshot().workspace.createClient(input), outage)
  assert.equal(JSON.stringify(input), before)
  assert.equal(controller.getSnapshot().workspace.status, 'read-only-error')
  await assert.rejects(controller.getSnapshot().workspace.createClient(input), { code: 'WORKSPACE_READ_ONLY' })
  assert.equal(calls, 1)
  assert.equal(controller.getSnapshot().loadedState.writeEpoch, 0)
  controller.resetAuthority('authority-recovered')
  assert.equal(controller.getSnapshot().workspace.status, 'ready')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [])
})

test('invalid load response fails closed without erasing prior canonical coverage', async () => {
  let calls = 0
  const controller = makeController(() => repositoryWith({
    loadWindow: async ({ from, to }) => (++calls === 1 ? payload(from, to) : { invalid: true }),
  }))
  await controller.getSnapshot().workspace.loadWindow(range('2026-08-01'))
  await assert.rejects(controller.getSnapshot().workspace.loadWindow(range('2026-08-02')), TypeError)
  assert.equal(controller.getSnapshot().workspace.status, 'read-only-error')
  assert.deepEqual(controller.getSnapshot().workspace.loadedRanges, [range('2026-08-01')])
})
