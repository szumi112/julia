import { encryptForScope } from '../security/envelope.js'

export const OUTBOX_TYPES = Object.freeze(['staff.access.reconcile', 'staff.invitation.email', 'staff.invitation.expire'])
const delays = [60_000, 300_000, 900_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000]
export const retryDelayMs = (attempt) => delays[attempt - 1] ?? null
const iso = (value) => new Date(value).toISOString()

export async function enqueueOutboxStatement(db, cryptoContext, { id, type, aggregateType, aggregateId, payload, idempotencyKey, scheduledAt, nowMs, maxAttempts = 8 }) {
  if (!OUTBOX_TYPES.includes(type)) throw new Error('OUTBOX_INVALID')
  const envelope = JSON.stringify(await encryptForScope(cryptoContext.keyring, cryptoContext.dataKey, { expectedScope: cryptoContext.scope, recordId: id, field: 'job_payload', plaintext: JSON.stringify(payload) }))
  const now = iso(nowMs)
  return db.prepare(
    `INSERT INTO outbox_jobs (id,type,aggregate_type,aggregate_id,payload_envelope,idempotency_key,status,attempt_count,max_attempts,scheduled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?, 'queued',0,?,?,?,?)`
  ).bind(id, type, aggregateType, aggregateId, envelope, idempotencyKey, maxAttempts, scheduledAt, now, now)
}

export async function claimDueJobs(db, { nowMs, leaseOwner, idFactory, limit = 10 }) {
  const now = iso(nowMs); const expiry = iso(nowMs + 60_000)
  await db.prepare("UPDATE outbox_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE status='processing' AND lease_expires_at<=?").bind(now, now).run()
  const due = (await db.prepare("SELECT id,attempt_count FROM outbox_jobs WHERE status='queued' AND scheduled_at<=? ORDER BY scheduled_at,id LIMIT ?").bind(now, Math.min(10, limit)).all()).results
  const claimed = []
  for (const row of due) {
    const result = await db.prepare("UPDATE outbox_jobs SET status='processing',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status='queued' AND scheduled_at<=?").bind(leaseOwner, expiry, now, row.id, now).run()
    if (result.meta.changes === 1) {
      const attemptId = idFactory()
      await db.prepare('INSERT INTO outbox_attempts (id,job_id,attempt_number,started_at) VALUES (?,?,?,?)').bind(attemptId, row.id, row.attempt_count + 1, now).run()
      claimed.push({ id: row.id, attemptNumber: row.attempt_count + 1 })
    }
  }
  return claimed
}

export async function completeOutboxJob(db, { jobId, leaseOwner, nowMs, result, errorCode = null, providerReference = null }) {
  const now = iso(nowMs)
  const job = await db.prepare("SELECT attempt_count,max_attempts FROM outbox_jobs WHERE id=? AND status='processing' AND lease_owner=?").bind(jobId, leaseOwner).first()
  if (!job) return false
  const retry = result === 'retry' && job.attempt_count < job.max_attempts
  const status = retry ? 'queued' : result === 'succeeded' ? 'succeeded' : 'dead'
  const scheduled = retry ? iso(nowMs + retryDelayMs(job.attempt_count)) : now
  const statements = [
    db.prepare('UPDATE outbox_attempts SET completed_at=?,result=?,error_code=?,provider_reference=? WHERE job_id=? AND attempt_number=? AND completed_at IS NULL')
      .bind(now, retry ? 'retry' : result === 'succeeded' ? 'succeeded' : 'dead', errorCode, providerReference, jobId, job.attempt_count),
    db.prepare("UPDATE outbox_jobs SET status=?,scheduled_at=?,lease_owner=NULL,lease_expires_at=NULL,last_error_code=?,updated_at=? WHERE id=? AND status='processing' AND lease_owner=?")
      .bind(status, scheduled, errorCode, now, jobId, leaseOwner),
  ]
  await db.batch(statements)
  return true
}

export async function processOutboxBatch({ db, cryptoContext, config, nowMs, idFactory = () => crypto.randomUUID().replaceAll('-', ''), leaseOwner = idFactory(), dispatch } = {}) {
  if (!db?.prepare || typeof dispatch !== 'function') throw new Error('OUTBOX_INVALID')
  const claims = await claimDueJobs(db, { nowMs, leaseOwner, idFactory })
  const completed = []
  for (const claim of claims) {
    const job = await db.prepare('SELECT * FROM outbox_jobs WHERE id=? AND status=\'processing\' AND lease_owner=?').bind(claim.id, leaseOwner).first()
    if (!job) continue
    let outcome
    try { outcome = await dispatch({ db, cryptoContext, config, job, nowMs }) } catch (error) {
      outcome = { result: error?.retryable ? 'retry' : 'dead', errorCode: error?.message === 'EMAIL_DELIVERY_AMBIGUOUS' ? error.message : 'OUTBOX_HANDLER_FAILURE' }
    }
    const done = await completeOutboxJob(db, { jobId: job.id, leaseOwner, nowMs, result: outcome?.result === 'succeeded' ? 'succeeded' : outcome?.result === 'retry' ? 'retry' : 'dead', errorCode: outcome?.errorCode ?? null, providerReference: outcome?.providerReference ?? null })
    if (done) completed.push({ id: job.id, result: outcome?.result })
  }
  return completed
}
