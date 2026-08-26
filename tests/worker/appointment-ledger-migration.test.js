import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyCoreDirectoryStageB,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const now = '2026-08-04T08:00:00.000Z'
const later = '2026-08-04T08:50:00.000Z'
const updated = '2026-08-04T09:00:00.000Z'
const muchLater = '2026-08-04T10:00:00.000Z'

const serviceIds = [
  'asrs',
  'conners',
  'konsultacja',
  'obserwacja-dom',
  'obserwacja-placowka',
  'plan',
  'plan-spotkanie',
  'superwizja',
  'terapia-rodzinna',
  'warsztaty',
  'zajecia',
]

const idGrammarCases = (prefix) => ({
  valid: [
    `${prefix}a`,
    `${prefix}A0_z-9`,
    `${prefix}${'z'.repeat(124)}`,
  ],
  invalid: [
    null,
    '',
    'bad_a',
    prefix,
    `${prefix}_first`,
    `${prefix}-first`,
    `${prefix}a\0tail`,
    `${prefix}ą`,
    `${prefix}a!`,
    `${prefix}${'z'.repeat(125)}`,
  ],
})

const run = (sql, ...values) => env.DB.prepare(sql).bind(...values).run()
const one = (sql, ...values) => env.DB.prepare(sql).bind(...values).first()
const all = async (sql, ...values) => (
  await env.DB.prepare(sql).bind(...values).all()
).results

const caughtError = async (operation) => {
  try {
    await operation()
  } catch (error) {
    return String(error)
  }
  throw new Error('expected operation to fail')
}

const insertAppointment = (overrides = {}) => {
  const row = {
    id: 'apt_ledger_one',
    clientId: 'cl_ledger_one',
    specialistId: 'sp_ledger_one',
    serviceId: 'zajecia',
    startsAt: now,
    endsAt: later,
    timeZone: 'Europe/Warsaw',
    location: null,
    status: 'completed',
    source: 'panel',
    version: 1,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  return run(
    `INSERT INTO appointments
     (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
      status,source,version,cancelled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.id,
    row.clientId,
    row.specialistId,
    row.serviceId,
    row.startsAt,
    row.endsAt,
    row.timeZone,
    row.location,
    row.status,
    row.source,
    row.version,
    row.cancelledAt,
    row.createdAt,
    row.updatedAt,
  )
}

const insertCharge = (overrides = {}) => {
  const row = {
    id: 'chg_ledger_one',
    appointmentId: 'apt_ledger_one',
    serviceId: 'zajecia',
    expectedAmountGrosze: 18000,
    currency: 'PLN',
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  return run(
    `INSERT INTO session_charges
     (id,appointment_id,service_id,expected_amount_grosze,currency,version,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    row.id,
    row.appointmentId,
    row.serviceId,
    row.expectedAmountGrosze,
    row.currency,
    row.version,
    row.createdAt,
    row.updatedAt,
  )
}

const insertPayment = (overrides = {}) => {
  const row = {
    id: 'pay_ledger_one',
    appointmentId: 'apt_ledger_one',
    amountGrosze: 9000,
    method: 'cash',
    receivedAt: now,
    recordedByStaffId: 'stf_ledger_one',
    externalReferenceEnvelope: null,
    createdAt: now,
    ...overrides,
  }
  return run(
    `INSERT INTO payment_entries
     (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
      external_reference_envelope,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    row.id,
    row.appointmentId,
    row.amountGrosze,
    row.method,
    row.receivedAt,
    row.recordedByStaffId,
    row.externalReferenceEnvelope,
    row.createdAt,
  )
}

const insertCorrection = (overrides = {}) => {
  const row = {
    id: 'cor_ledger_one',
    reversedEntryId: 'pay_ledger_one',
    replacementEntryId: null,
    reasonEnvelope: '{}',
    recordedByStaffId: 'stf_ledger_one',
    createdAt: updated,
    ...overrides,
  }
  return run(
    `INSERT INTO payment_corrections
     (id,reversed_entry_id,replacement_entry_id,reason_envelope,recorded_by_staff_id,created_at)
     VALUES (?,?,?,?,?,?)`,
    row.id,
    row.reversedEntryId,
    row.replacementEntryId,
    row.reasonEnvelope,
    row.recordedByStaffId,
    row.createdAt,
  )
}

const seedParents = async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO specialists
       (id,staff_user_id,status,created_at,updated_at)
       VALUES ('sp_ledger_one','stf_ledger_one','active',?,?)`
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO specialists
       (id,staff_user_id,status,created_at,updated_at)
       VALUES ('sp_ledger_two','stf_ledger_two','active',?,?)`
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
        specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       VALUES ('stf_ledger_one','stf_ledger_one_lookup','{}','{}','coordinator','active',
               'stf_ledger_one_subject','sp_ledger_one',1,?,NULL,?,?)`
    ).bind(now, now, now),
    env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
        specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       VALUES ('stf_ledger_two','stf_ledger_two_lookup','{}','{}','coordinator','active',
               'stf_ledger_two_subject','sp_ledger_two',1,?,NULL,?,?)`
    ).bind(now, now, now),
  ])
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO clients
       (id,identity_envelope,status,created_at,updated_at)
       VALUES ('cl_ledger_one','{}','active',?,?)`
    ).bind(now, now),
    env.DB.prepare(
      `INSERT INTO clients
       (id,identity_envelope,status,created_at,updated_at)
       VALUES ('cl_ledger_two','{}','active',?,?)`
    ).bind(now, now),
  ])
}

describe('appointment ledger migration', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await seedParents()
  })

  it('applies 0010 then 0011 and creates the exact ledger columns', async () => {
    expect(await all(
      "SELECT name FROM d1_migrations WHERE name>='0010' ORDER BY id"
    )).toEqual([
      { name: '0010_specialist_lifecycle_assertion.sql' },
      { name: '0011_appointment_ledger.sql' },
    ])

    const expectedColumns = {
      appointments: ['id', 'client_id', 'specialist_id', 'service_id', 'starts_at', 'ends_at', 'time_zone', 'location', 'status', 'source', 'version', 'cancelled_at', 'created_at', 'updated_at'],
      payment_corrections: ['id', 'reversed_entry_id', 'replacement_entry_id', 'reason_envelope', 'recorded_by_staff_id', 'created_at'],
      payment_entries: ['id', 'appointment_id', 'amount_grosze', 'method', 'received_at', 'recorded_by_staff_id', 'external_reference_envelope', 'created_at'],
      session_charges: ['id', 'appointment_id', 'service_id', 'expected_amount_grosze', 'currency', 'version', 'created_at', 'updated_at'],
    }
    for (const [table, columns] of Object.entries(expectedColumns)) {
      expect((await all(`PRAGMA table_info(${table})`))
        .map(({ name }) => name)).toEqual(columns)
    }
  })

  it('creates every required unique and scheduling index over exact columns', async () => {
    const indexSignatures = async (table) => {
      const signatures = await Promise.all((await all(`PRAGMA index_list(${table})`))
        .map(async ({ name, origin, unique }) => ({
          columns: (await all(`PRAGMA index_info(${name})`)).map(({ name: column }) => column),
          origin,
          unique,
        })))
      return signatures.sort((left, right) => (
        left.columns.join(',').localeCompare(right.columns.join(','))
      ))
    }

    expect(await indexSignatures('appointments')).toEqual([
      { columns: ['client_id', 'starts_at', 'id'], origin: 'c', unique: 0 },
      { columns: ['id'], origin: 'pk', unique: 1 },
      { columns: ['specialist_id', 'starts_at', 'id'], origin: 'c', unique: 0 },
    ])
    expect(await indexSignatures('session_charges')).toEqual([
      { columns: ['appointment_id'], origin: 'u', unique: 1 },
      { columns: ['id'], origin: 'pk', unique: 1 },
    ])
    expect(await indexSignatures('payment_entries')).toEqual([
      { columns: ['id'], origin: 'pk', unique: 1 },
    ])
    expect(await indexSignatures('payment_corrections')).toEqual([
      { columns: ['id'], origin: 'pk', unique: 1 },
      { columns: ['replacement_entry_id'], origin: 'u', unique: 1 },
      { columns: ['reversed_entry_id'], origin: 'u', unique: 1 },
    ])

    expect((await all(
      `SELECT name FROM sqlite_schema
       WHERE type='index' AND name LIKE 'appointments_%_starts_id_idx'
       ORDER BY name`
    )).map(({ name }) => name)).toEqual([
      'appointments_client_starts_id_idx',
      'appointments_specialist_starts_id_idx',
    ])
  })

  it('declares the exact restrictive foreign-key map without cascade or permissive actions', async () => {
    const expected = {
      appointments: [
        { from: 'client_id', table: 'clients', to: 'id' },
        { from: 'specialist_id', table: 'specialists', to: 'id' },
      ],
      payment_corrections: [
        { from: 'recorded_by_staff_id', table: 'staff_users', to: 'id' },
        { from: 'replacement_entry_id', table: 'payment_entries', to: 'id' },
        { from: 'reversed_entry_id', table: 'payment_entries', to: 'id' },
      ],
      payment_entries: [
        { from: 'appointment_id', table: 'appointments', to: 'id' },
        { from: 'recorded_by_staff_id', table: 'staff_users', to: 'id' },
      ],
      session_charges: [
        { from: 'appointment_id', table: 'appointments', to: 'id' },
      ],
    }

    for (const [table, wanted] of Object.entries(expected)) {
      const observed = (await all(`PRAGMA foreign_key_list(${table})`))
        .map(({ from, on_delete: onDelete, on_update: onUpdate, table, to }) => ({
          from,
          onDelete,
          onUpdate,
          table,
          to,
        }))
        .sort((left, right) => left.from.localeCompare(right.from))
      expect(observed).toEqual(wanted.map((foreignKey) => ({
        ...foreignKey,
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
      })))
    }
  })

  it('applies the exact appointment and charge defaults when callers omit them', async () => {
    await run(
      `INSERT INTO appointments
       (id,client_id,specialist_id,service_id,starts_at,ends_at,location,status,
        cancelled_at,created_at,updated_at)
       VALUES ('apt_default_values','cl_ledger_one','sp_ledger_one','zajecia',?,?,NULL,
               'completed',NULL,?,?)`,
      now,
      later,
      now,
      now,
    )
    await run(
      `INSERT INTO session_charges
       (id,appointment_id,service_id,expected_amount_grosze,created_at,updated_at)
       VALUES ('chg_default_values','apt_default_values','zajecia',18000,?,?)`,
      now,
      now,
    )
    expect(await one(
      `SELECT time_zone,source,version
       FROM appointments WHERE id='apt_default_values'`
    )).toEqual({ source: 'panel', time_zone: 'Europe/Warsaw', version: 1 })
    expect(await one(
      `SELECT currency,version
       FROM session_charges WHERE id='chg_default_values'`
    )).toEqual({ currency: 'PLN', version: 1 })
  })

  it('enforces every entity ID prefix, ASCII alphabet, and 5..128-byte boundary', async () => {
    const appointmentIds = idGrammarCases('apt_')
    for (const id of appointmentIds.valid) {
      await insertAppointment({ id })
    }
    for (const id of appointmentIds.invalid) {
      await expect(insertAppointment({ id })).rejects.toThrow()
    }

    const chargeIds = idGrammarCases('chg_')
    for (const [index, id] of chargeIds.valid.entries()) {
      const appointmentId = `apt_charge_id_${index}`
      await insertAppointment({ id: appointmentId })
      await insertCharge({ id, appointmentId })
    }
    await insertAppointment({ id: 'apt_charge_id_invalid' })
    for (const id of chargeIds.invalid) {
      await expect(insertCharge({ id, appointmentId: 'apt_charge_id_invalid' }))
        .rejects.toThrow()
    }

    await insertAppointment({ id: 'apt_payment_id_grammar' })
    const paymentIds = idGrammarCases('pay_')
    for (const id of paymentIds.valid) {
      await insertPayment({ id, appointmentId: 'apt_payment_id_grammar' })
    }
    for (const id of paymentIds.invalid) {
      await expect(insertPayment({ id, appointmentId: 'apt_payment_id_grammar' }))
        .rejects.toThrow()
    }

    await insertAppointment({ id: 'apt_correction_id_grammar' })
    const correctionIds = idGrammarCases('cor_')
    for (const [index, id] of correctionIds.valid.entries()) {
      const reversedEntryId = `pay_correction_id_${index}`
      await insertPayment({
        id: reversedEntryId,
        appointmentId: 'apt_correction_id_grammar',
      })
      await insertCorrection({ id, reversedEntryId })
    }
    await insertPayment({
      id: 'pay_correction_id_invalid',
      appointmentId: 'apt_correction_id_grammar',
    })
    for (const id of correctionIds.invalid) {
      await expect(insertCorrection({
        id,
        reversedEntryId: 'pay_correction_id_invalid',
      })).rejects.toThrow()
    }
  })

  it('accepts every closed appointment service and status at their legal boundaries', async () => {
    for (const [index, serviceId] of serviceIds.entries()) {
      await insertAppointment({ id: `apt_service_${index}`, serviceId })
    }

    const statuses = [
      { cancelledAt: null, status: 'completed' },
      { cancelledAt: null, status: 'noshow' },
      { cancelledAt: null, status: 'scheduled' },
      { cancelledAt: updated, status: 'cancelled' },
    ]
    for (const [index, status] of statuses.entries()) {
      await insertAppointment({ id: `apt_status_${index}`, ...status })
    }

    const locations = [null, 'A', 'x'.repeat(80), 'ą'.repeat(40)]
    for (const [index, location] of locations.entries()) {
      await insertAppointment({ id: `apt_location_valid_${index}`, location })
    }
  })

  it('rejects every invalid appointment parent, enum, time, cancellation, location, and version branch', async () => {
    const invalidCases = [
      { label: 'missing client', overrides: { clientId: 'cl_missing' } },
      { label: 'missing specialist', overrides: { specialistId: 'sp_missing' } },
      { label: 'unknown service', overrides: { serviceId: 'unknown-service' } },
      { label: 'noncanonical start', overrides: { startsAt: '2026-08-04T08:00:00Z' } },
      { label: 'noncanonical end', overrides: { endsAt: '2026-08-04T08:50:00Z' } },
      { label: 'end equal to start', overrides: { endsAt: now } },
      { label: 'end before start', overrides: { endsAt: '2026-08-04T07:59:59.999Z' } },
      { label: 'other time zone', overrides: { timeZone: 'UTC' } },
      { label: 'empty location', overrides: { location: '' } },
      { label: 'space location', overrides: { location: ' ' } },
      { label: 'leading space location', overrides: { location: ' Gabinet' } },
      { label: 'trailing space location', overrides: { location: 'Gabinet ' } },
      { label: '81-byte location', overrides: { location: 'x'.repeat(81) } },
      { label: '82-byte multibyte location', overrides: { location: 'ą'.repeat(41) } },
      { label: 'unknown status', overrides: { status: 'paid' } },
      { label: 'other source', overrides: { source: 'import' } },
      { label: 'zero version', overrides: { version: 0 } },
      { label: 'fractional version', overrides: { version: 1.5 } },
      { label: 'cancelled without time', overrides: { status: 'cancelled' } },
      { label: 'noncancelled with time', overrides: { cancelledAt: updated } },
      {
        label: 'cancelled with noncanonical time',
        overrides: { cancelledAt: '2026-08-04T09:00:00Z', status: 'cancelled' },
      },
      { label: 'noncanonical creation', overrides: { createdAt: '2026-08-04T08:00:00Z' } },
      { label: 'noncanonical update', overrides: { updatedAt: '2026-08-04T08:00:00Z' } },
    ]
    for (const { label, overrides } of invalidCases) {
      await expect(insertAppointment({ id: `apt_invalid_${label.replaceAll(' ', '_')}`, ...overrides }))
        .rejects.toThrow()
    }

    const requiredFields = [
      'clientId',
      'specialistId',
      'serviceId',
      'startsAt',
      'endsAt',
      'timeZone',
      'status',
      'source',
      'version',
      'createdAt',
      'updatedAt',
    ]
    for (const [index, field] of requiredFields.entries()) {
      await expect(insertAppointment({ id: `apt_required_${index}`, [field]: null }))
        .rejects.toThrow()
    }
  })

  it('guards every appointment collision, immutable field, version branch, and delete', async () => {
    await insertAppointment()
    await expect(insertAppointment()).rejects.toThrow(/identity_collision/)

    const immutableUpdates = [
      "id='apt_ledger_renamed'",
      "client_id='cl_ledger_two'",
      "source='import'",
      `created_at='${updated}'`,
    ]
    for (const update of immutableUpdates) {
      await expect(run(
        `UPDATE appointments SET ${update},version=2,updated_at=? WHERE id='apt_ledger_one'`,
        updated,
      )).rejects.toThrow(/immutable_appointment_identity/)
    }

    const invalidVersionUpdates = [
      "status='scheduled'",
      "status='scheduled',version=3",
      "status='scheduled',version=1.5",
    ]
    for (const update of invalidVersionUpdates) {
      await expect(run(
        `UPDATE appointments SET ${update},updated_at=? WHERE id='apt_ledger_one'`,
        updated,
      )).rejects.toThrow(/invalid_version_increment/)
    }

    await run(
      `UPDATE appointments
       SET specialist_id='sp_ledger_two',location='Gabinet 2',status='scheduled',
           version=2,updated_at=?
       WHERE id='apt_ledger_one'`,
      updated,
    )
    expect(await one(
      "SELECT specialist_id,location,status,version FROM appointments WHERE id='apt_ledger_one'"
    )).toEqual({
      location: 'Gabinet 2',
      specialist_id: 'sp_ledger_two',
      status: 'scheduled',
      version: 2,
    })
    await expect(run("DELETE FROM appointments WHERE id='apt_ledger_one'"))
      .rejects.toThrow(/no_routine_delete/)
  })

  it('accepts each matching charge service and both money boundaries', async () => {
    for (const [index, serviceId] of serviceIds.entries()) {
      const appointmentId = `apt_charge_service_${index}`
      await insertAppointment({ id: appointmentId, serviceId })
      await insertCharge({
        appointmentId,
        expectedAmountGrosze: index === 0 ? 1 : 1000000,
        id: `chg_service_${index}`,
        serviceId,
      })
    }
  })

  it('rejects every invalid charge parent, service, money, currency, time, and version branch', async () => {
    await insertAppointment({ id: 'apt_charge_constraints' })
    const invalidCases = [
      { id: 'chg_charge_missing', overrides: { appointmentId: 'apt_missing' } },
      { id: 'chg_charge_service', overrides: { serviceId: 'plan' } },
      { id: 'chg_charge_unknown_service', overrides: { serviceId: 'unknown-service' } },
      { id: 'chg_charge_zero', overrides: { expectedAmountGrosze: 0 } },
      { id: 'chg_charge_max', overrides: { expectedAmountGrosze: 1000001 } },
      { id: 'chg_charge_float', overrides: { expectedAmountGrosze: 1.5 } },
      { id: 'chg_charge_currency', overrides: { currency: 'EUR' } },
      { id: 'chg_charge_version_zero', overrides: { version: 0 } },
      { id: 'chg_charge_version_float', overrides: { version: 1.5 } },
      { id: 'chg_charge_created', overrides: { createdAt: '2026-08-04T08:00:00Z' } },
      { id: 'chg_charge_updated', overrides: { updatedAt: '2026-08-04T08:00:00Z' } },
    ]
    for (const { id, overrides } of invalidCases) {
      await expect(insertCharge({
        appointmentId: 'apt_charge_constraints',
        id,
        ...overrides,
      })).rejects.toThrow()
    }

    const requiredFields = [
      'appointmentId',
      'serviceId',
      'expectedAmountGrosze',
      'currency',
      'version',
      'createdAt',
      'updatedAt',
    ]
    for (const [index, field] of requiredFields.entries()) {
      await expect(insertCharge({
        appointmentId: 'apt_charge_constraints',
        id: `chg_charge_required_${index}`,
        [field]: null,
      })).rejects.toThrow()
    }
  })

  it('guards both charge collision identities and every immutable/version/delete branch', async () => {
    await insertAppointment({ id: 'apt_charge_one' })
    await insertAppointment({ id: 'apt_charge_two' })
    await insertCharge({ id: 'chg_charge_one', appointmentId: 'apt_charge_one' })

    await expect(insertCharge({ id: 'chg_charge_one', appointmentId: 'apt_charge_two' }))
      .rejects.toThrow(/identity_collision/)
    await expect(insertCharge({ id: 'chg_charge_duplicate', appointmentId: 'apt_charge_one' }))
      .rejects.toThrow(/identity_collision/)

    await expect(run(
      "UPDATE session_charges SET service_id='plan',version=2,updated_at=? WHERE id='chg_charge_one'",
      updated,
    )).rejects.toThrow(/charge_service_mismatch/)

    const immutableUpdates = [
      "id='chg_charge_renamed'",
      "appointment_id='apt_charge_two'",
      "currency='EUR'",
      `created_at='${updated}'`,
    ]
    for (const update of immutableUpdates) {
      await expect(run(
        `UPDATE session_charges SET ${update},version=2,updated_at=? WHERE id='chg_charge_one'`,
        updated,
      )).rejects.toThrow(/immutable_charge_identity/)
    }

    const invalidVersionUpdates = [
      'expected_amount_grosze=19000',
      'expected_amount_grosze=19000,version=3',
      'expected_amount_grosze=19000,version=1.5',
    ]
    for (const update of invalidVersionUpdates) {
      await expect(run(
        `UPDATE session_charges SET ${update},updated_at=? WHERE id='chg_charge_one'`,
        updated,
      )).rejects.toThrow(/invalid_version_increment/)
    }
    await expect(run(
      `UPDATE session_charges
       SET expected_amount_grosze=19000,version=2,updated_at='2026-08-04T09:00:00Z'
       WHERE id='chg_charge_one'`
    )).rejects.toThrow()

    await run(
      "UPDATE appointments SET service_id='plan',version=2,updated_at=? WHERE id='apt_charge_one'",
      updated,
    )
    await run(
      `UPDATE session_charges
       SET service_id='plan',expected_amount_grosze=19000,version=2,updated_at=?
       WHERE id='chg_charge_one'`,
      updated,
    )
    expect(await one(
      "SELECT service_id,expected_amount_grosze,version FROM session_charges WHERE id='chg_charge_one'"
    )).toEqual({ expected_amount_grosze: 19000, service_id: 'plan', version: 2 })
    await expect(run("DELETE FROM session_charges WHERE id='chg_charge_one'"))
      .rejects.toThrow(/no_routine_delete/)
  })

  it('accepts every payment method, both money boundaries, and nullable/text external references', async () => {
    await insertAppointment({ id: 'apt_payment_valid', status: 'scheduled' })
    const methods = ['card', 'cash', 'monthly', 'transfer']
    for (const [index, method] of methods.entries()) {
      await insertPayment({
        amountGrosze: index === 0 ? 1 : 1000000,
        appointmentId: 'apt_payment_valid',
        externalReferenceEnvelope: index === 0 ? null : '{"fictional":"reference"}',
        id: `pay_method_${index}`,
        method,
      })
    }
    expect(await all(
      `SELECT id,typeof(amount_grosze) AS amount_type,
              typeof(external_reference_envelope) AS external_type
       FROM payment_entries WHERE id LIKE 'pay_method_%' ORDER BY id`
    )).toEqual([
      { amount_type: 'integer', external_type: 'null', id: 'pay_method_0' },
      { amount_type: 'integer', external_type: 'text', id: 'pay_method_1' },
      { amount_type: 'integer', external_type: 'text', id: 'pay_method_2' },
      { amount_type: 'integer', external_type: 'text', id: 'pay_method_3' },
    ])
  })

  it('rejects every invalid payment parent, money, method, time, and required-field branch', async () => {
    await insertAppointment({ id: 'apt_payment_constraints' })
    const invalidCases = [
      { id: 'pay_payment_missing', overrides: { appointmentId: 'apt_missing' } },
      { id: 'pay_payment_zero', overrides: { amountGrosze: 0 } },
      { id: 'pay_payment_max', overrides: { amountGrosze: 1000001 } },
      { id: 'pay_payment_float', overrides: { amountGrosze: 1.5 } },
      { id: 'pay_payment_method', overrides: { method: 'blik' } },
      { id: 'pay_payment_received', overrides: { receivedAt: '2026-08-04T08:00:00Z' } },
      { id: 'pay_payment_created', overrides: { createdAt: '2026-08-04T08:00:00Z' } },
      { id: 'pay_payment_staff', overrides: { recordedByStaffId: 'stf_missing' } },
    ]
    for (const { id, overrides } of invalidCases) {
      await expect(insertPayment({
        appointmentId: 'apt_payment_constraints',
        id,
        ...overrides,
      })).rejects.toThrow()
    }

    const requiredFields = [
      'appointmentId',
      'amountGrosze',
      'method',
      'receivedAt',
      'recordedByStaffId',
      'createdAt',
    ]
    for (const [index, field] of requiredFields.entries()) {
      await expect(insertPayment({
        appointmentId: 'apt_payment_constraints',
        id: `pay_required_${index}`,
        [field]: null,
      })).rejects.toThrow()
    }
  })

  it('guards payment identity collisions and both append-only branches', async () => {
    await insertAppointment({ id: 'apt_payment_one' })
    await insertPayment({ id: 'pay_payment_one', appointmentId: 'apt_payment_one' })
    await expect(insertPayment({ id: 'pay_payment_one', appointmentId: 'apt_payment_one' }))
      .rejects.toThrow(/identity_collision/)
    await expect(run(
      "UPDATE payment_entries SET amount_grosze=1 WHERE id='pay_payment_one'"
    )).rejects.toThrow(/append_only/)
    await expect(run("DELETE FROM payment_entries WHERE id='pay_payment_one'"))
      .rejects.toThrow(/append_only/)
  })

  it('accepts corrections with null or same-appointment replacement and text reasons', async () => {
    await insertAppointment({ id: 'apt_correction_valid' })
    await insertPayment({ id: 'pay_correction_null', appointmentId: 'apt_correction_valid' })
    await insertPayment({ id: 'pay_correction_reversed', appointmentId: 'apt_correction_valid' })
    await insertPayment({ id: 'pay_correction_replacement', appointmentId: 'apt_correction_valid' })
    await insertCorrection({
      id: 'cor_correction_null',
      reasonEnvelope: '{"fictional":"reason one"}',
      reversedEntryId: 'pay_correction_null',
    })
    await insertCorrection({
      id: 'cor_correction_replacement',
      reasonEnvelope: '{"fictional":"reason two"}',
      replacementEntryId: 'pay_correction_replacement',
      reversedEntryId: 'pay_correction_reversed',
    })

    expect(await all(
      `SELECT id,replacement_entry_id,typeof(reason_envelope) AS reason_type
       FROM payment_corrections WHERE id LIKE 'cor_correction_%' ORDER BY id`
    )).toEqual([
      { id: 'cor_correction_null', reason_type: 'text', replacement_entry_id: null },
      {
        id: 'cor_correction_replacement',
        reason_type: 'text',
        replacement_entry_id: 'pay_correction_replacement',
      },
    ])
  })

  it('rejects every invalid correction parent, required field, and canonical time branch', async () => {
    await insertAppointment({ id: 'apt_correction_constraints' })
    await insertPayment({
      id: 'pay_correction_constraints',
      appointmentId: 'apt_correction_constraints',
    })
    const invalidCases = [
      { id: 'cor_missing_reversed', overrides: { reversedEntryId: 'pay_missing' } },
      {
        id: 'cor_missing_replacement',
        overrides: { replacementEntryId: 'pay_missing' },
      },
      { id: 'cor_missing_staff', overrides: { recordedByStaffId: 'stf_missing' } },
      { id: 'cor_null_reason', overrides: { reasonEnvelope: null } },
      { id: 'cor_bad_created', overrides: { createdAt: '2026-08-04T09:00:00Z' } },
    ]
    for (const { id, overrides } of invalidCases) {
      await expect(insertCorrection({
        id,
        reversedEntryId: 'pay_correction_constraints',
        ...overrides,
      })).rejects.toThrow()
    }

    const requiredFields = [
      'reversedEntryId',
      'reasonEnvelope',
      'recordedByStaffId',
      'createdAt',
    ]
    for (const [index, field] of requiredFields.entries()) {
      await expect(insertCorrection({
        id: `cor_required_${index}`,
        reversedEntryId: 'pay_correction_constraints',
        [field]: null,
      })).rejects.toThrow()
    }
  })

  it('guards distinct, same-appointment, unreversed, one-reversal, and unique-replacement relationships', async () => {
    await insertAppointment({ id: 'apt_correct_one' })
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      await insertPayment({ id: `pay_correct_${id}`, appointmentId: 'apt_correct_one' })
    }
    await insertAppointment({ id: 'apt_correct_other' })
    await insertPayment({ id: 'pay_correct_other', appointmentId: 'apt_correct_other' })

    await expect(insertCorrection({
      id: 'cor_self_replacement',
      replacementEntryId: 'pay_correct_a',
      reversedEntryId: 'pay_correct_a',
    })).rejects.toThrow(/invalid_payment_correction/)
    await expect(insertCorrection({
      id: 'cor_cross_appointment',
      replacementEntryId: 'pay_correct_other',
      reversedEntryId: 'pay_correct_a',
    })).rejects.toThrow(/invalid_payment_correction/)

    await insertCorrection({ id: 'cor_reverse_b', reversedEntryId: 'pay_correct_b' })
    await expect(insertCorrection({
      id: 'cor_reversed_replacement',
      replacementEntryId: 'pay_correct_b',
      reversedEntryId: 'pay_correct_a',
    })).rejects.toThrow(/invalid_payment_correction/)
    await expect(insertCorrection({
      id: 'cor_duplicate_reversal',
      reversedEntryId: 'pay_correct_b',
    })).rejects.toThrow(/identity_collision/)

    await insertCorrection({
      id: 'cor_replacement_owner',
      replacementEntryId: 'pay_correct_e',
      reversedEntryId: 'pay_correct_d',
    })
    await expect(insertCorrection({
      id: 'cor_duplicate_replacement',
      replacementEntryId: 'pay_correct_e',
      reversedEntryId: 'pay_correct_f',
    })).rejects.toThrow(/identity_collision/)

    await insertCorrection({ id: 'cor_identity_owner', reversedEntryId: 'pay_correct_g' })
    await expect(insertCorrection({
      id: 'cor_identity_owner',
      reversedEntryId: 'pay_correct_h',
    })).rejects.toThrow(/identity_collision/)
  })

  it('guards both append-only correction branches', async () => {
    await insertAppointment({ id: 'apt_correct_append' })
    await insertPayment({ id: 'pay_correct_append', appointmentId: 'apt_correct_append' })
    await insertCorrection({
      id: 'cor_correct_append',
      reversedEntryId: 'pay_correct_append',
    })
    await expect(run(
      "UPDATE payment_corrections SET reason_envelope='changed' WHERE id='cor_correct_append'"
    )).rejects.toThrow(/append_only/)
    await expect(run("DELETE FROM payment_corrections WHERE id='cor_correct_append'"))
      .rejects.toThrow(/append_only/)
  })

  it('honors legal correction chronology and atomically rejects illegal multi-row VALUES ordering', async () => {
    await insertAppointment({ id: 'apt_values_order' })
    await run(
      `INSERT INTO payment_entries
       (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,
        external_reference_envelope,created_at)
       VALUES
         ('pay_values_a','apt_values_order',100,'cash',?,'stf_ledger_one',NULL,?),
         ('pay_values_b','apt_values_order',100,'card',?,'stf_ledger_one',NULL,?),
         ('pay_values_c','apt_values_order',100,'transfer',?,'stf_ledger_one',NULL,?),
         ('pay_values_d','apt_values_order',100,'monthly',?,'stf_ledger_one',NULL,?),
         ('pay_values_e','apt_values_order',100,'cash',?,'stf_ledger_one',NULL,?),
         ('pay_values_f','apt_values_order',100,'card',?,'stf_ledger_one',NULL,?)`,
      now, now,
      now, now,
      now, now,
      now, now,
      now, now,
      now, now,
    )

    await run(
      `INSERT INTO payment_corrections
       (id,reversed_entry_id,replacement_entry_id,reason_envelope,recorded_by_staff_id,created_at)
       VALUES
         ('cor_values_legal_a','pay_values_a','pay_values_b','{}','stf_ledger_one',?),
         ('cor_values_legal_b','pay_values_b','pay_values_c','{}','stf_ledger_one',?)`,
      updated,
      muchLater,
    )
    expect(await one(
      "SELECT count(*) AS count FROM payment_corrections WHERE id LIKE 'cor_values_legal_%'"
    )).toEqual({ count: 2 })

    await expect(run(
      `INSERT INTO payment_corrections
       (id,reversed_entry_id,replacement_entry_id,reason_envelope,recorded_by_staff_id,created_at)
       VALUES
         ('cor_values_illegal_first','pay_values_e','pay_values_f','{}','stf_ledger_one',?),
         ('cor_values_illegal_second','pay_values_d','pay_values_e','{}','stf_ledger_one',?)`,
      updated,
      muchLater,
    )).rejects.toThrow(/invalid_payment_correction/)
    expect(await one(
      "SELECT count(*) AS count FROM payment_corrections WHERE id LIKE 'cor_values_illegal_%'"
    )).toEqual({ count: 0 })

    await insertAppointment({ id: 'apt_values_charge' })
    await expect(run(
      `INSERT INTO session_charges
       (id,appointment_id,service_id,expected_amount_grosze,currency,version,created_at,updated_at)
       VALUES
         ('chg_values_first','apt_values_charge','zajecia',18000,'PLN',1,?,?),
         ('chg_values_second','apt_values_charge','zajecia',18000,'PLN',1,?,?)`,
      now, now,
      now, now,
    )).rejects.toThrow(/identity_collision/)
    expect(await one(
      "SELECT count(*) AS count FROM session_charges WHERE id LIKE 'chg_values_%'"
    )).toEqual({ count: 0 })
  })

  it('returns only fixed trigger errors without bound fictional identity or plaintext', async () => {
    const marker = 'fictional_private_marker'
    const appointmentId = `apt_${marker}`
    await insertAppointment({ id: appointmentId, location: marker })
    await insertAppointment({ id: `apt_${marker}_charge` })
    await insertCharge({
      appointmentId: `apt_${marker}_charge`,
      id: `chg_${marker}`,
    })
    await insertPayment({
      appointmentId,
      id: `pay_${marker}`,
    })
    await insertPayment({
      appointmentId,
      id: `pay_${marker}_replacement`,
    })
    await insertCorrection({
      id: `cor_${marker}`,
      reasonEnvelope: marker,
      reversedEntryId: `pay_${marker}`,
    })

    const cases = [
      {
        expected: 'identity_collision',
        operation: () => insertAppointment({ id: appointmentId, location: marker }),
      },
      {
        expected: 'immutable_appointment_identity',
        operation: () => run(
          'UPDATE appointments SET client_id=?,version=2,updated_at=? WHERE id=?',
          'cl_ledger_two', updated, appointmentId,
        ),
      },
      {
        expected: 'invalid_version_increment',
        operation: () => run(
          'UPDATE appointments SET location=? WHERE id=?',
          'other fictional location', appointmentId,
        ),
      },
      {
        expected: 'no_routine_delete',
        operation: () => run('DELETE FROM appointments WHERE id=?', appointmentId),
      },
      {
        expected: 'charge_service_mismatch',
        operation: () => insertCharge({
          appointmentId,
          id: `chg_${marker}_mismatch`,
          serviceId: 'plan',
        }),
      },
      {
        expected: 'immutable_charge_identity',
        operation: () => run(
          'UPDATE session_charges SET id=?,version=2,updated_at=? WHERE id=?',
          `chg_${marker}_renamed`, updated, `chg_${marker}`,
        ),
      },
      {
        expected: 'append_only',
        operation: () => run(
          'UPDATE payment_entries SET external_reference_envelope=? WHERE id=?',
          marker, `pay_${marker}`,
        ),
      },
      {
        expected: 'invalid_payment_correction',
        operation: () => insertCorrection({
          id: `cor_${marker}_invalid`,
          reasonEnvelope: marker,
          replacementEntryId: `pay_${marker}_replacement`,
          reversedEntryId: `pay_${marker}_replacement`,
        }),
      },
    ]
    for (const { expected, operation } of cases) {
      const message = await caughtError(operation)
      expect(message).toContain(expected)
      expect(message).not.toContain(marker)
      expect(message).not.toContain('other fictional location')
    }
  })

  it('rolls back every preceding statement when a later correction invalidates a D1 batch', async () => {
    await insertAppointment({ id: 'apt_rollback_one' })
    await insertCharge({ id: 'chg_rollback_one', appointmentId: 'apt_rollback_one' })
    await insertPayment({ id: 'pay_rollback_one', appointmentId: 'apt_rollback_one' })
    await insertAppointment({ id: 'apt_rollback_other' })
    await expect(env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payment_entries
         (id,appointment_id,amount_grosze,method,received_at,recorded_by_staff_id,created_at)
         VALUES ('pay_rollback','apt_rollback_other',1,'cash',?,'stf_ledger_one',?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO payment_corrections
         (id,reversed_entry_id,replacement_entry_id,reason_envelope,recorded_by_staff_id,created_at)
         VALUES ('cor_rollback','pay_rollback_one','pay_rollback','{}','stf_ledger_one',?)`
      ).bind(updated),
    ])).rejects.toThrow(/invalid_payment_correction/)
    expect(await one(
      "SELECT count(*) AS count FROM payment_entries WHERE id='pay_rollback'"
    )).toEqual({ count: 0 })
    expect(await one(
      "SELECT count(*) AS count FROM payment_corrections WHERE id='cor_rollback'"
    )).toEqual({ count: 0 })
    expect(await one(
      "SELECT count(*) AS count FROM payment_entries WHERE id='pay_rollback_one'"
    )).toEqual({ count: 1 })

    try {
      await insertCorrection({
        id: 'cor_secret_identity',
        reversedEntryId: 'pay_rollback_one',
        replacementEntryId: 'pay_secret_identity',
      })
      throw new Error('expected correction failure')
    } catch (error) {
      expect(String(error)).not.toContain('secret_identity')
    }
  })
})
