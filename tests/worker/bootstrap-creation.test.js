import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import {
  buildBootstrapCreationBatch,
  inspectBootstrapAggregate,
  normalizeBootstrapAuditEvent,
} from '../../scripts/bootstrap-core.js'
import { NOW_MS } from './fixtures.js'
import {
  bootstrapInput,
  bootstrapKeyring,
  executeBootstrapBatch,
} from './bootstrap-helpers.js'

it('creates the complete encrypted pre-reconcile aggregate in one guarded batch', async () => {
  const keyring = await bootstrapKeyring('1')
  const built = await buildBootstrapCreationBatch({
    ...bootstrapInput('1'),
    keyring,
  })
  expect(built.batch.length).toBeGreaterThan(8)
  expect(built.batch.every(({ params }) => params.every(
    (value) => typeof value === 'string',
  ))).toBe(true)
  const results = await executeBootstrapBatch(built.batch)
  expect(results.at(-1)?.results).toEqual([built.proof])
  await expect(inspectBootstrapAggregate({
    db: env.DB,
    keyring,
    nowMs: NOW_MS,
    ownerDisplayName: 'Alicja Testowa 1',
    ownerEmail: 'owner-1@example.test',
  })).resolves.toMatchObject({
    ids: built.ids,
    kind: 'pre-reconcile',
    reconcileState: 'queued-initial',
  })
  const raw = JSON.stringify((await env.DB.prepare(
    `SELECT email_envelope,display_name_envelope,payload_envelope,snapshot_envelope
     FROM staff_users
     JOIN outbox_jobs ON 1=1
     JOIN record_versions ON 1=1`
  ).all()).results)
  expect(raw).not.toContain('owner-1@example.test')
  expect(raw).not.toContain('Alicja Testowa 1')
  expect(await env.DB.prepare(
    "SELECT metadata_json FROM audit_events WHERE action='staff.bootstrap'"
  ).first()).toEqual({
    metadata_json: '{"desiredGeneration":1,"invitationVersion":1,"specialistVersion":null,"staffVersion":1}',
  })
})

const LEGACY_IDENTITY_AUDITS = Object.freeze({
  'identity.activation': Object.freeze({
    entity_type: 'staff_user',
    metadata: { invitationVersion: 2, staffVersion: 2 },
  }),
  'staff.bootstrap': Object.freeze({
    entity_type: 'staff_user',
    metadata: { desiredGeneration: 1, invitationVersion: 1, staffVersion: 1 },
  }),
  'staff.deactivated': Object.freeze({
    entity_type: 'staff_user',
    metadata: { desiredGeneration: 2, staffVersion: 3 },
  }),
  'staff.invitation.expired': Object.freeze({
    entity_type: 'staff_invitation',
    metadata: { desiredGeneration: 3, invitationVersion: 2, staffVersion: 2 },
  }),
  'staff.invited': Object.freeze({
    entity_type: 'staff_invitation',
    metadata: { desiredGeneration: 2, invitationVersion: 1, staffVersion: 1 },
  }),
})

const IDENTITY_AUDIT_CASES = Object.entries(LEGACY_IDENTITY_AUDITS).map(
  ([action, fixture], index) => [
    action,
    fixture,
    index % 2 === 0 ? index + 1 : null,
  ],
)

const withSpecialistVersion = (metadata, specialistVersion) => ({
  ...metadata,
  specialistVersion,
})

const canonicalMetadataJson = (metadata) => JSON.stringify(Object.fromEntries(
  Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)),
))

const auditRow = (
  action,
  entityType,
  metadata,
  actorStaffId = action === 'staff.bootstrap' ? null : 'stf_actor',
) => ({
  id: `aud_${action.replaceAll('.', '_')}`,
  occurred_at: '2026-08-03T10:00:00.000Z',
  actor_staff_id: actorStaffId,
  action,
  entity_type: entityType,
  entity_id: entityType === 'staff_invitation'
    ? 'inv_target'
    : entityType === 'specialist'
      ? 'sp_target'
      : entityType === 'system_state'
        ? 'core_directory_specialist_backfill_v1'
        : 'stf_target',
  result: 'success',
  reason_envelope: null,
  correlation_id: `corr_${action.replaceAll('.', '_')}`,
  metadata_json: canonicalMetadataJson(metadata),
})

it.each(IDENTITY_AUDIT_CASES)(
  'normalizes the exact Phase 1 identity audit shape for %s without mutating it',
  (action, fixture) => {
    const row = auditRow(action, fixture.entity_type, fixture.metadata)
    const before = structuredClone(row)
    expect(normalizeBootstrapAuditEvent(row)).toEqual({
      ...row,
      metadata: { ...fixture.metadata, specialistVersion: null },
    })
    expect(row).toEqual(before)
  },
)

it.each(IDENTITY_AUDIT_CASES)(
  'accepts the exact new identity audit shape for %s',
  (action, fixture, specialistVersion) => {
    const metadata = withSpecialistVersion(fixture.metadata, specialistVersion)
    const row = auditRow(action, fixture.entity_type, metadata)
    const before = structuredClone(row)
    expect(normalizeBootstrapAuditEvent(row)).toEqual({ ...row, metadata })
    expect(row).toEqual(before)
  },
)

it.each(IDENTITY_AUDIT_CASES)(
  'rejects mixed and extra-key identity audit shapes for %s',
  (action, fixture, specialistVersion) => {
    const newMetadata = withSpecialistVersion(
      fixture.metadata,
      specialistVersion,
    )
    const mixed = { ...newMetadata }
    delete mixed[Object.keys(fixture.metadata)[0]]
    const malformed = [
      mixed,
      { ...fixture.metadata, unexpected: 1 },
      { ...newMetadata, unexpected: 1 },
    ]
    for (const metadata of malformed) {
      expect(() => normalizeBootstrapAuditEvent(auditRow(
        action,
        fixture.entity_type,
        metadata,
      ))).toThrowError('BOOTSTRAP_STATE_REFUSED')
    }
  },
)

it('accepts null-actor system audit shapes only', () => {
  const systemRows = [
    auditRow(
      'specialist.backfilled',
      'specialist',
      { specialistVersion: 1, stateVersion: 2 },
      null,
    ),
    auditRow(
      'core_directory.upgrade.advanced',
      'system_state',
      { createdCount: 1, processedCount: 2, stateVersion: 3 },
      null,
    ),
  ]
  for (const row of systemRows) expect(normalizeBootstrapAuditEvent(row)).toBeTruthy()

  expect(() => normalizeBootstrapAuditEvent({
    ...systemRows[0],
    actor_staff_id: 'stf_actor',
  })).toThrowError('BOOTSTRAP_STATE_REFUSED')
})
