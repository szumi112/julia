import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiClient } from '../../src/api.js'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const session = { data: {
  actor: { id: 'stf_owner_1', displayName: 'Fikcyjna Osoba', professionalTitle: null,
    role: 'owner', specialistId: null, version: 3 },
  authorityRevision: 1, capabilities: [...ROLE_DEFAULT_CAPABILITIES.owner],
  csrfToken: `v1.1999999999.${'A'.repeat(22)}.${'B'.repeat(43)}`,
  csrfExpiresAt: '2033-05-18T03:33:19.000Z', environment: 'staging', dataMode: 'fictional',
} }
const input = { kind: 'expense', recordType: 'expense', accountingMonth: '2026-09',
  occurredOn: '2026-09-05', amountGrosze: 20000, paidAmountGrosze: 0,
  paymentMethod: 'unknown', settlementStatus: 'unknown', invoiceStatus: 'not_required',
  counterparty: 'Fikcyjny dostawca', sourceLabel: 'Materiały', invoiceNote: '',
  specialistId: null, lessonCount: null, source: null }
const response = (payload, status = 200) => new Response(JSON.stringify(payload),
  { status, headers: { 'content-type': 'application/json' } })

test('finance creation and correction preserve exact fields, cancellation, key and optimistic response version', async () => {
  const requests = []
  const api = createApiClient({ fetchImpl: async (url, options) => {
    if (url.endsWith('/session')) return response(session)
    requests.push({ url, options })
    return response({ data: { entryId: 'fin_test', version: url.endsWith('/adjustments') ? 2 : 1 } },
      url.endsWith('/adjustments') ? 200 : 201)
  } })
  assert.equal(typeof api.createFinanceEntry, 'function')
  await api.getSession()
  const controller = new AbortController()
  const options = { idempotencyKey: 'finance-command-browser', signal: controller.signal }
  assert.deepEqual(await api.createFinanceEntry(input, options), { entryId: 'fin_test', version: 1 })
  const adjustment = { expectedVersion: 1, reason: 'Wpłata za materiały', accountingMonth: '2026-09',
    paidAmountGrosze: 20000, paymentMethod: 'transfer', settlementStatus: 'paid', invoiceStatus: 'issued' }
  assert.deepEqual(await api.adjustFinanceEntry('fin_test', adjustment, options), { entryId: 'fin_test', version: 2 })
  assert.equal(requests[0].url, '/api/v1/finance/entries')
  assert.equal(requests[1].url, '/api/v1/finance/entries/fin_test/adjustments')
  assert.deepEqual(JSON.parse(requests[0].options.body), input)
  assert.deepEqual(JSON.parse(requests[1].options.body), adjustment)
  assert.equal(requests[1].options.signal, controller.signal)
  assert.equal(requests[1].options.headers['Idempotency-Key'], options.idempotencyKey)
})

test('finance detail validates the requested entry and refuses invalid input before network I/O', async () => {
  const { invoiceNote, specialistId, lessonCount, source, ...fields } = input
  const detail = { entry: { id: 'fin_test', version: 1, ...fields, appointmentId: null },
    adjustments: [], historyTruncated: false }
  const calls = []
  const api = createApiClient({ fetchImpl: async (url) => { calls.push(url); return response({ data: detail }) } })
  assert.equal(typeof api.loadFinanceEntry, 'function')
  assert.deepEqual(await api.loadFinanceEntry('fin_test'), detail)
  assert.equal(calls[0], '/api/v1/finance/entries/fin_test')
  await assert.rejects(api.loadFinanceEntry('fin_other'), { code: 'INVALID_RESPONSE' })
  const count = calls.length
  await assert.rejects(api.loadFinanceEntry('../test'), { code: 'CLIENT_INPUT_INVALID' })
  await assert.rejects(api.createFinanceEntry({ ...input, recordType: 'tus' }), { code: 'CLIENT_INPUT_INVALID' })
  assert.equal(calls.length, count)
})

test('activity charge creation sends the canonical monthly command and validates its linked acknowledgment', async () => {
  let sent
  let result = { chargeId: 'ach_test', entryId: 'fin_test', version: 1 }
  const api = createApiClient({ fetchImpl: async (url, options) => {
    if (url.endsWith('/session')) return response(session)
    sent = { url, options }
    return response({ data: result }, 201)
  } })
  assert.equal(typeof api.createActivityCharge, 'function')
  await api.getSession()
  const body = { participantId: 'acp_test', groupId: 'agr_test', membershipId: 'amb_test',
    responsibleSpecialistId: 'sp_test', accountingMonth: '2026-09', amountGrosze: 34000,
    lessonCount: null, paidAmountGrosze: 0, paymentMethod: 'unknown', settlementStatus: 'unpaid',
    invoiceStatus: 'not_required' }
  const controller = new AbortController()
  const options = { signal: controller.signal, idempotencyKey: 'activity-charge-test' }
  assert.deepEqual(await api.createActivityCharge(body, options), result)
  assert.equal(sent.url, '/api/v1/activities/charges')
  assert.deepEqual(JSON.parse(sent.options.body), body)
  assert.equal(sent.options.signal, controller.signal)
  assert.equal(sent.options.headers['Idempotency-Key'], options.idempotencyKey)
  result = { ...result, version: 2 }
  await assert.rejects(api.createActivityCharge(body, options), { code: 'INVALID_RESPONSE' })
})
