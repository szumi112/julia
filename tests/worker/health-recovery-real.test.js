import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { selectCoreMigrationStage } from '../../scripts/core-migration-stages.js'
import { advanceCoreDirectoryUpgrade } from '../../scripts/upgrade-core-directory-core.js'
import { evaluateStoredOperationalState } from '../../worker/operations/health.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { getOrCreateDataKey } from '../../worker/security/envelope.js'

const NOW_MS = Date.parse('2042-08-29T12:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const SOURCE_AT = new Date(NOW_MS - 120_000).toISOString()
const TERMINAL_AT = new Date(NOW_MS - 60_000).toISOString()
const SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})
const DATABASES = Object.freeze({
  success: env.MATERIALIZER_EXACT,
  manual: env.MATERIALIZER_NEAR,
  missingLineage: env.MATERIALIZER_TOKEN,
  missingAudit: env.MATERIALIZER_AMBIGUOUS,
  deadReplacement: env.MATERIALIZER_PRESERVE,
})

const run = (db, sql, ...bindings) => db.prepare(sql).bind(...bindings).run()

async function migrate(db, serial) {
  await applyD1Migrations(
    db,
    selectCoreMigrationStage(env.TEST_STAGE_A_MIGRATIONS, 'stage-a'),
  )
  await advanceCoreDirectoryUpgrade({
    correlationId: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
    cryptoContext: null,
    db,
    idFactory: () => `aud_health_recovery_upgrade_${serial}`,
    nowMs: Date.parse('2040-01-01T00:00:00.000Z'),
  })
  for (const stage of ['stage-b', 'stage-c', 'stage-d', 'stage-e']) {
    await applyD1Migrations(
      db,
      selectCoreMigrationStage(env[`TEST_${stage.replace('-', '_').toUpperCase()}_MIGRATIONS`], stage),
    )
  }
  await run(
    db,
    `UPDATE system_state
     SET value_json=?,version=version+1,updated_at=?
     WHERE key='outbox.drain.last_success'`,
    JSON.stringify({ completedAt: NOW }),
    NOW,
  )
}

async function cryptoContext(db, suffix) {
  const keyring = await createKeyring({
    BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }, { activeDataKekVersion: 1 })
  const dataKey = await getOrCreateDataKey(db, keyring, SCOPE, {
    id: `key_health_recovery_${suffix}`,
    createdAt: '2040-01-01T00:00:00.000Z',
  })
  return { keyring, dataKey, scope: SCOPE }
}

async function seedOwner(db, suffix) {
  const id = `stf_health_recovery_${suffix}`
  await run(
    db,
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,'{}','{}','owner','active',?,NULL,1,?,NULL,?,?)`,
    id,
    `health_recovery_lookup_${suffix}`,
    `health-recovery-subject-${suffix}`,
    SOURCE_AT,
    SOURCE_AT,
    SOURCE_AT,
  )
  return id
}

async function seedSource(db, suffix, ownerId) {
  const sourceJobId = `job_health_recovery_source_${suffix}`
  const actionId = `act_health_recovery_source_${suffix}`
  await run(
    db,
    `INSERT INTO outbox_jobs
     (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
      attempt_count,max_attempts,scheduled_at,last_error_code,created_at,updated_at)
     VALUES (?,'staff.access.reconcile','access_group','centre_1','{}',?,'dead',
             1,8,?,'OUTBOX_HANDLER_FAILURE',?,?)`,
    sourceJobId,
    `staff.access.reconcile:health-recovery:${suffix}:source`,
    SOURCE_AT,
    SOURCE_AT,
    SOURCE_AT,
  )
  await run(
    db,
    `INSERT INTO outbox_attempts
     (id,job_id,attempt_number,started_at,completed_at,result,error_code,
      provider_reference)
     VALUES (?,?,1,?,?,'dead','OUTBOX_HANDLER_FAILURE',NULL)`,
    `attempt_health_recovery_source_${suffix}`,
    sourceJobId,
    SOURCE_AT,
    SOURCE_AT,
  )
  await run(
    db,
    `INSERT INTO operational_actions
     (id,fingerprint,kind,severity,status,entity_type,entity_id,details_envelope,
      version,created_at,updated_at,resolved_at)
     VALUES (?,?,'outbox_job_failed','critical','open','outbox_job',?,'{}',
             1,?,?,NULL)`,
    actionId,
    `outbox.dead:${sourceJobId}`,
    sourceJobId,
    SOURCE_AT,
    SOURCE_AT,
  )
  return { actionId, ownerId, sourceJobId }
}

async function seedQueuedReplacement(db, suffix) {
  const replacementJobId = `job_health_recovery_replacement_${suffix}`
  await run(
    db,
    `INSERT INTO outbox_jobs
     (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,
      attempt_count,max_attempts,scheduled_at,created_at,updated_at)
     VALUES (?,'staff.access.reconcile','access_group','centre_1','{}',?,'queued',
             0,8,?,?,?)`,
    replacementJobId,
    `staff.access.reconcile:health-recovery:${suffix}:replacement`,
    SOURCE_AT,
    SOURCE_AT,
    SOURCE_AT,
  )
  return replacementJobId
}

async function seedLineage(db, suffix, source, replacementJobId) {
  const correlationId = `cor_health_recovery_${suffix}`
  await run(
    db,
    `INSERT INTO outbox_job_recoveries
     (id,source_job_id,replacement_job_id,operational_action_id,
      requested_by_staff_id,correlation_id,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    `rcv_health_recovery_${suffix}`,
    source.sourceJobId,
    replacementJobId,
    source.actionId,
    source.ownerId,
    correlationId,
    SOURCE_AT,
  )
  return correlationId
}

async function terminalReplacement(db, replacementJobId, status) {
  const leaseOwner = `lease_${replacementJobId}`
  await run(
    db,
    `UPDATE outbox_jobs
     SET status='processing',attempt_count=1,lease_owner=?,lease_expires_at=?,
         updated_at=? WHERE id=? AND status='queued'`,
    leaseOwner,
    new Date(NOW_MS + 60_000).toISOString(),
    SOURCE_AT,
    replacementJobId,
  )
  await run(
    db,
    `UPDATE outbox_jobs
     SET status=?,lease_owner=NULL,lease_expires_at=NULL,last_error_code=?,updated_at=?
     WHERE id=? AND status='processing'`,
    status,
    status === 'dead' ? 'OUTBOX_HANDLER_FAILURE' : null,
    TERMINAL_AT,
    replacementJobId,
  )
}

async function resolveSource(db, source, correlationId, actorStaffId) {
  await run(
    db,
    `UPDATE operational_actions
     SET status='resolved',version=2,updated_at=?,resolved_at=?
     WHERE id=? AND status='open' AND version=1`,
    TERMINAL_AT,
    TERMINAL_AT,
    source.actionId,
  )
  await run(
    db,
    `INSERT INTO audit_events
     (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
      reason_envelope,correlation_id,metadata_json)
     VALUES (?,?,?,'operational_action.resolved','operational_action',?,'success',
             NULL,?,'{"actionVersion":2}')`,
    `aud_health_recovery_resolved_${source.sourceJobId}`,
    TERMINAL_AT,
    actorStaffId,
    source.actionId,
    correlationId,
  )
}

async function evaluateOutbox(db, suffix) {
  const result = await evaluateStoredOperationalState({
    db,
    cryptoContext: await cryptoContext(db, suffix),
    nowMs: NOW_MS,
    prospectiveSchedulerRun: null,
  })
  return result.snapshot.checks.find(({ id }) => id === 'outbox.processing')
}

async function seedExactTerminalRecovery(db, suffix, replacementStatus = 'succeeded') {
  const ownerId = await seedOwner(db, suffix)
  const source = await seedSource(db, suffix, ownerId)
  const replacementJobId = await seedQueuedReplacement(db, suffix)
  const correlationId = await seedLineage(db, suffix, source, replacementJobId)
  await terminalReplacement(db, replacementJobId, replacementStatus)
  await resolveSource(db, source, correlationId, null)
  return { ...source, replacementJobId }
}

beforeAll(async () => {
  let serial = 1
  for (const db of Object.values(DATABASES)) await migrate(db, serial++)
})

describe('real-D1 recovery health exclusion', () => {
  it('excludes a proven successful recovery source but no unrelated dead job', async () => {
    const db = DATABASES.success
    await seedExactTerminalRecovery(db, 'success')
    await expect(evaluateOutbox(db, 'success')).resolves.toMatchObject({
      status: 'ok',
      detailCode: 'OUTBOX_HEALTHY',
    })

    await seedSource(db, 'success_unrelated', 'stf_health_recovery_success')
    await expect(evaluateOutbox(db, 'success')).resolves.toMatchObject({
      status: 'critical',
      detailCode: 'OUTBOX_DEAD',
    })
  })

  it('keeps a manually resolved source critical', async () => {
    const db = DATABASES.manual
    const ownerId = await seedOwner(db, 'manual')
    const source = await seedSource(db, 'manual', ownerId)
    await resolveSource(db, source, 'cor_health_recovery_manual', ownerId)

    await expect(evaluateOutbox(db, 'manual')).resolves.toMatchObject({
      status: 'critical',
      detailCode: 'OUTBOX_DEAD',
    })
  })

  it('keeps auto-resolution without lineage critical', async () => {
    const db = DATABASES.missingLineage
    const ownerId = await seedOwner(db, 'missing_lineage')
    const source = await seedSource(db, 'missing_lineage', ownerId)
    const replacementJobId = await seedQueuedReplacement(db, 'missing_lineage')
    await terminalReplacement(db, replacementJobId, 'succeeded')
    await resolveSource(db, source, 'cor_health_recovery_missing_lineage', null)

    await expect(evaluateOutbox(db, 'missing_lineage')).resolves.toMatchObject({
      status: 'critical',
      detailCode: 'OUTBOX_DEAD',
    })
  })

  it('keeps lineage without its system resolution audit critical', async () => {
    const db = DATABASES.missingAudit
    const ownerId = await seedOwner(db, 'missing_audit')
    const source = await seedSource(db, 'missing_audit', ownerId)
    const replacementJobId = await seedQueuedReplacement(db, 'missing_audit')
    await seedLineage(db, 'missing_audit', source, replacementJobId)
    await terminalReplacement(db, replacementJobId, 'succeeded')
    await run(
      db,
      `UPDATE operational_actions
       SET status='resolved',version=2,updated_at=?,resolved_at=? WHERE id=?`,
      TERMINAL_AT,
      TERMINAL_AT,
      source.actionId,
    )

    await expect(evaluateOutbox(db, 'missing_audit')).resolves.toMatchObject({
      status: 'critical',
      detailCode: 'OUTBOX_DEAD',
    })
  })

  it('keeps a dead replacement critical after excluding its proven source', async () => {
    const db = DATABASES.deadReplacement
    await seedExactTerminalRecovery(db, 'dead_replacement', 'dead')

    await expect(evaluateOutbox(db, 'dead_replacement')).resolves.toMatchObject({
      status: 'critical',
      detailCode: 'OUTBOX_DEAD',
    })
  })
})
