import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiClient } from '../../src/api.js'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const csrfToken = 'v1.1999999999.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const session = {
  data: {
    actor: {
      id: 'stf_owner_1', displayName: 'Właścicielka', email: 'owner@example.test', professionalTitle: null,
      role: 'owner', specialistId: null, version: 1,
    },
    authorityRevision: 1,
    capabilities: [...ROLE_DEFAULT_CAPABILITIES.owner],
    csrfToken,
    csrfExpiresAt: '2033-05-18T03:33:19.000Z',
    environment: 'staging', dataMode: 'fictional',
  },
}

const absence = (overrides = {}) => ({
  id: 'abs_anna', specialistId: 'sp_anna', dateFrom: '2026-09-14', dateTo: '2026-09-16',
  allDay: true, version: 1, createdAt: '2026-09-13T10:00:00.000Z', cancelledAt: null,
  ...overrides,
})

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

test('specialist absence API sends exact create and cancellation bodies', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    if (url === '/api/v1/session') return json(session)
    if (url === '/api/v1/specialist-absences') {
      return json({ data: { absence: absence() } }, 201)
    }
    return json({ data: { absence: absence({ version: 2, cancelledAt: '2026-09-13T10:00:00.000Z' }) } })
  }
  const client = createApiClient({ fetchImpl, idempotencyKeyFactory: () => 'absence-test-key' })
  await client.getSession()
  const created = await client.createSpecialistAbsence({
    specialistId: 'sp_anna', dateFrom: '2026-09-14', dateTo: '2026-09-16', allDay: true,
  })
  const cancelled = await client.cancelSpecialistAbsence('abs_anna', 1)
  assert.equal(created.id, 'abs_anna')
  assert.equal(cancelled.version, 2)
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    specialistId: 'sp_anna', dateFrom: '2026-09-14', dateTo: '2026-09-16', allDay: true,
  })
  assert.deepEqual(JSON.parse(calls[2].options.body), { expectedVersion: 1 })
  assert.equal(calls[2].url, '/api/v1/specialist-absences/abs_anna/cancellation')
})
