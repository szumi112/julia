import assert from 'node:assert/strict'
import test from 'node:test'
import { createApiClient } from '../../src/api.js'

const data = () => ({
  items: [{
    id: 'aud_session', occurredAt: '2026-09-22T08:00:00.000Z', kind: 'appointment',
    actorName: 'Anna Fikcyjna', clientName: 'Fikcyjny Klient', summary: 'Zmieniono sesję',
    details: [{ field: 'Status', before: 'Zaplanowana', after: 'Odbyta' }],
  }],
  nextCursor: null,
  filters: { actors: [{ id: 'stf_anna', label: 'Anna Fikcyjna' }], clients: [{ id: 'cl_child', label: 'Fikcyjny Klient' }] },
})

test('history API encodes server filters and forwards cancellation', async () => {
  const calls = []
  const client = createApiClient({ fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ data: data() }), { headers: { 'content-type': 'application/json' } })
  } })
  const controller = new AbortController()
  assert.deepEqual(await client.listActivityHistory({
    actor: 'stf_anna', client: 'cl_child', kind: 'appointment', from: '2026-09-01', to: '2026-09-22', limit: 20,
  }, { signal: controller.signal }), data())
  const url = new URL(calls[0].url, 'https://app.example.test')
  assert.equal(url.pathname, '/api/v1/activity')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    actor: 'stf_anna', client: 'cl_child', kind: 'appointment', from: '2026-09-01', to: '2026-09-22', limit: '20',
  })
  assert.equal(calls[0].init.signal, controller.signal)
  assert.equal(calls[0].init.credentials, 'same-origin')
})

test('history API rejects invalid filters before requesting data', async () => {
  let calls = 0
  const client = createApiClient({ fetchImpl: async () => { calls += 1; throw new Error('unexpected request') } })
  for (const input of [{ limit: 101 }, { from: '2026-09-22', to: '2026-09-01' }, { actor: 'cl_child' }, { search: 'private text' }]) {
    await assert.rejects(client.listActivityHistory(input), { code: 'CLIENT_INPUT_INVALID' })
  }
  assert.equal(calls, 0)
})

test('history API rejects technical metadata in the presentation payload', async () => {
  const payload = data()
  payload.items[0].metadata = { guardianEmail: 'private@example.test' }
  const client = createApiClient({ fetchImpl: async () => new Response(JSON.stringify({ data: payload }), {
    headers: { 'content-type': 'application/json' },
  }) })
  await assert.rejects(client.listActivityHistory(), { code: 'INVALID_RESPONSE' })
})
