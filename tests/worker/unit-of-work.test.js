import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { auditEventStatement } from '../../worker/audit/events.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectIdempotency,
  recoverIdempotencyAfterCollision,
} from '../../worker/db/unit-of-work.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { getOrCreateDataKey } from '../../worker/security/envelope.js'

const now = '2027-01-15T08:00:00.000Z'
const correlationId = '11111111-1111-4111-8111-111111111111'
const scope = { type: 'staff_directory', id: 'centre_uow', purpose: 'identity' }

const audit = (db, id = 'aud_uow', result = 'success') => auditEventStatement(db, {
  id,
  occurredAt: now,
  actorStaffId: 'stf_uow',
  action: result === 'success' ? 'data_key.rewrapped' : 'identity.denied',
  entityType: result === 'success' ? 'data_key' : 'staff_user',
  entityId: result === 'success' ? 'key_uow_target' : 'stf_uow',
  result,
  correlationId,
  metadata: result === 'success' ? { oldKekVersion: 1, newKekVersion: 2 } : { version: 1 },
  reasonEnvelope: null,
})

describe('guarded unit of work', () => {
  it('preserves service order, moves one guard last, and commits once', async () => {
    const calls = []
    const batch = async (value) => {
      calls.push(value)
      return [{ success: true }]
    }
    const db = { prepare: env.DB.prepare.bind(env.DB), batch }
    const statements = {
      domain: db.prepare('SELECT 1'),
      version: db.prepare('SELECT 2'),
      audit: audit(db),
      outbox: db.prepare('SELECT 3'),
      idempotency: db.prepare('SELECT 4'),
      guard: db.prepare('SELECT 5'),
    }
    const uow = createUnitOfWork(db, { mode: 'mutation', actorId: 'stf_uow', correlationId })
    uow.domain(statements.domain)
    uow.version(statements.version)
    uow.audit(statements.audit)
    uow.outbox(statements.outbox)
    uow.idempotency(statements.idempotency)
    uow.guard(statements.guard)
    await uow.commit()
    expect(calls).toEqual([[
      statements.domain, statements.version, statements.audit,
      statements.outbox, statements.idempotency, statements.guard,
    ]])
    await expect(uow.commit()).rejects.toThrow(/^UNIT_OF_WORK_INVALID$/)
    expect(() => uow.domain(db.prepare('SELECT 6'))).toThrow(/^UNIT_OF_WORK_INVALID$/)
  })

  it('rejects invalid mutation and denial shapes before D1', async () => {
    let batchCalls = 0
    const batch = async () => { batchCalls += 1 }
    const db = { prepare: env.DB.prepare.bind(env.DB), batch }
    const cases = [
      () => createUnitOfWork(db, { mode: 'mutation', actorId: 'stf_uow', correlationId })
        .domain(db.prepare('SELECT 1')).guard(db.prepare('SELECT 2')).commit(),
      () => createUnitOfWork(db, { mode: 'mutation', actorId: 'stf_uow', correlationId })
        .domain(db.prepare('SELECT 1')).audit(audit(db)).commit(),
      () => createUnitOfWork(db, { mode: 'mutation', actorId: 'stf_uow', correlationId })
        .domain(db.prepare('SELECT 1')).audit(db.prepare('SELECT 2')).guard(db.prepare('SELECT 3')).commit(),
    ]
    for (const run of cases) await expect(Promise.resolve().then(run)).rejects.toThrow(/^UNIT_OF_WORK_INVALID$/)

    const denial = createUnitOfWork(db, { mode: 'denial', actorId: 'stf_uow', correlationId })
    expect(() => denial.domain(db.prepare('SELECT 1'))).toThrow(/^UNIT_OF_WORK_INVALID$/)
    denial.audit(audit(db, 'aud_denial', 'denied'))
    await denial.commit()
    expect(batchCalls).toBe(1)
  })

  it('uses encrypted authoritative idempotency digests and responses', async () => {
    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
      id: 'key_uow_idempotency',
      createdAt: now,
    })
    const cryptoContext = { keyring, dataKey }
    const input = {
      actorId: 'stf_uow',
      operation: 'staff.invite',
      idempotencyKey: 'idem-uow-12345678',
      requestDigest: 'digest marker parent@example.test',
      expectedScope: scope,
    }
    const statement = await createIdempotencyStatement(env.DB, cryptoContext, {
      ...input,
      resourceType: 'staff_user',
      resourceId: 'stf_new',
      response: { status: 201, body: { data: { id: 'stf_new', marker: 'response plaintext marker' } } },
      createdAt: now,
      expiresAt: '2027-01-16T08:00:00.000Z',
    })
    await statement.run()

    const raw = await env.DB.prepare(
      'SELECT request_hash,response_envelope FROM idempotency_records WHERE actor_id=? AND operation=? AND idempotency_key=?'
    ).bind(input.actorId, input.operation, input.idempotencyKey).first()
    expect(JSON.stringify(raw)).not.toContain(input.requestDigest)
    expect(JSON.stringify(raw)).not.toContain('response plaintext marker')
    await expect(inspectIdempotency(env.DB, cryptoContext, input)).resolves.toEqual({
      status: 201,
      body: { data: { id: 'stf_new', marker: 'response plaintext marker' } },
    })
    await expect(inspectIdempotency(env.DB, cryptoContext, {
      ...input,
      requestDigest: 'different digest',
    })).rejects.toThrow(/^IDEMPOTENCY_CONFLICT$/)
  })

  it('recovers only an exact winner after the accepted collision sentinel', async () => {
    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
      id: 'key_uow_recovery',
      createdAt: now,
    })
    const cryptoContext = { keyring, dataKey }
    const input = {
      actorId: 'stf_recovery',
      operation: 'staff.invite',
      idempotencyKey: 'idem-recovery-1234',
      requestDigest: 'same',
      expectedScope: scope,
    }
    const collision = new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT')
    await expect(recoverIdempotencyAfterCollision(env.DB, cryptoContext, input, collision)).rejects.toBe(collision)
  })
})
