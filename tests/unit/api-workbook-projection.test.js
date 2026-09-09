import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiClient } from '../../src/api.js'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const NOW = '2026-09-05T10:00:00.000Z'
const session = { data: {
  actor: { id: 'stf_owner_1', displayName: 'Fikcyjna Osoba', professionalTitle: null,
    role: 'owner', specialistId: null, version: 3 },
  authorityRevision: 1, capabilities: [...ROLE_DEFAULT_CAPABILITIES.owner],
  csrfToken: `v1.1999999999.${'A'.repeat(22)}.${'B'.repeat(43)}`,
  csrfExpiresAt: '2033-05-18T03:33:19.000Z', environment: 'staging', dataMode: 'fictional',
} }
const job = (version) => ({ id: 'hpj_test', importId: 'wbi_test', status: 'running',
  afterSourceRecordId: 'wbs_test', totalRecords: 2, processedRecords: 1, projectedRecords: 1,
  conflictCount: 1, version, updatedAt: NOW, completedAt: null })
const response = (payload, status = 200) => new Response(JSON.stringify(payload),
  { status, headers: { 'content-type': 'application/json' } })

test('historical status reads preserve cancellation and reject a different import', async () => {
  const controller = new AbortController()
  let requested
  const api = createApiClient({ fetchImpl: async (url, options) => {
    requested = { url, options }
    return new Response(JSON.stringify({ data: { projection: null, conflicts: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  assert.equal(typeof api.getHistoricalProjection, 'function')
  assert.deepEqual(await api.getHistoricalProjection('wbi_test', { signal: controller.signal }),
    { projection: null, conflicts: [] })
  assert.equal(requested.url, '/api/v1/workbooks/imports/wbi_test/historical-projection')
  assert.equal(requested.options.signal, controller.signal)
  await assert.rejects(api.getHistoricalProjection('../other'), { code: 'CLIENT_INPUT_INVALID' })
})

test('historical decisions replay the exact body and key after transport uncertainty, accepting server replay status', async () => {
  const requests = []
  let fail = true
  const api = createApiClient({ fetchImpl: async (url, options) => {
    if (url.endsWith('/session')) return response(session)
    requests.push({ url, body: options.body, key: options.headers['Idempotency-Key'], signal: options.signal })
    if (fail) { fail = false; throw new Error('disconnected') }
    return response({ data: { projection: job(3) } }, 200)
  } })
  await api.getSession()
  const input = { expectedJobVersion: 2, conflictId: 'hcf_test', classification: 'person',
    existingSubjectId: null, serviceId: 'zajecia', reviewContextDigest: 'a'.repeat(64),
    directoryCount: 0, directoryDigest: 'b'.repeat(64) }
  const controller = new AbortController()
  const options = { idempotencyKey: 'historical-resolution-test', signal: controller.signal }
  await assert.rejects(api.resolveHistoricalProjection('wbi_test', input, options))
  assert.deepEqual(await api.resolveHistoricalProjection('wbi_test', input, options), job(3))
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0], requests[1])
  assert.equal(requests[0].url, '/api/v1/workbooks/imports/wbi_test/historical-projection/resolutions')
  assert.deepEqual(JSON.parse(requests[0].body), input)
  assert.equal(requests[0].signal, controller.signal)
})

test('historical status rejects widened and cross-import DTOs', async () => {
  for (const projection of [{ ...job(2), importId: 'wbi_other' }, { ...job(2), patientSecret: 'unexpected' }]) {
    const api = createApiClient({ fetchImpl: async () => response({ data: { projection, conflicts: [] } }) })
    await assert.rejects(api.getHistoricalProjection('wbi_test'), { code: 'INVALID_RESPONSE' })
  }
})
