import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { parseWorkspaceQuery, readWorkspace } from '../../worker/core/workspace.js'
import { getWorkspace } from '../../worker/routes/workspace.js'
import { createApp } from '../../worker/app.js'
import { areSiblingD1QueryBudgetViews, createD1QueryBudget, usageForD1QueryBudgetViews } from '../../worker/db/query-budget.js'
import { applyCoreDirectoryStageB, completeCoreDirectoryStageA } from './apply-migrations.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { buildClientDataKey, encryptClientIdentity } from '../../worker/core/crypto.js'

await completeCoreDirectoryStageA()
await applyCoreDirectoryStageB()

const instant = (day, hour = '10') => `2026-08-${day}T${hour}:00:00.000Z`

const scriptedDb = ({ specialists = [], appointments = [], clients = [], payments = [] } = {}) => {
  const calls = []
  const rowsFor = (sql) => sql.includes('FROM specialists AS specialist') ? specialists
    : sql.includes('charge.id AS charge_id') ? appointments
      : sql.includes('FROM clients AS client') ? clients
        : sql.includes('correction.id AS correction_id') ? payments
          : null
  const db = {
    prepare(sql) {
      const rows = rowsFor(sql)
      if (rows === null) throw new Error('unexpected query')
      return {
        bind(...bindings) {
          return {
            async all() {
              calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), bindings })
              return { results: rows }
            },
          }
        },
      }
    },
    batch() { throw new Error('workspace must not batch') },
  }
  return { db, calls }
}

const specialistRow = (id, staffId, version = 1) => ({
  id, staff_user_id: staffId, standard_rate_grosze: 18000, status: 'active', version,
  staff_id: staffId, staff_specialist_id: id, staff_status: 'active',
  staff_version: version + 2, display_name_envelope: `staff:${staffId}`,
})

const clientRow = (id, status, assignment = null) => ({
  id, identity_envelope: `client:${id}`, status, version: 2,
  archived_at: status === 'archived' ? instant('01') : null,
  created_at: instant('01'), updated_at: instant('02'),
  assignment_id: assignment?.id ?? null,
  assignment_specialist_id: assignment?.specialistId ?? null,
  assignment_starts_at: assignment?.startsAt ?? null,
  assignment_version: assignment?.version ?? null,
  key_id: `key_${id}`, key_scope_type: 'client', key_scope_id: id,
  key_purpose: 'identity', key_dek_version: 1, key_wrapped_key_b64: 'wrapped',
  key_wrap_nonce_b64: 'nonce', key_kek_version: 1, key_created_at: instant('01'),
  key_retired_at: null,
})

const appointmentRow = (id, clientId, specialistId, status = 'completed') => ({
  id, client_id: clientId, specialist_id: specialistId, service_id: 'zajecia',
  starts_at: instant('04'), ends_at: instant('04', '11'), time_zone: 'Europe/Warsaw',
  location: null, status, source: 'panel', version: 3,
  cancelled_at: status === 'cancelled' ? instant('03') : null,
  created_at: instant('01'), updated_at: instant('06'), charge_id: `chg_${id.slice(4)}`,
  charge_service_id: 'zajecia', expected_amount_grosze: 20000,
  currency: 'PLN', charge_version: 1,
})

const paymentRow = (id, appointmentId, amount, receivedAt, correction = null) => ({
  id, appointment_id: appointmentId, amount_grosze: amount, method: 'card',
  received_at: receivedAt, payment_created_at: receivedAt,
  correction_id: correction?.id ?? null,
  corrected_at: correction?.correctedAt ?? null,
  replacement_entry_id: correction?.replacementEntryId ?? null,
})

describe('workspace read model', () => {
  it('rejects an absent workspace query before any database work', () => {
    expect(() => parseWorkspaceQuery('https://panel.example/api/v1/workspace'))
      .toThrow(/^VALIDATION_FAILED$/)
  })

  it.each([
    ['2026-01-15', '2026-01-15', '2026-01-14T23:00:00.000Z', '2026-01-15T23:00:00.000Z'],
    ['2026-07-15', '2026-07-15', '2026-07-14T22:00:00.000Z', '2026-07-15T22:00:00.000Z'],
    ['2026-03-29', '2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
    ['2026-10-25', '2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
  ])('canonicalizes Warsaw window %s through %s', (from, to, lower, upper) => {
    expect(parseWorkspaceQuery(`https://panel.example/api/v1/workspace?from=${from}&to=${to}`))
      .toEqual({ from, to, lower, upper })
  })

  it('accepts inclusive one-day and 93-day bounds and rejects 94 days', () => {
    expect(parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-01-01&to=2026-01-01'))
      .toMatchObject({ from: '2026-01-01', to: '2026-01-01' })
    expect(parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-01-01&to=2026-04-03'))
      .toMatchObject({ from: '2026-01-01', to: '2026-04-03' })
    expect(() => parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-01-01&to=2026-04-04'))
      .toThrow(/^VALIDATION_FAILED$/)
  })

  it.each([
    ['https://panel.example/api/v1/workspace?to=2026-01-01', 'from'],
    ['https://panel.example/api/v1/workspace?from=2026-01-01', 'to'],
    ['https://panel.example/api/v1/workspace?from=&to=2026-01-01', 'from'],
    ['https://panel.example/api/v1/workspace?from=2026-01-01&to=', 'to'],
    ['https://panel.example/api/v1/workspace?from=2026-01-01&from=2026-01-02&to=2026-01-03', 'from'],
    ['https://panel.example/api/v1/workspace?from=2026-01-01&to=2026-01-03&to=2026-01-04', 'to'],
    ['https://panel.example/api/v1/workspace?fr%6fm=2026-01-01&to=2026-01-03', 'from'],
    ['https://panel.example/api/v1/workspace?from=2026-01-01&to=2026-01-03&other=1', 'from'],
    ['https://panel.example/api/v1/workspace?from=2026-02-29&to=2026-03-01', 'from'],
    ['https://panel.example/api/v1/workspace?from=2026-01-01&to=2025-12-31', 'to'],
    ['https://panel.example/api/v1/workspace?from=2026-01-01&to=2026-01-01#fragment', 'from'],
  ])('rejects malformed query with safe field for %s', (url, field) => {
    try {
      parseWorkspaceQuery(url)
      throw new Error('expected rejection')
    } catch (error) {
      expect(error.message).toBe('VALIDATION_FAILED')
      expect(error.details).toEqual({ field })
    }
  })

  it('builds exact sorted DTOs and corrected payment aggregates after scoped selection', async () => {
    const window = parseWorkspaceQuery(
      'https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-31'
    )
    const { db, calls } = scriptedDb({
      specialists: [specialistRow('sp_zofia', 'stf_zofia'), specialistRow('sp_ania', 'stf_ania')],
      clients: [
        clientRow('cl_ola', 'active', {
          id: 'asg_ola', specialistId: 'sp_ania', startsAt: instant('01'), version: 1,
        }),
        clientRow('cl_archived', 'archived'),
      ],
      appointments: [appointmentRow('apt_visit', 'cl_archived', 'sp_ania')],
      payments: [
        paymentRow('pay_original', 'apt_visit', 5000, instant('04', '09'), {
          id: 'cor_original', correctedAt: instant('05'), replacementEntryId: 'pay_replacement',
        }),
        paymentRow('pay_replacement', 'apt_visit', 12000, instant('05', '09')),
      ],
    })
    const decryptSpecialist = vi.fn(async ({ staffId }) => (
      staffId === 'stf_ania' ? 'Ągata Fikcyjna' : 'Zofia Fikcyjna'
    ))
    const decryptClient = vi.fn(async ({ clientId }) => (
      clientId === 'cl_archived'
        ? { name: 'Archiwalna Fikcyjna', age: null }
        : { name: 'Ola Fikcyjna', age: 12 }
    ))
    const result = await readWorkspace({
      db,
      actor: { id: 'stf_owner', role: 'owner', specialistId: 'sp_owner', version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      window,
      decryptSpecialist,
      decryptClient,
    })

    expect(result).toEqual({ data: {
      window: { from: '2026-08-01', to: '2026-08-31', timeZone: 'Europe/Warsaw', complete: true },
      specialists: [
        { id: 'sp_ania', displayName: 'Ągata Fikcyjna', standardRateGrosze: 18000, status: 'active', version: 1, staffVersion: 3 },
        { id: 'sp_zofia', displayName: 'Zofia Fikcyjna', standardRateGrosze: 18000, status: 'active', version: 1, staffVersion: 3 },
      ],
      clients: [
        { id: 'cl_archived', name: 'Archiwalna Fikcyjna', age: null, status: 'archived', version: 2, archivedAt: instant('01'), createdAt: instant('01'), updatedAt: instant('02'), readOnly: true, assignment: null },
        { id: 'cl_ola', name: 'Ola Fikcyjna', age: 12, status: 'active', version: 2, archivedAt: null, createdAt: instant('01'), updatedAt: instant('02'), readOnly: false, assignment: { id: 'asg_ola', specialistId: 'sp_ania', startsAt: instant('01'), version: 1 } },
      ],
      appointments: [{
        id: 'apt_visit', clientId: 'cl_archived', specialistId: 'sp_ania', serviceId: 'zajecia',
        startsAt: instant('04'), endsAt: instant('04', '11'), timeZone: 'Europe/Warsaw',
        location: null, status: 'completed', source: 'panel', version: 3,
        cancelledAt: null, createdAt: instant('01'), updatedAt: instant('06'),
        charge: { id: 'chg_visit', serviceId: 'zajecia', expectedAmountGrosze: 20000, currency: 'PLN', version: 1 },
        payment: { status: 'partial', collectedGrosze: 12000, outstandingGrosze: 8000, latestMethod: 'card', latestReceivedAt: instant('05', '09') },
        paymentEntries: [
          { id: 'pay_original', amountGrosze: 5000, method: 'card', receivedAt: instant('04', '09'), correctedAt: instant('05'), replacementEntryId: 'pay_replacement' },
          { id: 'pay_replacement', amountGrosze: 12000, method: 'card', receivedAt: instant('05', '09'), correctedAt: null, replacementEntryId: null },
        ],
      }],
    } })
    expect(calls).toHaveLength(4)
    expect(calls[0].sql).toContain("specialist.status='active'")
    expect(calls[0].sql).toContain("staff.status='active'")
    expect(calls[0].sql).not.toContain("staff.role='specialist'")
    expect(calls[1].bindings).toEqual([window.lower, window.upper, 501])
    expect(calls[2].bindings).toEqual([window.lower, window.upper, 201])
    expect(calls[3].bindings).toEqual([window.lower, window.upper, 1001])
    expect(decryptSpecialist).toHaveBeenCalledTimes(2)
    expect(decryptClient).toHaveBeenCalledTimes(2)
    expect(Object.isFrozen(result.data.appointments[0].paymentEntries)).toBe(true)
    expect(Object.isFrozen(result.data)).toBe(true)
  })

  it('pushes specialist assignment and history scope into every record query', async () => {
    const window = parseWorkspaceQuery(
      'https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'
    )
    const { db, calls } = scriptedDb()
    await readWorkspace({
      db,
      actor: { id: 'stf_spec', role: 'specialist', specialistId: 'sp_spec', version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      window,
      decryptSpecialist: async () => 'Never',
      decryptClient: async () => ({ name: 'Never', age: null }),
    })
    expect(calls).toHaveLength(4)
    expect(calls[1].sql).toContain('appointment.specialist_id=?')
    expect(calls[2].sql).toContain('assignment.specialist_id=?')
    expect(calls[2].sql).toContain('history.specialist_id=?')
    expect(calls[3].sql).toContain('appointment.specialist_id=?')
    expect(calls[1].bindings).toEqual(['sp_spec', window.lower, window.upper, 501])
    expect(calls[2].bindings).toEqual(['sp_spec', 'sp_spec', window.lower, window.upper, 201])
    expect(calls[3].bindings).toEqual(['sp_spec', window.lower, window.upper, 1001])
  })

  it.each([
    ['specialists', 50, { specialists: Array.from({ length: 51 }, (_, index) => specialistRow(`sp_cap_${index}`, `stf_cap_${index}`)) }, 1],
    ['appointments', 500, { appointments: Array.from({ length: 501 }, (_, index) => appointmentRow(`apt_cap_${index}`, 'cl_cap', 'sp_cap')) }, 2],
    ['clients', 200, { clients: Array.from({ length: 201 }, (_, index) => clientRow(`cl_cap_${index}`, 'active', { id: `asg_cap_${index}`, specialistId: 'sp_cap', startsAt: instant('01'), version: 1 })) }, 3],
    ['paymentEntries', 1000, { payments: Array.from({ length: 1001 }, (_, index) => paymentRow(`pay_cap_${index}`, 'apt_cap', 1, instant('04'))) }, 4],
  ])('returns exact no-truncation cap for %s', async (field, publicLimit, rows, queryCount) => {
    const { db, calls } = scriptedDb(rows)
    await expect(readWorkspace({
      db,
      actor: { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'),
      decryptSpecialist: async () => 'Fikcyjna',
      decryptClient: async () => ({ name: 'Fikcyjna', age: null }),
    })).rejects.toMatchObject({
      message: 'WORKSPACE_RESULT_LIMIT', details: { field, limit: publicLimit },
    })
    expect(calls).toHaveLength(queryCount)
  })

  it('returns every row at all public maxima without truncation in four statements', async () => {
    const specialists = Array.from({ length: 50 }, (_, index) => (
      specialistRow(`sp_max_${index}`, `stf_max_${index}`)
    ))
    const clients = Array.from({ length: 200 }, (_, index) => clientRow(
      `cl_max_${index}`, 'active', {
        id: `asg_max_${index}`, specialistId: 'sp_max_0',
        startsAt: instant('01'), version: 1,
      }
    ))
    const appointments = Array.from({ length: 500 }, (_, index) => (
      appointmentRow(`apt_max_${index}`, 'cl_max_0', 'sp_max_0')
    ))
    const payments = Array.from({ length: 1000 }, (_, index) => (
      paymentRow(`pay_max_${index}`, 'apt_max_0', 1, instant('04'))
    ))
    const { db, calls } = scriptedDb({ specialists, clients, appointments, payments })
    const result = await readWorkspace({
      db,
      actor: { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'),
      decryptSpecialist: async ({ staffId }) => `Fikcyjna ${staffId}`,
      decryptClient: async ({ clientId }) => ({ name: `Fikcyjna ${clientId}`, age: null }),
    })
    expect(result.data.specialists).toHaveLength(50)
    expect(result.data.clients).toHaveLength(200)
    expect(result.data.appointments).toHaveLength(500)
    expect(result.data.appointments.find(({ id }) => id === 'apt_max_0').paymentEntries)
      .toHaveLength(1000)
    expect(calls).toHaveLength(4)
  })

  it('rejects dangling and duplicate appointment facts from a malformed result surface', async () => {
    const common = {
      actor: { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'),
      decryptSpecialist: async () => 'Fikcyjna',
      decryptClient: async () => ({ name: 'Fikcyjna', age: null }),
    }
    for (const appointments of [
      [appointmentRow('apt_dangling', 'cl_absent', 'sp_owner')],
      [appointmentRow('apt_duplicate', 'cl_present', 'sp_owner'), appointmentRow('apt_duplicate', 'cl_present', 'sp_owner')],
    ]) {
      const clients = appointments[0].client_id === 'cl_present'
        ? [clientRow('cl_present', 'active', { id: 'asg_present', specialistId: 'sp_owner', startsAt: instant('01'), version: 1 })]
        : []
      await expect(readWorkspace({ ...common, db: scriptedDb({ appointments, clients }).db }))
        .rejects.toThrow(/^INTERNAL_ERROR$/)
    }
  })

  it('rejects impossible cancellation, archive, and current-assignment timestamps', async () => {
    const common = {
      actor: { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'),
      decryptSpecialist: async () => 'Fikcyjna',
      decryptClient: async () => ({ name: 'Fikcyjna', age: null }),
    }
    const badCancellation = {
      ...appointmentRow('apt_bad_cancel', 'cl_bad_cancel', 'sp_owner', 'cancelled'),
      cancelled_at: '2026-07-31T10:00:00.000Z',
    }
    await expect(readWorkspace({
      ...common,
      db: scriptedDb({
        appointments: [badCancellation],
        clients: [clientRow('cl_bad_cancel', 'active', {
          id: 'asg_bad_cancel', specialistId: 'sp_owner', startsAt: instant('01'), version: 1,
        })],
      }).db,
    })).rejects.toThrow(/^INTERNAL_ERROR$/)

    const archived = {
      ...clientRow('cl_bad_archive', 'archived'),
      archived_at: '2026-07-31T10:00:00.000Z',
    }
    await expect(readWorkspace({
      ...common,
      db: scriptedDb({
        appointments: [appointmentRow('apt_bad_archive', archived.id, 'sp_owner')],
        clients: [archived],
      }).db,
    })).rejects.toThrow(/^INTERNAL_ERROR$/)

    const assigned = clientRow('cl_bad_assignment', 'active', {
      id: 'asg_bad_assignment', specialistId: 'sp_owner',
      startsAt: '2026-07-31T10:00:00.000Z', version: 1,
    })
    await expect(readWorkspace({ ...common, db: scriptedDb({ clients: [assigned] }).db }))
      .rejects.toThrow(/^INTERNAL_ERROR$/)
  })

  it('rejects malformed correction graphs and never exposes correction reasons', async () => {
    const appointment = appointmentRow('apt_payment_graph', 'cl_payment_graph', 'sp_owner')
    const client = clientRow('cl_payment_graph', 'active', {
      id: 'asg_payment_graph', specialistId: 'sp_owner', startsAt: instant('01'), version: 1,
    })
    const common = {
      specialists: [], appointments: [appointment], clients: [client],
    }
    for (const payments of [
      [paymentRow('pay_graph', appointment.id, 5000, instant('04'), { id: 'cor_graph', correctedAt: instant('05'), replacementEntryId: 'pay_missing' })],
      [paymentRow('pay_graph', appointment.id, 25000, instant('04'))],
      [paymentRow('pay_graph', appointment.id, 5000, instant('04'), { id: 'cor_graph', correctedAt: instant('03'), replacementEntryId: null })],
    ]) {
      await expect(readWorkspace({
        db: scriptedDb({ ...common, payments }).db,
        actor: { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 },
        cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
        window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'),
        decryptSpecialist: async () => 'Fikcyjna',
        decryptClient: async () => ({ name: 'Fikcyjna', age: null }),
      })).rejects.toThrow(/^INTERNAL_ERROR$/)
    }
  })

  it('rejects correction cycles and replacement entries reused by multiple reversals', async () => {
    const appointment = appointmentRow('apt_payment_links', 'cl_payment_links', 'sp_owner')
    const client = clientRow('cl_payment_links', 'active', {
      id: 'asg_payment_links', specialistId: 'sp_owner', startsAt: instant('01'), version: 1,
    })
    const cases = [
      [
        paymentRow('pay_link_a', appointment.id, 5000, instant('04'), { id: 'cor_link_a', correctedAt: instant('06'), replacementEntryId: 'pay_link_c' }),
        paymentRow('pay_link_b', appointment.id, 5000, instant('04', '11'), { id: 'cor_link_b', correctedAt: instant('06'), replacementEntryId: 'pay_link_c' }),
        paymentRow('pay_link_c', appointment.id, 5000, instant('05')),
      ],
      [
        paymentRow('pay_cycle_a', appointment.id, 5000, instant('04'), { id: 'cor_cycle_a', correctedAt: instant('06'), replacementEntryId: 'pay_cycle_b' }),
        paymentRow('pay_cycle_b', appointment.id, 5000, instant('05'), { id: 'cor_cycle_b', correctedAt: instant('06'), replacementEntryId: 'pay_cycle_a' }),
      ],
    ]
    for (const payments of cases) {
      await expect(readWorkspace({
        db: scriptedDb({ appointments: [appointment], clients: [client], payments }).db,
        actor: { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 },
        cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
        window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'),
        decryptSpecialist: async () => 'Fikcyjna',
        decryptClient: async () => ({ name: 'Fikcyjna', age: null }),
      })).rejects.toThrow(/^INTERNAL_ERROR$/)
    }
  })

  it('rejects out-of-scope facts and accessor rows before identity decryption', async () => {
    const decryptSpecialist = vi.fn(async () => 'Secret')
    const decryptClient = vi.fn(async () => ({ name: 'Secret', age: 10 }))
    const appointment = appointmentRow('apt_other_scope', 'cl_other_scope', 'sp_other')
    await expect(readWorkspace({
      db: scriptedDb({ appointments: [appointment] }).db,
      actor: { id: 'stf_spec', role: 'specialist', specialistId: 'sp_spec', version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'),
      decryptSpecialist, decryptClient,
    })).rejects.toThrow(/^INTERNAL_ERROR$/)
    expect(decryptSpecialist).not.toHaveBeenCalled()
    expect(decryptClient).not.toHaveBeenCalled()

    let getterReads = 0
    const hostile = Object.defineProperty(specialistRow('sp_hostile', 'stf_hostile'), 'status', {
      enumerable: true,
      get() { getterReads += 1; return 'active' },
    })
    await expect(readWorkspace({
      db: scriptedDb({ specialists: [hostile] }).db,
      actor: { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'),
      decryptSpecialist, decryptClient,
    })).rejects.toThrow(/^INTERNAL_ERROR$/)
    expect(getterReads).toBe(0)
    expect(decryptSpecialist).not.toHaveBeenCalled()
  })

  it('adapts the exact GET URL and work-budget view to the read model', async () => {
    const db = scriptedDb().db
    const actor = { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 }
    const cryptoContext = { keyring: {}, dataKey: {}, scope: {} }
    const read = vi.fn(async ({ window }) => ({ data: {
      window: { from: window.from, to: window.to, timeZone: 'Europe/Warsaw', complete: true },
      specialists: [], clients: [], appointments: [],
    } }))
    const result = await getWorkspace({
      db, actor, cryptoContext,
      url: 'https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02',
      read,
    })
    expect(result.data.window).toEqual({
      from: '2026-08-01', to: '2026-08-02', timeZone: 'Europe/Warsaw', complete: true,
    })
    expect(read).toHaveBeenCalledWith({
      db, actor, cryptoContext,
      window: expect.objectContaining({ from: '2026-08-01', to: '2026-08-02' }),
    })
  })

  it('wires only GET/HEAD through the authentic work view and leaves recovery unused', async () => {
    const raw = scriptedDb().db
    let actorViews
    const service = vi.fn(async ({ db }) => {
      expect(db).toBe(actorViews.work)
      expect(usageForD1QueryBudgetViews(db, actorViews.recovery)).toEqual({
        used: 0, remaining: 50, workRemaining: 42, totalLimit: 50, recoveryReserve: 8,
      })
      return { data: {
        window: { from: '2026-08-01', to: '2026-08-02', timeZone: 'Europe/Warsaw', complete: true },
        specialists: [], clients: [], appointments: [],
      } }
    })
    const app = createApp({
      db: raw,
      config: { appEnv: 'staging', appOrigin: 'https://panel.example', dataMode: 'fictional' },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      resolveAccessPrincipal: async () => ({ kind: 'human', subject: 'access-workspace' }),
      resolveActor: async (work, _principal, _crypto, { recoveryDb }) => {
        expect(areSiblingD1QueryBudgetViews(work, recoveryDb)).toBe(true)
        actorViews = { work, recovery: recoveryDb }
        return { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 }
      },
      getWorkspace: service,
    })
    const url = '/api/v1/workspace?from=2026-08-01&to=2026-08-02'
    const get = await app.request(url)
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ data: {
      window: { from: '2026-08-01', to: '2026-08-02', timeZone: 'Europe/Warsaw', complete: true },
      specialists: [], clients: [], appointments: [],
    } })
    const head = await app.request(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const options = await app.request(url, {
      method: 'OPTIONS', headers: { origin: 'https://panel.example' },
    })
    expect(options.status).toBe(204)
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    expect(service).toHaveBeenCalledTimes(2)
    expect(usageForD1QueryBudgetViews(actorViews.work, actorViews.recovery).used).toBe(0)
  })

  it('executes the real empty D1 read in four domain statements and seven full-route statements', async () => {
    let views
    const response = await createApp({
      db: env.DB,
      config: { appEnv: 'staging', appOrigin: 'https://panel.example', dataMode: 'fictional' },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      resolveAccessPrincipal: async () => ({ kind: 'human', subject: 'access-workspace-real' }),
      resolveActor: async (work, _principal, _crypto, { recoveryDb }) => {
        views = { work, recovery: recoveryDb }
        await work.prepare('SELECT 1').first()
        await work.prepare('SELECT 2').first()
        await work.prepare('SELECT 3').first()
        return { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 }
      },
    }).request('/api/v1/workspace?from=2026-08-01&to=2026-08-02')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: {
      window: { from: '2026-08-01', to: '2026-08-02', timeZone: 'Europe/Warsaw', complete: true },
      specialists: [], clients: [], appointments: [],
    } })
    expect(usageForD1QueryBudgetViews(views.work, views.recovery)).toEqual({
      used: 7, remaining: 43, workRemaining: 35, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('uses bounded declared/automatic indexes for every workspace relationship', async () => {
    const scripted = scriptedDb()
    await readWorkspace({
      db: scripted.db,
      actor: { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-02'),
      decryptSpecialist: async () => 'Fikcyjna',
      decryptClient: async () => ({ name: 'Fikcyjna', age: null }),
    })
    const plans = []
    for (const call of scripted.calls) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).bind(...call.bindings).all()
      plans.push(plan.results.map(({ detail }) => detail))
    }
    expect(plans[0]).toEqual(expect.arrayContaining([
      expect.stringContaining('specialists_status_id_idx'),
      expect.stringContaining('staff_users_specialist_id_idx'),
    ]))
    expect(plans[1]).toEqual(expect.arrayContaining([
      expect.stringContaining('appointments_specialist_starts_id_idx (specialist_id=? AND starts_at>? AND starts_at<?)'),
      expect.stringContaining('sqlite_autoindex_session_charges_2 (appointment_id=?)'),
    ]))
    expect(plans[2]).toEqual(expect.arrayContaining([
      expect.stringContaining('client_assignments_open_client_idx (client_id=?)'),
      expect.stringContaining('appointments_client_starts_id_idx (client_id=? AND starts_at>? AND starts_at<?)'),
    ]))
    expect(plans[3]).toEqual(expect.arrayContaining([
      expect.stringContaining('appointments_specialist_starts_id_idx (specialist_id=? AND starts_at>? AND starts_at<?)'),
      expect.stringContaining('AUTOMATIC COVERING INDEX (appointment_id=?)'),
      expect.stringContaining('sqlite_autoindex_payment_corrections_2 (reversed_entry_id=?)'),
    ]))
    expect(plans.flat().filter((detail) => /^SCAN (?:appointment|payment)\b/.test(detail))).toEqual([])
  })

  it('decrypts only SQL-authorized staff/client identities with exact AAD and retired client keys', async () => {
    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
    })
    const staffScope = { type: 'staff_directory', id: 'centre_workspace', purpose: 'identity' }
    const staffKey = await getOrCreateDataKey(env.DB, keyring, staffScope, {
      id: 'key_workspace_staff', createdAt: instant('01'),
    })
    const staffId = 'stf_workspace_practitioner'
    const specialistId = 'sp_workspace_practitioner'
    const displayEnvelope = JSON.stringify(await encryptForScope(keyring, staffKey, {
      expectedScope: staffScope, recordId: staffId, field: 'display_name',
      plaintext: 'Żaneta Fikcyjna',
    }))
    const clientId = 'cl_workspace_history'
    const built = await buildClientDataKey(env.DB, keyring, {
      clientId, dataKeyId: 'key_workspace_client', createdAt: instant('01'),
    })
    const clientContext = { keyring, dataKey: built.row, scope: built.scope }
    const identityEnvelope = await encryptClientIdentity(clientContext, {
      clientId, name: 'Łucja Fikcyjna', age: 11,
    })
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO staff_users
         (id,email_lookup,email_envelope,display_name_envelope,role,status,
          access_subject,specialist_id,version,activated_at,created_at,updated_at)
         VALUES (?,?,?,?,'coordinator','active',?,?,4,?,?,?)`
      ).bind(staffId, 'workspace@example.test', '{}', displayEnvelope,
        'access-workspace-practitioner', specialistId, instant('01'), instant('01'), instant('01')),
      env.DB.prepare(
        `INSERT INTO specialists
         (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
         VALUES (?,?,19000,'active',2,NULL,?,?)`
      ).bind(specialistId, staffId, instant('01'), instant('02')),
      built.statement,
      env.DB.prepare(
        `INSERT INTO clients
         (id,identity_envelope,status,version,archived_at,created_at,updated_at)
         VALUES (?,?,'active',2,NULL,?,?)`
      ).bind(clientId, identityEnvelope, instant('01'), instant('02')),
      env.DB.prepare(
        `INSERT INTO client_assignments
         (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
          version,created_at,updated_at)
         VALUES (?,?,?, ?,NULL,?,1,?,?)`
      ).bind('asg_workspace_history', clientId, specialistId, instant('01'), staffId,
        instant('01'), instant('01')),
      env.DB.prepare(
        `INSERT INTO appointments
         (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,
          location,status,source,version,cancelled_at,created_at,updated_at)
         VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'completed','panel',1,NULL,?,?)`
      ).bind('apt_workspace_history', clientId, specialistId, instant('04'), instant('04', '11'),
        instant('01'), instant('06')),
      env.DB.prepare(
        `INSERT INTO session_charges
         (id,appointment_id,service_id,expected_amount_grosze,currency,version,created_at,updated_at)
         VALUES ('chg_workspace_history','apt_workspace_history','zajecia',20000,'PLN',1,?,?)`
      ).bind(instant('01'), instant('01')),
      env.DB.prepare(
        `INSERT INTO payment_entries
         (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
          external_reference_envelope,created_at)
         VALUES ('pay_workspace_history','apt_workspace_history',20000,'transfer',?,?,NULL,?)`
      ).bind(instant('05'), staffId, instant('05')),
    ])
    await env.DB.prepare('UPDATE data_keys SET retired_at=? WHERE id=?')
      .bind(instant('06'), built.row.id).run()

    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const result = await readWorkspace({
      db: budget.work,
      actor: { id: 'stf_owner', role: 'owner', specialistId: null, version: 1 },
      cryptoContext: { keyring, dataKey: staffKey, scope: staffScope },
      window: parseWorkspaceQuery('https://panel.example/api/v1/workspace?from=2026-08-01&to=2026-08-31'),
    })
    expect(result.data.specialists).toEqual([{
      id: specialistId, displayName: 'Żaneta Fikcyjna', standardRateGrosze: 19000,
      status: 'active', version: 2, staffVersion: 4,
    }])
    expect(result.data.clients[0]).toMatchObject({ id: clientId, name: 'Łucja Fikcyjna', age: 11 })
    expect(result.data.appointments[0].payment).toEqual({
      status: 'paid', collectedGrosze: 20000, outstandingGrosze: 0,
      latestMethod: 'transfer', latestReceivedAt: instant('05'),
    })
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery).used).toBe(4)
    expect(JSON.stringify(result)).not.toContain('workspace@example.test')
    expect(JSON.stringify(result)).not.toContain('access-workspace-practitioner')
    expect(JSON.stringify(result)).not.toContain('ciphertext')
  })
})
