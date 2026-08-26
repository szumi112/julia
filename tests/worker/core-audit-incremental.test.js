import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { normalizeBootstrapAuditEvent } from '../../scripts/bootstrap-core.js'
import { createApiClient } from '../../src/api.js'
import { auditEventStatement } from '../../worker/audit/events.js'
import { listSecurityAudit } from '../../worker/routes/operations.js'
import { getOrCreateDataKey } from '../../worker/security/envelope.js'
import { createKeyring } from '../../worker/security/keyring.js'

const NOW_MS = Date.parse('2042-08-04T10:00:00.000Z')
const SCOPE = Object.freeze({ type: 'staff_directory', id: 'centre_1', purpose: 'identity' })
const ACTOR = Object.freeze({ id: 'stf_core_incremental', role: 'owner', specialistId: null, version: 1 })
const FACTS = Object.freeze([
  ['client.created', 'client', 'cl_incremental', { clientVersion: 1, assignmentId: 'asg_incremental', assignmentVersion: 1 }],
  ['client.updated', 'client', 'cl_incremental', { clientVersion: 2 }],
  ['client.assignment.changed', 'client', 'cl_incremental', { clientVersion: 3, closedAssignmentId: 'asg_incremental', closedAssignmentVersion: 2, newAssignmentId: 'asg_incremental_two', newAssignmentVersion: 1 }],
  ['client.archived', 'client', 'cl_incremental', { clientVersion: 4, assignmentId: 'asg_incremental_two', assignmentVersion: 2 }],
  ['appointment.created', 'appointment', 'apt_incremental', { appointmentVersion: 1, chargeVersion: 1 }],
  ['appointment.updated', 'appointment', 'apt_incremental', { appointmentVersion: 2, chargeVersion: 2 }],
  ['appointment.cancelled', 'appointment', 'apt_incremental', { appointmentVersion: 3, chargeVersion: 2 }],
  ['payment.recorded', 'appointment', 'apt_incremental', { appointmentVersion: 4, paymentEntryId: 'pay_incremental' }],
  ['payment.corrected', 'payment_entry', 'pay_incremental', { appointmentVersion: 5, correctionId: 'cor_incremental', reversedEntryId: 'pay_incremental', replacementEntryId: 'pay_incremental_two' }],
  ['finance.import.started', 'finance_import', 'fib_incremental', { batchVersion: 1, rowCount: 2 }],
  ['finance.import.chunk.accepted', 'finance_import', 'fib_incremental', { batchVersion: 2, rowCount: 2 }],
  ['finance.import.committed', 'finance_import', 'fib_incremental', { batchVersion: 3, rowCount: 2 }],
])

const session = {
  data: {
    actor: { id: ACTOR.id, displayName: 'Fikcyjna Właścicielka', role: 'owner', specialistId: null, version: 1 },
    capabilities: [
      'appointment.charge.read', 'appointment.manage', 'centre.manage', 'chat.direct',
      'chat.general', 'client.manage', 'client.operational.read', 'clinical.read',
      'finance.centre.manage', 'finance.centre.read', 'operations.health.read', 'payment.manage',
      'security.audit.read', 'specialist.directory.read', 'staff.manage', 'tus.manage',
    ],
    csrfToken: `v1.2290764000.${'A'.repeat(22)}.${'B'.repeat(43)}`,
    csrfExpiresAt: '2042-08-04T11:20:00.000Z',
    environment: 'staging',
    dataMode: 'fictional',
  },
}

it('keeps the same fictional incremental core rows append-only across all four registries', async () => {
  const now = new Date(NOW_MS).toISOString()
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,created_at,updated_at)
     VALUES (?,?,'{}','{}','owner','active',?,NULL,1,?,?,?)`
  ).bind(ACTOR.id, 'lookup_core_incremental', 'access_core_incremental', now, now, now).run()
  for (const [index, [action, entityType, entityId, metadata]] of FACTS.entries()) {
    await auditEventStatement(env.DB, {
      id: `aud_core_incremental_${index}`,
      occurredAt: new Date(NOW_MS + index).toISOString(),
      actorStaffId: ACTOR.id,
      action,
      entityType,
      entityId,
      result: 'success',
      correlationId: `correlation_core_${index}`,
      metadata,
      reasonEnvelope: null,
    }).run()
  }
  const storedBeforeReads = (await env.DB.prepare(
    `SELECT id,metadata_json FROM audit_events
     WHERE id LIKE 'aud_core_incremental_%' ORDER BY id`
  ).all()).results
  const keyring = await createKeyring(env, {
    activeBackupKekVersion: 1, activeDataKekVersion: 1, activeLookupKeyVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_core_incremental', createdAt: now,
  })
  const worker = await listSecurityAudit({
    db: env.DB,
    cryptoContext: { keyring, dataKey, scope: SCOPE },
    actor: ACTOR,
    nowMs: NOW_MS + FACTS.length,
    correlationId: '11111111-1111-4111-8111-111111111111',
    idFactory: () => 'aud_unused_incremental',
    query: new URLSearchParams(),
  })
  expect(worker.data.events).toHaveLength(FACTS.length)

  const raw = (await env.DB.prepare(
    `SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
            reason_envelope,correlation_id,metadata_json
     FROM audit_events ORDER BY occurred_at DESC,id DESC`
  ).all()).results
  expect(raw.map((row) => normalizeBootstrapAuditEvent(row).metadata))
    .toEqual(worker.data.events.map(({ metadata }) => metadata))

  const responses = [Response.json(session), Response.json(worker)]
  const browser = createApiClient({ fetchImpl: async () => responses.shift() })
  await browser.getSession()
  const browserAudit = await browser.getSecurityAudit()
  expect(browserAudit.events).toEqual(worker.data.events)
  expect((await env.DB.prepare(
    `SELECT id,metadata_json FROM audit_events
     WHERE id LIKE 'aud_core_incremental_%' ORDER BY id`
  ).all()).results).toEqual(storedBeforeReads)
  expect(JSON.stringify({ worker, browserAudit, raw })).not.toMatch(
    /Fikcyjna Właścicielka|kontakt|notatka|powód|lokalizacja|kwota|workbook/i,
  )
})
