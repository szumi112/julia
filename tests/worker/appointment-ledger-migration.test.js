import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyCoreDirectoryStageB,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const now = '2026-08-04T08:00:00.000Z'
const later = '2026-08-04T08:50:00.000Z'
const updated = '2026-08-04T09:00:00.000Z'

const run = (sql, ...values) => env.DB.prepare(sql).bind(...values).run()
const one = (sql, ...values) => env.DB.prepare(sql).bind(...values).first()

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
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
        specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       VALUES ('stf_ledger_one','stf_ledger_one_lookup','{}','{}','coordinator','active',
               'stf_ledger_one_subject','sp_ledger_one',1,?,NULL,?,?)`
    ).bind(now, now, now),
  ])
  await run(
    `INSERT INTO clients
     (id,identity_envelope,status,created_at,updated_at)
     VALUES ('cl_ledger_one','{}','active',?,?)`,
    now,
    now,
  )
}

describe('appointment ledger migration', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA()
    await applyCoreDirectoryStageB()
    await seedParents()
  })

  it('applies 0010 then 0011 and creates the exact ledger shape, indexes, and restrictive FKs', async () => {
    expect((await env.DB.prepare(
      "SELECT name FROM d1_migrations WHERE name>='0010' ORDER BY id"
    ).all()).results).toEqual([
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
      expect((await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results
        .map(({ name }) => name)).toEqual(columns)
      const schema = (await one(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",
        table,
      )).sql
      expect(schema).not.toMatch(/CASCADE/i)
    }

    const indexes = (await env.DB.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type='index' AND name IN (
         'appointments_specialist_starts_id_idx',
         'appointments_client_starts_id_idx'
       ) ORDER BY name`
    ).all()).results.map(({ name }) => name)
    expect(indexes).toEqual([
      'appointments_client_starts_id_idx',
      'appointments_specialist_starts_id_idx',
    ])
    expect((await env.DB.prepare(
      'PRAGMA index_info(appointments_specialist_starts_id_idx)'
    ).all()).results.map(({ name }) => name)).toEqual(['specialist_id', 'starts_at', 'id'])
    expect((await env.DB.prepare(
      'PRAGMA index_info(appointments_client_starts_id_idx)'
    ).all()).results.map(({ name }) => name)).toEqual(['client_id', 'starts_at', 'id'])

    for (const table of Object.keys(expectedColumns)) {
      const foreignKeys = (await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all()).results
      for (const foreignKey of foreignKeys) {
        expect(foreignKey.on_update).toBe('RESTRICT')
        expect(foreignKey.on_delete).toBe('RESTRICT')
      }
    }
  })

  it('enforces appointment identifiers, values, canonical instants, mutability, and deletion guards', async () => {
    await expect(insertAppointment({ id: 'bad_appointment' })).rejects.toThrow()
    await expect(insertAppointment({ id: 'apt_a\0!' })).rejects.toThrow()
    await expect(insertAppointment({ clientId: 'cl_missing' })).rejects.toThrow()
    await expect(insertAppointment({ endsAt: now })).rejects.toThrow()
    await expect(insertAppointment({ startsAt: '2026-08-04T08:00:00Z' })).rejects.toThrow()
    await expect(insertAppointment({ timeZone: 'UTC' })).rejects.toThrow()
    await expect(insertAppointment({ location: ' ' })).rejects.toThrow()
    await expect(insertAppointment({ location: 'x'.repeat(81) })).rejects.toThrow()
    await expect(insertAppointment({ status: 'paid' })).rejects.toThrow()
    await expect(insertAppointment({ source: 'import' })).rejects.toThrow()
    await expect(insertAppointment({ version: 1.5 })).rejects.toThrow()
    await expect(insertAppointment({ status: 'cancelled' })).rejects.toThrow()
    await expect(insertAppointment({ cancelledAt: now })).rejects.toThrow()

    await insertAppointment()
    await expect(run(
      "UPDATE appointments SET client_id='cl_missing',version=2,updated_at=? WHERE id='apt_ledger_one'",
      updated,
    )).rejects.toThrow(/immutable_appointment_identity/)
    await expect(run(
      "UPDATE appointments SET status='scheduled',updated_at=? WHERE id='apt_ledger_one'",
      updated,
    )).rejects.toThrow(/invalid_version_increment/)
    await run(
      "UPDATE appointments SET status='scheduled',version=2,updated_at=? WHERE id='apt_ledger_one'",
      updated,
    )
    await expect(run("DELETE FROM appointments WHERE id='apt_ledger_one'"))
      .rejects.toThrow(/no_routine_delete/)
  })

  it('enforces one matching mutable charge per appointment with exact money and version rules', async () => {
    await insertAppointment({ id: 'apt_charge_one' })
    await expect(insertCharge({ id: 'charge_bad', appointmentId: 'apt_charge_one' })).rejects.toThrow()
    await expect(insertCharge({ id: 'chg_charge_missing', appointmentId: 'apt_missing' })).rejects.toThrow()
    await expect(insertCharge({ id: 'chg_charge_service', appointmentId: 'apt_charge_one', serviceId: 'plan' })).rejects.toThrow(/charge_service_mismatch/)
    await expect(insertCharge({ id: 'chg_charge_zero', appointmentId: 'apt_charge_one', expectedAmountGrosze: 0 })).rejects.toThrow()
    await expect(insertCharge({ id: 'chg_charge_max', appointmentId: 'apt_charge_one', expectedAmountGrosze: 1000001 })).rejects.toThrow()
    await expect(insertCharge({ id: 'chg_charge_float', appointmentId: 'apt_charge_one', expectedAmountGrosze: 1.5 })).rejects.toThrow()
    await expect(insertCharge({ id: 'chg_charge_currency', appointmentId: 'apt_charge_one', currency: 'EUR' })).rejects.toThrow()
    await expect(insertCharge({ id: 'chg_charge_time', appointmentId: 'apt_charge_one', createdAt: '2026-08-04T08:00:00Z' })).rejects.toThrow()

    await insertCharge({ id: 'chg_charge_one', appointmentId: 'apt_charge_one' })
    await expect(insertCharge({ id: 'chg_charge_duplicate', appointmentId: 'apt_charge_one' }))
      .rejects.toThrow(/identity_collision/)
    await expect(run(
      "UPDATE session_charges SET appointment_id='apt_missing',version=2,updated_at=? WHERE id='chg_charge_one'",
      updated,
    )).rejects.toThrow(/immutable_charge_identity/)
    await expect(run(
      "UPDATE session_charges SET expected_amount_grosze=19000,updated_at=? WHERE id='chg_charge_one'",
      updated,
    )).rejects.toThrow(/invalid_version_increment/)
    await run(
      "UPDATE session_charges SET expected_amount_grosze=19000,version=2,updated_at=? WHERE id='chg_charge_one'",
      updated,
    )
    await expect(run("DELETE FROM session_charges WHERE id='chg_charge_one'"))
      .rejects.toThrow(/no_routine_delete/)
  })

  it('keeps payment entries append-only and validates money, method, time, and parents', async () => {
    await insertAppointment({ id: 'apt_payment_one' })
    await insertCharge({ id: 'chg_payment_one', appointmentId: 'apt_payment_one' })
    await expect(insertPayment({ id: 'payment_bad', appointmentId: 'apt_payment_one' })).rejects.toThrow()
    await expect(insertPayment({ id: 'pay_payment_missing', appointmentId: 'apt_missing' })).rejects.toThrow()
    await expect(insertPayment({ id: 'pay_payment_zero', appointmentId: 'apt_payment_one', amountGrosze: 0 })).rejects.toThrow()
    await expect(insertPayment({ id: 'pay_payment_max', appointmentId: 'apt_payment_one', amountGrosze: 1000001 })).rejects.toThrow()
    await expect(insertPayment({ id: 'pay_payment_float', appointmentId: 'apt_payment_one', amountGrosze: 1.5 })).rejects.toThrow()
    await expect(insertPayment({ id: 'pay_payment_method', appointmentId: 'apt_payment_one', method: 'blik' })).rejects.toThrow()
    await expect(insertPayment({ id: 'pay_payment_time', appointmentId: 'apt_payment_one', receivedAt: '2026-08-04T08:00:00Z' })).rejects.toThrow()
    await expect(insertPayment({ id: 'pay_payment_staff', appointmentId: 'apt_payment_one', recordedByStaffId: 'stf_missing' })).rejects.toThrow()

    await insertPayment({ id: 'pay_payment_one', appointmentId: 'apt_payment_one' })
    await expect(run(
      "UPDATE payment_entries SET amount_grosze=1 WHERE id='pay_payment_one'"
    )).rejects.toThrow(/append_only/)
    await expect(run("DELETE FROM payment_entries WHERE id='pay_payment_one'"))
      .rejects.toThrow(/append_only/)
    await expect(insertPayment({ id: 'pay_payment_one', appointmentId: 'apt_payment_one' }))
      .rejects.toThrow(/identity_collision/)
  })

  it('closes corrections over one same-appointment reversal and unique valid replacements', async () => {
    await insertAppointment({ id: 'apt_correct_one' })
    await insertCharge({ id: 'chg_correct_one', appointmentId: 'apt_correct_one' })
    await insertPayment({ id: 'pay_correct_one', appointmentId: 'apt_correct_one' })
    await insertPayment({ id: 'pay_correct_replacement', appointmentId: 'apt_correct_one', amountGrosze: 8000 })
    await insertCorrection({
      id: 'cor_correct_one',
      reversedEntryId: 'pay_correct_one',
      replacementEntryId: 'pay_correct_replacement',
    })

    await expect(insertCorrection({ id: 'cor_duplicate_reversal', reversedEntryId: 'pay_correct_one' }))
      .rejects.toThrow(/identity_collision/)
    await expect(insertCorrection({
      id: 'cor_self_replacement',
      reversedEntryId: 'pay_correct_replacement',
      replacementEntryId: 'pay_correct_replacement',
    })).rejects.toThrow(/invalid_payment_correction/)
    await expect(insertCorrection({
      id: 'cor_missing_replacement',
      reversedEntryId: 'pay_correct_replacement',
      replacementEntryId: 'pay_missing',
    })).rejects.toThrow()

    await insertAppointment({ id: 'apt_correct_other' })
    await insertPayment({
      id: 'pay_correct_other',
      appointmentId: 'apt_correct_other',
    })
    await expect(insertCorrection({
      id: 'cor_cross_appointment',
      reversedEntryId: 'pay_correct_replacement',
      replacementEntryId: 'pay_correct_other',
    })).rejects.toThrow(/invalid_payment_correction/)
    await expect(insertCorrection({
      id: 'cor_reversed_replacement',
      reversedEntryId: 'pay_correct_replacement',
      replacementEntryId: 'pay_correct_one',
    })).rejects.toThrow(/invalid_payment_correction/)

    await expect(run(
      "UPDATE payment_corrections SET reason_envelope='changed' WHERE id='cor_correct_one'"
    )).rejects.toThrow(/append_only/)
    await expect(run("DELETE FROM payment_corrections WHERE id='cor_correct_one'"))
      .rejects.toThrow(/append_only/)
  })

  it('rolls back an invalid correction batch without leaking dynamic identity in fixed errors', async () => {
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
