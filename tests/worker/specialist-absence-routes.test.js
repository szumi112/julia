import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyAuthenticationStageF,
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { createWrappedDataKey } from '../../worker/security/envelope.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import {
  cancelSpecialistAbsence,
  createSpecialistAbsence,
  listSpecialistAbsences,
} from '../../worker/core/specialist-absences.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2026-09-13T10:00:00.000Z')
const CORRELATION_ID = '00000000-0000-4000-8000-000000000091'
const owner = authorityActor({ id: 'stf_abs_owner', role: 'owner' })
const coordinator = authorityActor({ id: 'stf_abs_coord', role: 'coordinator' })
const specialist = authorityActor({ id: 'stf_abs_spec', role: 'specialist', specialistId: 'sp_abs_spec' })
const otherSpecialist = 'sp_abs_other'
const secret = (value) => encodeBase64Url(new Uint8Array(32).fill(value))
const ring = () => createKeyring({
  BWM_DATA_KEK_V1: secret(1), BWM_LOOKUP_HMAC_V1: secret(2), BWM_BACKUP_KEK_V1: secret(3),
  BWM_WORKBOOK_KEK_V1: secret(4), BWM_WORKBOOK_HMAC_V1: secret(5),
}, {
  activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
  activeWorkbookKekVersion: 1, activeWorkbookHmacVersion: 1,
})
const identityRow = (id, email, role, specialistId = null) => {
  const now = new Date(NOW_MS).toISOString()
  return env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, email, '{}', '{}', role, 'active', `access-${id}`, specialistId, 1, now, null, now, now,
  )
}
const specialistRow = (id, staffId) => env.DB.prepare(`INSERT INTO specialists
  (id,staff_user_id,display_name_envelope,professional_title_envelope,standard_rate_grosze,
   status,version,archived_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
    id, staffId, '{}', '{}', 19_500, 'active', 1, null,
    new Date(NOW_MS).toISOString(), new Date(NOW_MS).toISOString(),
  )

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await applyAuthenticationStageF()
  const keyring = await ring()
  const dataKey = await createWrappedDataKey(keyring, {
    scope: { type: 'staff_directory', id: 'centre_1', purpose: 'identity' },
    id: 'key_absence_identity', createdAt: new Date(NOW_MS).toISOString(),
  })
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO data_keys
      (id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,
       kek_version,created_at,retired_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      dataKey.id, dataKey.scope_type, dataKey.scope_id, dataKey.purpose,
      dataKey.dek_version, dataKey.wrapped_key_b64, dataKey.wrap_nonce_b64,
      dataKey.kek_version, dataKey.created_at, dataKey.retired_at,
    ),
    identityRow(owner.id, 'abs-owner', 'owner'),
    identityRow(coordinator.id, 'abs-coord', 'coordinator'),
    identityRow(specialist.id, 'abs-spec', 'specialist', specialist.specialistId),
    specialistRow(specialist.specialistId, specialist.id),
    specialistRow(otherSpecialist, null),
  ])
})

const command = async (actor, body, idempotencyKey, idFactory) => createSpecialistAbsence({
  db: env.DB, recoveryDb: env.DB, actor, keyring: await ring(), nowMs: NOW_MS,
  correlationId: CORRELATION_ID, idFactory, body, idempotencyKey,
})

describe('specialist absence commands', () => {
  it('creates and lists a whole-day range with centre and own-specialist scope', async () => {
    const result = await command(owner, {
      specialistId: otherSpecialist, dateFrom: '2026-09-14', dateTo: '2026-09-16', allDay: true,
    }, 'absence-create-owner-01', () => 'owner-create-01')
    expect(result.status).toBe(201)
    expect(result.body.data.absence).toMatchObject({
      specialistId: otherSpecialist, dateFrom: '2026-09-14', dateTo: '2026-09-16',
      allDay: true, version: 1, cancelledAt: null,
    })
    const overlap = await command(owner, {
      specialistId: otherSpecialist, dateFrom: '2026-09-15', dateTo: '2026-09-17', allDay: true,
    }, 'absence-create-owner-overlap', () => 'owner-create-overlap')
    await expect(listSpecialistAbsences({
      db: env.DB, actor: coordinator, keyring: await ring(), nowMs: NOW_MS,
      url: 'https://panel.test/api/v1/specialist-absences?from=2026-09-13&to=2026-09-17',
    })).resolves.toMatchObject({ data: { absences: [
      { id: result.body.data.absence.id, specialistId: otherSpecialist },
      { id: overlap.body.data.absence.id, specialistId: otherSpecialist },
    ] } })
    await expect(env.DB.prepare(
      'UPDATE specialist_absences SET date_from=? WHERE id=?',
    ).bind('2026-09-01', result.body.data.absence.id).run()).rejects.toThrow(/immutable/)
    await expect(listSpecialistAbsences({
      db: env.DB, actor: specialist, keyring: await ring(), nowMs: NOW_MS,
      url: 'https://panel.test/api/v1/specialist-absences?from=2026-09-13&to=2026-09-17',
    })).resolves.toMatchObject({ data: { absences: [] } })
  })

  it('lets a specialist manage only their own absence and soft-cancels with a version', async () => {
    const created = await command(specialist, {
      specialistId: specialist.specialistId, dateFrom: '2026-09-20', dateTo: '2026-09-20', allDay: true,
    }, 'absence-create-specialist-01', () => 'specialist-create-01')
    await expect(command(specialist, {
      specialistId: otherSpecialist, dateFrom: '2026-09-21', dateTo: '2026-09-21', allDay: true,
    }, 'absence-create-specialist-02', () => 'specialist-create-02')).rejects.toThrow('FORBIDDEN')
    const cancelled = await cancelSpecialistAbsence({
      db: env.DB, recoveryDb: env.DB, actor: specialist, keyring: await ring(), nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: () => 'specialist-cancel-01',
      absenceId: created.body.data.absence.id, body: { expectedVersion: 1 },
      idempotencyKey: 'absence-cancel-specialist-01',
    })
    expect(cancelled.body.data.absence).toMatchObject({ version: 2, cancelledAt: new Date(NOW_MS).toISOString() })
    await expect(command(specialist, {
      specialistId: specialist.specialistId, dateFrom: '2026-09-22', dateTo: '2026-09-22', allDay: false,
    }, 'absence-invalid-all-day', () => 'invalid')).rejects.toThrow('VALIDATION_FAILED/allDay')
  })
})
