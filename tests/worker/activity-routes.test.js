import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../worker/http/errors.js'
import {
  getActivityWorkspace,
  getActivityProjectionStatus,
  postActivityAttendance,
  postActivityClass,
  postActivityClassEdit,
  postActivityGroup,
  postActivityGroupEdit,
  postActivityMembership,
  postActivityMembershipEdit,
  postActivityParticipant,
  postActivityParticipantEdit,
  postActivityProjectionContinue,
} from '../../worker/routes/activities.js'

const actor = Object.freeze({
  id: 'stf_activity_route_owner', role: 'owner', specialistId: null, version: 1,
})

const common = (overrides = {}) => ({
  db: {}, recoveryDb: {}, actor, keyring: {},
  config: { appEnv: 'staging', dataMode: 'fictional' },
  centreId: 'centre_1', importId: 'wbi_activity_route_one',
  idempotencyKey: 'activity-route-continue-0001', idFactory: () => 'route',
  correlationId: '00000000-0000-4000-8000-000000000001',
  nowMs: Date.parse('2027-03-04T08:00:00.000Z'),
  ...overrides,
})

const native = (overrides = {}) => ({
  db: {}, recoveryDb: {}, actor, keyring: {},
  nowMs: Date.parse('2027-03-04T08:00:00.000Z'),
  correlationId: '00000000-0000-4000-8000-000000000001',
  idFactory: () => 'route', idempotencyKey: 'activity-route-command-0001',
  ...overrides,
})

const readInput = (overrides = {}) => ({
  db: {}, actor, keyring: {}, nowMs: Date.parse('2027-03-04T08:00:00.000Z'),
  ...overrides,
})

describe('activity route adapters', () => {
  it('allow-lists activity validation and bounded-result error details', () => {
    expect(new AppError('ACTIVITY_RESULT_LIMIT', {
      field: 'groupLeaders', limit: 2_000,
    })).toMatchObject({
      code: 'ACTIVITY_RESULT_LIMIT', status: 409,
      details: { field: 'groupLeaders', limit: 2_000 },
    })
    expect(new AppError('VALIDATION_FAILED', { field: 'participantId' }))
      .toMatchObject({ details: { field: 'participantId' } })
    expect(new AppError('ACTIVITY_CONFLICT')).toMatchObject({
      code: 'ACTIVITY_CONFLICT', status: 409, details: undefined,
    })
    expect(new AppError('ACTIVITY_RESULT_LIMIT', {
      field: 'identityEnvelope', limit: 1,
    }).details).toBeUndefined()
  })

  it('forwards the exact owner-only projection status and continuation contracts', async () => {
    const statusService = vi.fn(async (input) => ({ data: { job: input.importId } }))
    const continueService = vi.fn(async (input) => ({
      status: 200, body: { data: { job: input.expectedVersion } },
    }))
    await expect(getActivityProjectionStatus(common({
      service: statusService,
    }))).resolves.toEqual({ data: { job: 'wbi_activity_route_one' } })
    await expect(postActivityProjectionContinue(common({
      service: continueService, body: { expectedVersion: 17 },
    }))).resolves.toEqual({ status: 200, body: { data: { job: 17 } } })
    expect(statusService).toHaveBeenCalledWith({
      db: {}, actor, importId: 'wbi_activity_route_one',
    })
    expect(continueService).toHaveBeenCalledWith({
      db: {}, recoveryDb: {}, actor, keyring: {},
      config: { appEnv: 'staging', dataMode: 'fictional' },
      centreId: 'centre_1', importId: 'wbi_activity_route_one',
      expectedVersion: 17, idempotencyKey: 'activity-route-continue-0001',
      idFactory: expect.any(Function), nowMs: Date.parse('2027-03-04T08:00:00.000Z'),
    })
  })

  it('forwards the bounded workspace window and every native command contract', async () => {
    const read = vi.fn(async ({ window }) => ({ data: { ...window } }))
    await expect(getActivityWorkspace(readInput({
      url: 'https://panel.example.test/api/v1/activities/workspace?from=2027-01&to=2027-03',
      service: read,
    }))).resolves.toEqual({ data: { from: '2027-01', to: '2027-03' } })
    expect(read).toHaveBeenCalledWith({
      db: {}, actor, keyring: {}, nowMs: Date.parse('2027-03-04T08:00:00.000Z'),
      window: { from: '2027-01', to: '2027-03' },
    })

    const cases = [
      [postActivityGroup, null, null, {
        programId: 'apg_tus', label: 'Sowy', details: null,
        leaderSpecialistIds: ['sp_julia'],
      }],
      [postActivityGroupEdit, 'groupId', 'agr_sowy', {
        expectedVersion: 1, label: 'Sowy', details: null, status: 'active',
        leaderSpecialistIds: ['sp_julia'],
      }],
      [postActivityParticipant, null, null, {
        programId: 'apg_tus', name: 'Ola', clientId: null, historicalClientId: null,
      }],
      [postActivityParticipantEdit, 'participantId', 'acp_ola', {
        expectedVersion: 1, name: 'Ola', clientId: null, historicalClientId: null,
        status: 'active',
      }],
      [postActivityMembership, null, null, {
        participantId: 'acp_ola', groupId: 'agr_sowy', startsOn: '2027-01-01',
        endsOn: null,
      }],
      [postActivityMembershipEdit, 'membershipId', 'amb_ola_sowy', {
        expectedVersion: 1, startsOn: '2027-01-01', endsOn: null, status: 'active',
      }],
      [postActivityClass, null, null, {
        groupId: 'agr_sowy', date: '2027-03-05', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      }],
      [postActivityClassEdit, 'classId', 'acl_sowy_one', {
        expectedVersion: 1, date: '2027-03-05', time: '16:00',
        durationMinutes: 60, topic: null, status: 'completed',
      }],
      [postActivityAttendance, 'classId', 'acl_sowy_one', {
        participantId: 'acp_ola', status: 'present', expectedVersion: 0,
      }],
    ]
    for (const [route, targetKey, targetId, body] of cases) {
      const service = vi.fn(async (input) => ({ status: 200, body: input.body }))
      const input = native({ service, body, ...(targetKey ? { [targetKey]: targetId } : {}) })
      await expect(route(input)).resolves.toEqual({ status: 200, body })
      expect(service).toHaveBeenCalledWith({
        db: {}, recoveryDb: {}, actor, keyring: {},
        nowMs: Date.parse('2027-03-04T08:00:00.000Z'),
        correlationId: '00000000-0000-4000-8000-000000000001',
        idFactory: expect.any(Function), body, idempotencyKey: 'activity-route-command-0001',
        ...(targetKey ? { [targetKey]: targetId } : {}),
      })
    }
  })

  it('rejects malformed native IDs, queries, and bodies before service dispatch', async () => {
    const service = vi.fn()
    expect(() => getActivityWorkspace(readInput({
      url: 'https://panel.example.test/api/v1/activities/workspace?to=2027-03&from=2027-01',
      service,
    }))).toThrowError(new AppError('VALIDATION_FAILED', { field: 'body' }))
    expect(() => postActivityGroupEdit(native({
      groupId: 'agr_bad/id', body: {}, service,
    }))).toThrowError(new AppError('VALIDATION_FAILED', { field: 'groupId' }))
    expect(() => postActivityClass(native({
      body: {
        groupId: 'agr_sowy', date: '2027-02-30', time: null,
        durationMinutes: null, topic: null, status: 'scheduled',
      },
      service,
    }))).toThrowError(new AppError('VALIDATION_FAILED', { field: 'body' }))
    expect(service).not.toHaveBeenCalled()
  })

  it('maps exact core validation fields without exposing arbitrary TypeErrors', async () => {
    const body = {
      participantId: 'acp_ola', status: 'present', expectedVersion: 0,
    }
    await expect(postActivityAttendance(native({
      classId: 'acl_sowy_one', body,
      service: async () => { throw new TypeError('VALIDATION_FAILED/participantId') },
    }))).rejects.toThrowError(new AppError('VALIDATION_FAILED', { field: 'participantId' }))
    await expect(postActivityAttendance(native({
      classId: 'acl_sowy_one', body,
      service: async () => { throw new TypeError('private secret') },
    }))).rejects.toThrowError(new TypeError('private secret'))
  })

  it('rejects malformed IDs and non-exact continuation bodies before core', async () => {
    const service = vi.fn()
    for (const [overrides, field] of [
      [{ importId: 'wbi_bad/id', body: { expectedVersion: 1 } }, 'importId'],
      [{ body: { expectedVersion: -1 } }, 'expectedVersion'],
      [{ body: { expectedVersion: 1, extra: true } }, 'body'],
      [{ body: Object.create({ expectedVersion: 1 }) }, 'body'],
    ]) {
      expect(() => postActivityProjectionContinue(common({ service, ...overrides })))
        .toThrowError(new AppError('VALIDATION_FAILED', { field }))
    }
    expect(service).not.toHaveBeenCalled()
  })

  it('conceals projection existence from coordinator and specialist before validation', () => {
    const service = vi.fn()
    for (const role of ['coordinator', 'specialist']) {
      expect(() => postActivityProjectionContinue(common({
        actor: { ...actor, role, specialistId: role === 'specialist' ? 'sp_route' : null },
        importId: 'invalid', body: { expectedVersion: 'invalid' }, service,
      }))).toThrowError(new AppError('NOT_FOUND'))
      expect(() => getActivityProjectionStatus(common({
        actor: { ...actor, role, specialistId: role === 'specialist' ? 'sp_route' : null },
        importId: 'invalid', service,
      }))).toThrowError(new AppError('NOT_FOUND'))
    }
    expect(service).not.toHaveBeenCalled()
  })
})
