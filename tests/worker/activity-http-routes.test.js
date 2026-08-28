import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../worker/app.js'
import { AppError } from '../../worker/http/errors.js'

const NOW_MS = Date.parse('2027-03-04T08:00:00.000Z')
const ORIGIN = 'https://bearwithme-panel.app'
const actor = Object.freeze({
  id: 'stf_activity_http_owner', role: 'owner', specialistId: null, version: 1,
})
const principal = Object.freeze({
  kind: 'human', subject: 'access-activity-http-owner',
  normalizedEmail: 'activity-http-owner@example.test',
  issuedAt: Math.floor(NOW_MS / 1_000) - 30,
  expiresAt: Math.floor(NOW_MS / 1_000) + 270,
})

const statement = () => {
  const value = {
    bind: vi.fn(() => value),
    all: vi.fn(async () => ({ results: [] })),
    first: vi.fn(async () => null),
    raw: vi.fn(async () => []),
    run: vi.fn(async () => ({ success: true })),
  }
  return value
}

const depsFor = (overrides = {}) => ({
  config: { appEnv: 'staging', appOrigin: ORIGIN, dataMode: 'fictional' },
  db: { prepare: vi.fn(statement), batch: vi.fn(async () => []) },
  cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
  now: () => NOW_MS,
  resolveAccessPrincipal: vi.fn(async () => principal),
  resolveActor: vi.fn(async () => actor),
  verifyCsrfToken: vi.fn(async () => true),
  safeLog: vi.fn(),
  idFactory: () => 'activity_http_route',
  ...overrides,
})

const mutation = (body, key) => ({
  method: 'POST',
  headers: {
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    'X-CSRF-Token': 'valid',
    'X-Correlation-Id': '00000000-0000-4000-8000-000000000001',
    'Idempotency-Key': key,
  },
  body: JSON.stringify(body),
})

const success = (key, status = 200) => vi.fn(async (input) => ({
  status,
  body: { data: { [key]: { id: `fixture_${key}` } } },
}))

describe('activity HTTP routes', () => {
  it('wires the bounded workspace, all native commands, and owner projection routes', async () => {
    const getActivityWorkspace = vi.fn(async (input) => {
      await input.db.prepare('SELECT 1').first()
      return { data: { from: '2027-01', to: '2027-03' } }
    })
    const postActivityGroup = success('group', 201)
    const postActivityGroupEdit = success('group')
    const postActivityParticipant = success('participant', 201)
    const postActivityParticipantEdit = success('participant')
    const postActivityMembership = success('membership', 201)
    const postActivityMembershipEdit = success('membership')
    const postActivityClass = success('class', 201)
    const postActivityClassEdit = success('class')
    const postActivityAttendance = success('attendance', 201)
    const getActivityProjectionStatus = vi.fn(async () => ({ data: { job: null } }))
    const postActivityProjectionContinue = vi.fn(async (input) => ({
      status: 201,
      body: { data: { job: { importId: input.importId, version: 1 } } },
    }))
    const app = createApp(depsFor({
      getActivityWorkspace,
      postActivityGroup,
      postActivityGroupEdit,
      postActivityParticipant,
      postActivityParticipantEdit,
      postActivityMembership,
      postActivityMembershipEdit,
      postActivityClass,
      postActivityClassEdit,
      postActivityAttendance,
      getActivityProjectionStatus,
      postActivityProjectionContinue,
    }))

    expect((await app.request(
      '/api/v1/activities/workspace?from=2027-01&to=2027-03',
    )).status).toBe(200)
    expect(getActivityWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      actor, url: expect.stringContaining('?from=2027-01&to=2027-03'),
    }))

    const requests = [
      ['/api/v1/activities/groups', {
        programId: 'apg_tus', label: 'Sowy', details: null,
        leaderSpecialistIds: ['sp_julia'],
      }, 201],
      ['/api/v1/activities/groups/agr_sowy/edits', {
        expectedVersion: 1, label: 'Sowy', details: null, status: 'active',
        leaderSpecialistIds: ['sp_julia'],
      }, 200],
      ['/api/v1/activities/participants', {
        programId: 'apg_tus', name: 'Ola', clientId: null, historicalClientId: null,
      }, 201],
      ['/api/v1/activities/participants/acp_ola/edits', {
        expectedVersion: 1, name: 'Ola', clientId: null,
        historicalClientId: null, status: 'active',
      }, 200],
      ['/api/v1/activities/memberships', {
        participantId: 'acp_ola', groupId: 'agr_sowy', startsOn: '2027-01-01',
        endsOn: null,
      }, 201],
      ['/api/v1/activities/memberships/amb_ola_sowy/edits', {
        expectedVersion: 1, startsOn: '2027-01-01', endsOn: null, status: 'active',
      }, 200],
      ['/api/v1/activities/classes', {
        groupId: 'agr_sowy', date: '2027-03-05', time: '16:00',
        durationMinutes: 60, topic: null, status: 'scheduled',
      }, 201],
      ['/api/v1/activities/classes/acl_sowy_one/edits', {
        expectedVersion: 1, date: '2027-03-05', time: '16:00',
        durationMinutes: 60, topic: null, status: 'completed',
      }, 200],
      ['/api/v1/activities/classes/acl_sowy_one/attendance', {
        participantId: 'acp_ola', status: 'present', expectedVersion: 0,
      }, 201],
    ]
    for (let index = 0; index < requests.length; index += 1) {
      const [path, body, status] = requests[index]
      expect((await app.request(path, mutation(
        body, `activity-http-command-${String(index).padStart(4, '0')}`,
      ))).status).toBe(status)
    }
    expect((await app.request(
      '/api/v1/workbooks/imports/wbi_activity_http/activity-projection',
    )).status).toBe(200)
    expect((await app.request(
      '/api/v1/workbooks/imports/wbi_activity_http/activity-projection/continue',
      mutation({ expectedVersion: 0 }, 'activity-http-projection-0001'),
    )).status).toBe(201)

    expect(postActivityGroup).toHaveBeenCalledWith(expect.objectContaining({
      actor, body: requests[0][1], idempotencyKey: 'activity-http-command-0000',
    }))
    expect(postActivityClass).toHaveBeenCalledWith(expect.objectContaining({
      actor, body: requests[6][1],
    }))
    expect(postActivityProjectionContinue).toHaveBeenCalledWith(expect.objectContaining({
      actor, importId: 'wbi_activity_http', expectedVersion: 0,
    }))
  })

  it('preserves safe activity limit, conflict, and version details over HTTP', async () => {
    const version = new Error('VERSION_CONFLICT')
    version.details = { currentVersion: 7 }
    const cases = [
      [
        depsFor({ getActivityWorkspace: vi.fn(async () => {
          throw new AppError('ACTIVITY_RESULT_LIMIT', { field: 'classes', limit: 1_000 })
        }) }),
        '/api/v1/activities/workspace?from=2027-01&to=2027-03', undefined,
        409, { code: 'ACTIVITY_RESULT_LIMIT', details: { field: 'classes', limit: 1_000 } },
      ],
      [
        depsFor({ postActivityGroup: vi.fn(async () => { throw new Error('ACTIVITY_CONFLICT') }) }),
        '/api/v1/activities/groups', mutation({
          programId: 'apg_tus', label: 'Sowy', details: null,
          leaderSpecialistIds: [],
        }, 'activity-http-conflict-0001'),
        409, { code: 'ACTIVITY_CONFLICT' },
      ],
      [
        depsFor({ postActivityProjectionContinue: vi.fn(async () => { throw version }) }),
        '/api/v1/workbooks/imports/wbi_activity_http/activity-projection/continue',
        mutation({ expectedVersion: 6 }, 'activity-http-version-0001'),
        409, { code: 'VERSION_CONFLICT', details: { currentVersion: 7 } },
      ],
    ]
    for (const [deps, path, init, status, error] of cases) {
      const response = await createApp(deps).request(path, init)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error })
    }
  })
})
