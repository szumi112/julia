import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTIVITY_KINDS,
  activityForAction,
  appointmentActivityChanges,
  captureActivityChanges,
  captureActivityHistoryPayload,
  captureActivityHistoryQuery,
  formatActivityChanges,
} from '../../src/activity-history.js'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'
import { authorize } from '../../worker/identity/policy.js'

test('activity.read is centre-scoped to owners and coordinators', () => {
  const centre = { kind: 'centre', centreId: 'centre_1' }
  for (const role of ['owner', 'coordinator', 'specialist']) {
    const actor = {
      id: `stf_${role}`, role, specialistId: role === 'specialist' ? 'sp_specialist' : null,
      version: 1, authorityRevision: 1, capabilities: ROLE_DEFAULT_CAPABILITIES[role],
    }
    assert.equal(authorize(actor, 'activity.read', centre, { nowMs: 1000 }), role !== 'specialist')
    assert.equal(authorize(actor, 'activity.read', { kind: 'centre', centreId: 'centre_2' }, { nowMs: 1000 }), false)
  }
})

test('the public history has a fixed business-event vocabulary', () => {
  assert.deepEqual(ACTIVITY_KINDS, [
    { value: 'finance', label: 'Finanse' },
    { value: 'client', label: 'Klienci' },
    { value: 'appointment', label: 'Sesje' },
    { value: 'payment', label: 'Wpłaty' },
    { value: 'group', label: 'Zajęcia grupowe' },
    { value: 'team', label: 'Zespół' },
  ])
  assert.deepEqual(activityForAction('client.updated'), {
    kind: 'client', summary: 'Zmieniono dane klienta',
  })
  assert.equal(activityForAction('finance.import.chunk.accepted'), null)
  assert.equal(activityForAction('activity.projection.advanced'), null)
  assert.equal(activityForAction('authorization.denied'), null)
  assert.equal(activityForAction('backup.pruned'), null)
})

test('appointment differences capture only time, specialist, status and amount', () => {
  const before = {
    startsAt: '2026-09-22T08:00:00.000Z', specialistId: 'sp_ola',
    status: 'scheduled', expectedAmountGrosze: 18000,
    location: 'PRIVATE PLACE', notes: 'PRIVATE NOTE',
  }
  const after = {
    ...before, startsAt: '2026-09-22T09:00:00.000Z',
    specialistId: 'sp_anna', status: 'completed',
    expectedAmountGrosze: 20000, location: 'OTHER PRIVATE PLACE',
    notes: 'OTHER PRIVATE NOTE',
  }
  const changes = appointmentActivityChanges(before, after)
  assert.deepEqual(changes, [
    { field: 'time', before: '2026-09-22T08:00:00.000Z', after: '2026-09-22T09:00:00.000Z' },
    { field: 'specialist', before: 'sp_ola', after: 'sp_anna' },
    { field: 'status', before: 'scheduled', after: 'completed' },
    { field: 'amount', before: 18000, after: 20000 },
  ])
  assert.doesNotMatch(JSON.stringify(changes), /PRIVATE/)
  assert.deepEqual(appointmentActivityChanges(before, { ...before, notes: 'CHANGED' }), [])
})

test('history detail decoder rejects free text, extra fields and invalid values', () => {
  assert.deepEqual(captureActivityChanges([
    { field: 'amount', before: 18000, after: 20000 },
  ]), [{ field: 'amount', before: 18000, after: 20000 }])
  for (const value of [
    [{ field: 'note', before: 'private', after: 'more private' }],
    [{ field: 'amount', before: '18000', after: 20000 }],
    [{ field: 'time', before: 'tomorrow', after: null }],
    [{ field: 'status', before: 'scheduled', after: 'unknown' }],
    [{ field: 'amount', before: 18000, after: 20000, note: 'private' }],
  ]) assert.equal(captureActivityChanges(value), null)
})

test('details resolve current specialist names and format allowed values', () => {
  assert.deepEqual(formatActivityChanges([
    { field: 'specialist', before: 'sp_ola', after: 'sp_anna' },
    { field: 'status', before: 'scheduled', after: 'completed' },
    { field: 'amount', before: 18000, after: 20000 },
  ], new Map([['sp_ola', 'Ola'], ['sp_anna', 'Anna']])), [
    { field: 'Specjalistka', before: 'Ola', after: 'Anna' },
    { field: 'Status', before: 'Zaplanowana', after: 'Odbyta' },
    { field: 'Kwota', before: '180,00 zł', after: '200,00 zł' },
  ])
})

test('query capture normalizes empty UI filters and rejects malformed or duplicate values', () => {
  assert.deepEqual(captureActivityHistoryQuery({
    actor: '', client: '', kind: '', from: '', to: '', limit: 20, cursor: '',
  }), {
    actor: null, client: null, kind: null, from: null, to: null, limit: 20, cursor: null,
  })
  assert.deepEqual(captureActivityHistoryQuery({
    actor: 'stf_ola', client: 'cl_anna', kind: 'appointment',
    from: '2026-09-01', to: '2026-09-30', limit: 50,
  }), {
    actor: 'stf_ola', client: 'cl_anna', kind: 'appointment',
    from: '2026-09-01', to: '2026-09-30', limit: 50, cursor: null,
  })
  for (const value of [
    { actor: 'cl_wrong' }, { kind: 'import' }, { client: 'stf_wrong' },
    { from: '2026-02-30' }, { from: '2026-09-30', to: '2026-09-01' },
    { limit: 101 }, { extra: 'private' },
  ]) assert.throws(() => captureActivityHistoryQuery(value), /VALIDATION_FAILED\/query/)
})

test('payload capture admits only display-safe item and filter fields', () => {
  const item = {
    id: 'aud_demo', occurredAt: '2026-09-22T10:00:00.000Z',
    kind: 'client', actorName: 'Fikcyjna Ola', clientName: 'Fikcyjna Anna',
    summary: 'Zmieniono dane klienta', details: [],
  }
  const payload = {
    items: [item], nextCursor: null,
    filters: {
      actors: [{ id: 'stf_ola', label: 'Fikcyjna Ola' }],
      clients: [{ id: 'cl_anna', label: 'Fikcyjna Anna' }],
    },
  }
  assert.deepEqual(captureActivityHistoryPayload(payload), payload)
  assert.deepEqual(captureActivityHistoryPayload({
    ...payload, items: [{ ...item, id: '11111111-1111-4111-8111-111111111111' }],
  }).items[0].id, '11111111-1111-4111-8111-111111111111')
  for (const value of [
    { ...payload, items: [{ ...item, correlationId: 'private' }] },
    { ...payload, items: [{ ...item, details: [{ field: 'Notatka', before: 'a', after: 'b' }] }] },
    { ...payload, filters: { ...payload.filters, actors: [{ id: 'cl_wrong', label: 'X' }] } },
  ]) assert.throws(() => captureActivityHistoryPayload(value), /VALIDATION_FAILED\/activity/)
})
