import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW = '2042-08-29T10:00:00.000Z'

const run = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).run()
const one = (sql, ...bindings) => env.DB.prepare(sql).bind(...bindings).first()

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await run(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES ('stf_recovery_migration_owner','recovery_migration_owner_lookup','{}','{}',
             'owner','active','recovery-migration-owner-subject',NULL,1,?,NULL,?,?)`,
    NOW,
    NOW,
    NOW,
  )
  await run(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES ('stf_recovery_migration_coordinator','recovery_migration_coordinator_lookup',
             '{}','{}','coordinator','active','recovery-migration-coordinator-subject',
             NULL,1,?,NULL,?,?)`,
    NOW,
    NOW,
    NOW,
  )
})

async function seedRecoveryGraph(suffix, options = {}) {
  const sourceJobId = `job_recovery_source_${suffix}`
  const replacementJobId = `job_recovery_replacement_${suffix}`
  const actionId = `act_recovery_${suffix}`
  const sourceType = options.sourceType ?? 'staff.access.reconcile'
  const sourceAggregateType = options.sourceAggregateType ?? 'access_group'
  const sourceAggregateId = options.sourceAggregateId ?? 'centre_1'
  const replacementType = options.replacementType ?? sourceType
  const replacementAggregateType = options.replacementAggregateType ?? sourceAggregateType
  const replacementAggregateId = options.replacementAggregateId ?? sourceAggregateId
  await run(
    `INSERT INTO outbox_jobs
     (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
      attempt_count,max_attempts,scheduled_at,last_error_code,created_at,updated_at)
     VALUES (?,?,?,?, '{}',?,?,1,?, ?,?,?,?)`,
    sourceJobId,
    sourceType,
    sourceAggregateType,
    sourceAggregateId,
    `staff.access.reconcile:recovery-source:${suffix}`,
    options.sourceStatus ?? 'dead',
    options.sourceMaxAttempts ?? 8,
    NOW,
    options.sourceErrorCode ?? 'OUTBOX_HANDLER_FAILURE',
    NOW,
    NOW,
  )
  if (options.terminalAttempt !== false) {
    await run(
      `INSERT INTO outbox_attempts
       (id,job_id,attempt_number,started_at,completed_at,result,error_code,
        provider_reference)
       VALUES (?,?,1,?,?,'dead',?,?)`,
      `attempt_recovery_source_${suffix}`,
      sourceJobId,
      NOW,
      options.terminalCompletedAt ?? NOW,
      options.terminalAttemptErrorCode
        ?? options.sourceErrorCode
        ?? 'OUTBOX_HANDLER_FAILURE',
      options.terminalProviderReference ?? null,
    )
  }
  await run(
    `INSERT INTO outbox_jobs
     (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
      attempt_count,max_attempts,scheduled_at,created_at,updated_at)
     VALUES (?,?,?,?, '{}',?,?,0,?,?,?,?)`,
    replacementJobId,
    replacementType,
    replacementAggregateType,
    replacementAggregateId,
    `staff.access.reconcile:recovery-replacement:${suffix}`,
    options.replacementStatus ?? 'queued',
    options.replacementMaxAttempts ?? 8,
    NOW,
    NOW,
    NOW,
  )
  await run(
    `INSERT INTO operational_actions
     (id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
      version,created_at,updated_at)
     VALUES (?,?,?,'critical','open','outbox_job',?,'{}',1,?,?)`,
    actionId,
    options.actionFingerprint ?? `outbox.dead:${sourceJobId}`,
    options.actionKind ?? 'outbox_job_failed',
    options.actionEntityId ?? sourceJobId,
    NOW,
    NOW,
  )
  return { actionId, replacementJobId, sourceJobId }
}

describe('outbox recovery lineage migration', () => {
  it('records one non-PII lineage edge between a dead source and queued replacement', async () => {
    const graph = await seedRecoveryGraph('record')

    await run(
      `INSERT INTO outbox_job_recoveries
       (id,source_job_id,replacement_job_id,operational_action_id,
        requested_by_staff_id,correlation_id,created_at)
       VALUES ('rcv_recovery_record',?,?,?,?,?,?)`,
      graph.sourceJobId,
      graph.replacementJobId,
      graph.actionId,
      'stf_recovery_migration_owner',
      'correlation_recovery_record',
      NOW,
    )

    expect(await one(
      `SELECT id,source_job_id,replacement_job_id,operational_action_id,
              requested_by_staff_id,correlation_id,created_at
       FROM outbox_job_recoveries WHERE id='rcv_recovery_record'`,
    )).toEqual({
      id: 'rcv_recovery_record',
      source_job_id: graph.sourceJobId,
      replacement_job_id: graph.replacementJobId,
      operational_action_id: graph.actionId,
      requested_by_staff_id: 'stf_recovery_migration_owner',
      correlation_id: 'correlation_recovery_record',
      created_at: NOW,
    })
  })

  it('keeps every lineage edge append-only', async () => {
    const graph = await seedRecoveryGraph('append_only')
    await run(
      `INSERT INTO outbox_job_recoveries
       (id,source_job_id,replacement_job_id,operational_action_id,
        requested_by_staff_id,correlation_id,created_at)
       VALUES ('rcv_recovery_append_only',?,?,?,?,?,?)`,
      graph.sourceJobId,
      graph.replacementJobId,
      graph.actionId,
      'stf_recovery_migration_owner',
      'correlation_recovery_append_only',
      NOW,
    )

    await expect(run(
      `UPDATE outbox_job_recoveries SET correlation_id='correlation_replaced'
       WHERE id='rcv_recovery_append_only'`,
    )).rejects.toThrow(/append_only/)
    await expect(run(
      "DELETE FROM outbox_job_recoveries WHERE id='rcv_recovery_append_only'",
    )).rejects.toThrow(/no_routine_delete/)
  })

  it('allows each source, replacement, and action in only one lineage edge', async () => {
    const graph = await seedRecoveryGraph('constraints')
    const sourceDuplicate = await seedRecoveryGraph('duplicate_source')
    const replacementDuplicate = await seedRecoveryGraph('duplicate_replacement')
    const actionDuplicate = await seedRecoveryGraph('duplicate_action')
    await run(
      `INSERT INTO outbox_job_recoveries
       (id,source_job_id,replacement_job_id,operational_action_id,
        requested_by_staff_id,correlation_id,created_at)
       VALUES ('rcv_recovery_constraints',?,?,?,?,?,?)`,
      graph.sourceJobId,
      graph.replacementJobId,
      graph.actionId,
      'stf_recovery_migration_owner',
      'correlation_recovery_constraints',
      NOW,
    )

    for (const fixture of [
      [
        'rcv_duplicate_source',
        graph.sourceJobId,
        sourceDuplicate.replacementJobId,
        sourceDuplicate.actionId,
      ],
      [
        'rcv_duplicate_replacement',
        replacementDuplicate.sourceJobId,
        graph.replacementJobId,
        replacementDuplicate.actionId,
      ],
      [
        'rcv_duplicate_action',
        actionDuplicate.sourceJobId,
        actionDuplicate.replacementJobId,
        graph.actionId,
      ],
    ]) {
      await expect(run(
        `INSERT INTO outbox_job_recoveries
         (id,source_job_id,replacement_job_id,operational_action_id,
          requested_by_staff_id,correlation_id,created_at)
         VALUES (?,?,?,?,?,'correlation_recovery_rejected',?)`,
        ...fixture,
        'stf_recovery_migration_owner',
        NOW,
      )).rejects.toThrow()
    }
  })

  it('rejects self-links and missing references independently', async () => {
    const selfLink = await seedRecoveryGraph('self_link')

    await expect(run(
      `INSERT INTO outbox_job_recoveries
       (id,source_job_id,replacement_job_id,operational_action_id,
        requested_by_staff_id,correlation_id,created_at)
       VALUES ('rcv_self_link',?,?,?,?,?,?)`,
      selfLink.sourceJobId,
      selfLink.sourceJobId,
      selfLink.actionId,
      'stf_recovery_migration_owner',
      'correlation_recovery_self_link',
      NOW,
    )).rejects.toThrow()
    await expect(run(
      `INSERT INTO outbox_job_recoveries
       (id,source_job_id,replacement_job_id,operational_action_id,
        requested_by_staff_id,correlation_id,created_at)
       VALUES ('rcv_missing_references','job_missing_source','job_missing_replacement',
               'act_missing','stf_recovery_migration_owner',
               'correlation_recovery_missing',?)`,
      NOW,
    )).rejects.toThrow()
  })

  it.each([
    ['a non-dead source', { sourceStatus: 'succeeded' }, 'stf_recovery_migration_owner'],
    ['a non-recoverable source type', {
      sourceType: 'staff.invitation.expire',
      replacementType: 'staff.invitation.expire',
    }, 'stf_recovery_migration_owner'],
    ['a non-exhausted Access retry', {
      sourceErrorCode: 'OUTBOX_HANDLER_RETRY',
    }, 'stf_recovery_migration_owner'],
    ['a non-exhausted Access lease expiry', {
      sourceErrorCode: 'OUTBOX_LEASE_EXPIRED',
    }, 'stf_recovery_migration_owner'],
    ['a non-pristine replacement', {
      replacementStatus: 'succeeded',
    }, 'stf_recovery_migration_owner'],
    ['a replacement with a noncanonical retry ceiling', {
      replacementMaxAttempts: 1,
    }, 'stf_recovery_migration_owner'],
    ['a replacement with a different type', {
      replacementType: 'staff.invitation.email',
    }, 'stf_recovery_migration_owner'],
    ['a non-matching open action', {
      actionKind: 'backup_failed',
    }, 'stf_recovery_migration_owner'],
    ['a requester who is not an active owner', {}, 'stf_recovery_migration_coordinator'],
    ['missing terminal attempt evidence', {
      terminalAttempt: false,
    }, 'stf_recovery_migration_owner'],
    ['mismatched terminal attempt evidence', {
      terminalAttemptErrorCode: 'OUTBOX_HANDLER_RETRY',
    }, 'stf_recovery_migration_owner'],
    ['a terminal attempt completed outside the source transition', {
      terminalCompletedAt: '2042-08-29T10:00:00.001Z',
    }, 'stf_recovery_migration_owner'],
    ['a noncanonical retry ceiling', {
      sourceMaxAttempts: 1,
    }, 'stf_recovery_migration_owner'],
    ['a terminal attempt with provider reference', {
      terminalProviderReference: 'provider_reference_rejected',
    }, 'stf_recovery_migration_owner'],
  ])('rejects an impossible edge with %s', async (_label, options, requesterId) => {
    const suffix = _label.replaceAll(' ', '_')
    const graph = await seedRecoveryGraph(suffix, options)

    await expect(run(
      `INSERT INTO outbox_job_recoveries
       (id,source_job_id,replacement_job_id,operational_action_id,
        requested_by_staff_id,correlation_id,created_at)
       VALUES (?,?,?,?,?,'correlation_invalid_edge',?)`,
      `rcv_${suffix}`,
      graph.sourceJobId,
      graph.replacementJobId,
      graph.actionId,
      requesterId,
      NOW,
    )).rejects.toThrow(/invalid_recovery_edge/)
  })
})
