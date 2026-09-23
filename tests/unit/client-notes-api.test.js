import assert from 'node:assert/strict'
import test from 'node:test'
import { createApiClient } from '../../src/api.js'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const note = (overrides = {}) => ({
  id: 'cno_example', clientId: 'cl_child', authorStaffId: 'stf_anna',
  authorSpecialistId: 'sp_anna', createdAt: '2026-09-22T08:00:00.000Z',
  text: 'Fikcyjna notatka.\nDrugi akapit.', ...overrides,
})
const response = (data, status = 200) => new Response(JSON.stringify({ data }), {
  status, headers: { 'content-type': 'application/json' },
})
const session = () => ({
  actor: {
    id: 'stf_anna', displayName: 'Anna Fikcyjna', email: 'anna@example.test',
    professionalTitle: 'Specjalistka', role: 'specialist', specialistId: 'sp_anna', version: 1,
  },
  authorityRevision: 1, capabilities: [...ROLE_DEFAULT_CAPABILITIES.specialist],
  csrfToken: 'v1.1999999999.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  csrfExpiresAt: '2033-05-18T03:33:19.000Z', environment: 'staging', dataMode: 'fictional',
})

test('notes API reads a client-scoped page with cancellation and rejects another client in the response', async () => {
  const calls = []
  let clientId = 'cl_child'
  const api = createApiClient({ fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return response({ items: [note({ clientId })], nextCursor: null })
  } })
  const controller = new AbortController()
  assert.deepEqual(await api.clientNotes('cl_child', { limit: 10 }, { signal: controller.signal }), {
    items: [note()], nextCursor: null,
  })
  assert.equal(calls[0].url, '/api/v1/clients/cl_child/notes?limit=10')
  assert.equal(calls[0].init.signal, controller.signal)
  assert.equal(calls[0].init.credentials, 'same-origin')
  clientId = 'cl_other'
  await assert.rejects(api.clientNotes('cl_child'), { code: 'INVALID_RESPONSE' })
})

test('notes API submits text with a stable idempotency key and checks the returned text and client', async () => {
  const writes = []
  let returnedNote = note()
  const api = createApiClient({ fetchImpl: async (url, init) => {
    if (url === '/api/v1/session') return response(session())
    writes.push({ url, init })
    return response({ note: returnedNote }, 201)
  } })
  await api.getSession()
  const options = { idempotencyKey: 'client-note-key-0001' }
  assert.deepEqual(await api.createClientNote('cl_child', { text: note().text }, options), { note: note() })
  assert.equal(writes[0].url, '/api/v1/clients/cl_child/notes')
  assert.deepEqual(JSON.parse(writes[0].init.body), { text: note().text })
  assert.equal(writes[0].init.headers['Idempotency-Key'], options.idempotencyKey)
  for (const changed of [{ clientId: 'cl_other' }, { text: 'Inna notatka' }]) {
    returnedNote = note(changed)
    await assert.rejects(api.createClientNote('cl_child', { text: note().text }, options), { code: 'INVALID_RESPONSE' })
  }
})

test('notes API rejects invalid input without fetching', async () => {
  let calls = 0
  const api = createApiClient({ fetchImpl: async () => { calls += 1; throw new Error('unexpected request') } })
  for (const options of [{ limit: 51 }, { search: 'private' }]) {
    await assert.rejects(api.clientNotes('cl_child', options), { code: 'CLIENT_INPUT_INVALID' })
  }
  await assert.rejects(api.clientNotes('stf_anna'), { code: 'CLIENT_INPUT_INVALID' })
  for (const body of [{ text: '' }, { text: 'Fikcyjna', extra: true }]) {
    await assert.rejects(api.createClientNote('cl_child', body), { code: 'CLIENT_INPUT_INVALID' })
  }
  assert.equal(calls, 0)
})
