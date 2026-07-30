import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  auditEventStatement,
  encryptAuditReason,
  enforceAuditRateLimit,
} from '../../worker/audit/events.js'
import {
  commitRateLimitedMutation,
  createIdempotencyStatement,
  createUnitOfWork,
  inspectIdempotency,
  isRateLimitDenialDescriptor,
  rateLimitGuardStatement,
  recoverIdempotencyAfterCollision,
} from '../../worker/db/unit-of-work.js'
import { createKeyring } from '../../worker/security/keyring.js'
import { encodeBase64Url } from '../../worker/security/encoding.js'
import {
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'

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

async function seedActor(id, lookup = `lookup_${id}`) {
  if (await env.DB.prepare('SELECT id FROM staff_users WHERE id=?').bind(id).first()) return
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at)
     VALUES (?,?,'{}','{}','owner','pending',1,?,?)`
  ).bind(id, lookup, now, now).run()
}

const guardFor = (db, auditId, predicate, ...bindings) => db.prepare(
  `INSERT INTO audit_events
   (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,reason_envelope,correlation_id,metadata_json)
   SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,reason_envelope,correlation_id,metadata_json
   FROM audit_events WHERE id=? AND NOT (${predicate})`
).bind(auditId, ...bindings)

const encryptedReasonEnvelope = JSON.stringify({
  format: 1,
  algorithm: 'A256GCM',
  dataKeyId: 'key_rate_reason',
  dataKeyVersion: 1,
  nonce: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
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

  it.each(['domain', 'version', 'outbox', 'idempotency', 'guard'])(
    'rejects a tagged audit statement smuggled through %s before D1',
    async (channel) => {
      let batchCalls = 0
      const db = {
        prepare: env.DB.prepare.bind(env.DB),
        batch: async () => { batchCalls += 1 },
      }
      const uow = createUnitOfWork(db, { mode: 'mutation', actorId: 'stf_uow', correlationId })
      const tagged = audit(db, `aud_smuggled_${channel}`)
      expect(() => uow[channel](tagged)).toThrow(/^UNIT_OF_WORK_INVALID$/)
      expect(batchCalls).toBe(0)
    }
  )

  it('rejects two primary audits and multiple guards before D1', async () => {
    let batchCalls = 0
    const db = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async () => { batchCalls += 1 },
    }
    const twoAudits = createUnitOfWork(db, {
      mode: 'mutation', actorId: 'stf_uow', correlationId,
    })
    twoAudits.domain(db.prepare('SELECT 1'))
    twoAudits.audit(audit(db, 'aud_uow_first'))
    twoAudits.audit(audit(db, 'aud_uow_second'))
    twoAudits.guard(db.prepare('SELECT 2'))
    await expect(twoAudits.commit()).rejects.toThrow(/^UNIT_OF_WORK_INVALID$/)

    const guards = createUnitOfWork(db, {
      mode: 'mutation', actorId: 'stf_uow', correlationId,
    })
    guards.domain(db.prepare('SELECT 1'))
    guards.audit(audit(db, 'aud_uow_guards'))
    guards.guard(db.prepare('SELECT 2'))
    expect(() => guards.guard(db.prepare('SELECT 3'))).toThrow(/^UNIT_OF_WORK_INVALID$/)
    expect(batchCalls).toBe(0)
  })

  it('commits every channel together through a real audit-sourced D1 guard', async () => {
    await seedActor('stf_uow')
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS task6_uow_commit (id TEXT PRIMARY KEY, channel TEXT NOT NULL)'
    ).run()
    const auditId = 'aud_uow_real_commit'
    const uow = createUnitOfWork(env.DB, { mode: 'mutation', actorId: 'stf_uow', correlationId })
    uow.domain(env.DB.prepare("INSERT INTO task6_uow_commit VALUES ('domain','domain')"))
    uow.version(env.DB.prepare("INSERT INTO task6_uow_commit VALUES ('version','version')"))
    uow.audit(audit(env.DB, auditId))
    uow.outbox(env.DB.prepare("INSERT INTO task6_uow_commit VALUES ('outbox','outbox')"))
    uow.idempotency(env.DB.prepare("INSERT INTO task6_uow_commit VALUES ('idempotency','idempotency')"))
    uow.guard(guardFor(
      env.DB,
      auditId,
      "(SELECT count(*) FROM task6_uow_commit WHERE id IN ('domain','version','outbox','idempotency'))=4",
    ))
    await uow.commit()
    expect((await env.DB.prepare('SELECT count(*) AS count FROM task6_uow_commit').first()).count).toBe(4)
    expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id=?').bind(auditId).first())
      .toEqual({ id: auditId })
  })

  it('rolls back ordinary constraint failures and audit-sourced zero/missing postconditions', async () => {
    await seedActor('stf_uow')
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS task6_uow_rollback (id TEXT PRIMARY KEY, value TEXT NOT NULL)'
    ).run()
    await env.DB.prepare("INSERT INTO task6_uow_rollback VALUES ('occupied','fixed')").run()

    const ordinaryAudit = 'aud_uow_ordinary_rollback'
    const ordinary = createUnitOfWork(env.DB, {
      mode: 'mutation', actorId: 'stf_uow', correlationId,
    })
    ordinary.domain(env.DB.prepare("INSERT INTO task6_uow_rollback VALUES ('ordinary_partial','partial')"))
    ordinary.version(env.DB.prepare("INSERT INTO task6_uow_rollback VALUES ('occupied','collision')"))
    ordinary.audit(audit(env.DB, ordinaryAudit))
    ordinary.guard(guardFor(env.DB, ordinaryAudit, '1=1'))
    await expect(ordinary.commit()).rejects.toThrow()
    expect(await env.DB.prepare("SELECT id FROM task6_uow_rollback WHERE id='ordinary_partial'").first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id=?').bind(ordinaryAudit).first()).toBeNull()

    await env.DB.prepare("INSERT INTO task6_uow_rollback VALUES ('cas_target','old')").run()
    const zeroAudit = 'aud_uow_zero_rollback'
    const zero = createUnitOfWork(env.DB, {
      mode: 'mutation', actorId: 'stf_uow', correlationId,
    })
    zero.domain(env.DB.prepare(
      "UPDATE task6_uow_rollback SET value='new' WHERE id='cas_target' AND value='wrong'"
    ))
    zero.audit(audit(env.DB, zeroAudit))
    zero.guard(guardFor(
      env.DB,
      zeroAudit,
      "EXISTS (SELECT 1 FROM task6_uow_rollback WHERE id='cas_target' AND value='new')",
    ))
    await expect(zero.commit()).rejects.toThrow()
    expect(await env.DB.prepare("SELECT value FROM task6_uow_rollback WHERE id='cas_target'").first())
      .toEqual({ value: 'old' })
    expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id=?').bind(zeroAudit).first()).toBeNull()

    const missingAudit = 'aud_uow_missing_rollback'
    const missing = createUnitOfWork(env.DB, {
      mode: 'mutation', actorId: 'stf_uow', correlationId,
    })
    missing.domain(env.DB.prepare("INSERT INTO task6_uow_rollback VALUES ('other_partial','partial')"))
    missing.audit(audit(env.DB, missingAudit))
    missing.guard(guardFor(
      env.DB,
      missingAudit,
      "EXISTS (SELECT 1 FROM task6_uow_rollback WHERE id='expected_missing')",
    ))
    await expect(missing.commit()).rejects.toThrow()
    expect(await env.DB.prepare("SELECT id FROM task6_uow_rollback WHERE id='other_partial'").first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id=?').bind(missingAudit).first()).toBeNull()
  })

  it('commits one real denial audit and no non-audit state', async () => {
    await seedActor('stf_uow')
    const auditId = 'aud_uow_real_denial'
    const denial = createUnitOfWork(env.DB, {
      mode: 'denial', actorId: 'stf_uow', correlationId,
    })
    denial.audit(audit(env.DB, auditId, 'denied'))
    await denial.commit()
    expect(await env.DB.prepare('SELECT result FROM audit_events WHERE id=?').bind(auditId).first())
      .toEqual({ result: 'denied' })
  })

  it.each([
    ['action', { action: 'identity.denied' }],
    ['entity type', { entityType: 'data_key' }],
    ['entity id', { entityId: 'stf_other' }],
    ['actor id', { actorStaffId: 'stf_other' }],
    ['correlation id', { correlationId: '22222222-2222-4222-8222-222222222222' }],
    ['result', { result: 'success' }],
  ])('rejects an independently mismatched rate denial descriptor: %s', (_field, patch) => {
    const descriptor = {
      action: 'authorization.denied',
      entityType: 'staff_user',
      entityId: 'stf_rate_descriptor',
      actorStaffId: 'stf_rate_descriptor',
      correlationId,
      result: 'denied',
      ...patch,
    }
    expect(isRateLimitDenialDescriptor(descriptor, {
      actorId: 'stf_rate_descriptor',
      correlationId,
    })).toBe(false)
  })

  it('accepts only the exact rate denial descriptor', () => {
    expect(isRateLimitDenialDescriptor({
      action: 'authorization.denied',
      entityType: 'staff_user',
      entityId: 'stf_rate_descriptor',
      actorStaffId: 'stf_rate_descriptor',
      correlationId,
      result: 'denied',
    }, {
      actorId: 'stf_rate_descriptor',
      correlationId,
    })).toBe(true)
  })

  it.each([
    ['identity denial', {
      action: 'identity.denied',
      entityId: 'stf_rate_binding',
      reasonEnvelope: null,
    }],
    ['another staff entity', {
      action: 'authorization.denied',
      entityId: 'stf_rate_binding_other',
      reasonEnvelope: encryptedReasonEnvelope,
    }],
  ])('rejects a tagged %s before any D1 call', async (_label, denialInput) => {
    const actorId = 'stf_rate_binding'
    const requestCorrelationId = '33333333-3333-4333-8333-333333333333'
    await seedActor(actorId)
    await seedActor('stf_rate_binding_other')
    const prepare = vi.fn((sql) => env.DB.prepare(sql))
    const batch = vi.fn((statements) => env.DB.batch(statements))
    const db = { prepare, batch }
    const auditId = `aud_rate_binding_${denialInput.action.replace('.', '_')}`
    const uow = createUnitOfWork(db, {
      mode: 'mutation', actorId, correlationId: requestCorrelationId,
    })
    uow.domain(db.prepare('SELECT 1'))
    uow.audit(auditEventStatement(db, {
      id: auditId,
      occurredAt: now,
      actorStaffId: actorId,
      action: 'data_key.rewrapped',
      entityType: 'data_key',
      entityId: `key_${auditId}`,
      result: 'success',
      correlationId: requestCorrelationId,
      metadata: { oldKekVersion: 1, newKekVersion: 2 },
      reasonEnvelope: null,
    }))
    uow.guard(rateLimitGuardStatement(db, {
      auditId,
      actorId,
      action: 'data_key.rewrapped',
      limit: 5,
      since: '2027-01-15T07:00:00.000Z',
      postconditionSql: '1=1',
      postconditionBindings: [],
    }))
    const denialAudit = auditEventStatement(db, {
      id: `${auditId}_denied`,
      occurredAt: now,
      actorStaffId: actorId,
      action: denialInput.action,
      entityType: 'staff_user',
      entityId: denialInput.entityId,
      result: 'denied',
      correlationId: requestCorrelationId,
      metadata: { version: 1 },
      reasonEnvelope: denialInput.reasonEnvelope,
    })
    prepare.mockClear()
    batch.mockClear()
    await expect(commitRateLimitedMutation(db, uow, {
      actorId,
      action: 'data_key.rewrapped',
      limit: 5,
      since: '2027-01-15T07:00:00.000Z',
      correlationId: requestCorrelationId,
      denialAudit,
    })).rejects.toThrow(/^UNIT_OF_WORK_INVALID$/)
    expect(prepare).not.toHaveBeenCalled()
    expect(batch).not.toHaveBeenCalled()
  })

  it('enforces the concurrent audit rate limit in the final guard', async () => {
    const actorId = 'stf_uow_rate'
    await seedActor(actorId)
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS task6_rate_domain (id TEXT PRIMARY KEY)'
    ).run()
    const since = '2027-01-15T07:00:00.000Z'
    for (let index = 0; index < 4; index += 1) {
      await auditEventStatement(env.DB, {
        id: `aud_rate_seed_${index}`,
        occurredAt: `2027-01-15T07:0${index}:00.000Z`,
        actorStaffId: actorId,
        action: 'data_key.rewrapped',
        entityType: 'data_key',
        entityId: `key_rate_seed_${index}`,
        result: 'success',
        correlationId,
        metadata: { oldKekVersion: 1, newKekVersion: 2 },
        reasonEnvelope: null,
      }).run()
    }
    await expect(enforceAuditRateLimit(env.DB, {
      actorId, action: 'data_key.rewrapped', limit: 5, since,
    })).resolves.toBe(4)

    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
      id: 'key_uow_rate_denial',
      createdAt: now,
    })
    const attempt = async (suffix, requestCorrelationId) => {
      const auditId = `aud_rate_${suffix}`
      const denialAuditId = `aud_rate_denied_${suffix}`
      const uow = createUnitOfWork(env.DB, {
        mode: 'mutation', actorId, correlationId: requestCorrelationId,
      })
      uow.audit(auditEventStatement(env.DB, {
        id: auditId,
        occurredAt: '2027-01-15T08:00:00.000Z',
        actorStaffId: actorId,
        action: 'data_key.rewrapped',
        entityType: 'data_key',
        entityId: `key_rate_${suffix}`,
        result: 'success',
        correlationId: requestCorrelationId,
        metadata: { oldKekVersion: 1, newKekVersion: 2 },
        reasonEnvelope: null,
      }))
      uow.domain(env.DB.prepare('INSERT INTO task6_rate_domain (id) VALUES (?)').bind(suffix))
      uow.guard(rateLimitGuardStatement(env.DB, {
        auditId,
        actorId,
        action: 'data_key.rewrapped',
        limit: 5,
        since,
        postconditionSql: 'EXISTS (SELECT 1 FROM task6_rate_domain WHERE id=?)',
        postconditionBindings: [suffix],
      }))
      const denialAudit = auditEventStatement(env.DB, {
        id: denialAuditId,
        occurredAt: '2027-01-15T08:00:01.000Z',
        actorStaffId: actorId,
        action: 'authorization.denied',
        entityType: 'staff_user',
        entityId: actorId,
        result: 'denied',
        correlationId: requestCorrelationId,
        metadata: { version: 1 },
        reasonEnvelope: await encryptAuditReason({
          keyring,
          dataKey,
          expectedScope: scope,
          auditEventId: denialAuditId,
          plaintext: 'audited endpoint rate limit',
        }),
      })
      await commitRateLimitedMutation(env.DB, uow, {
        actorId,
        action: 'data_key.rewrapped',
        limit: 5,
        since,
        correlationId: requestCorrelationId,
        denialAudit,
      })
      return suffix
    }
    const settled = await Promise.allSettled([
      attempt('one', '11111111-1111-4111-8111-111111111111'),
      attempt('two', '22222222-2222-4222-8222-222222222222'),
    ])
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const [loser] = settled.filter(({ status }) => status === 'rejected')
    expect(loser.reason).toEqual(expect.objectContaining({ message: 'RATE_LIMITED' }))
    const winner = settled.find(({ status }) => status === 'fulfilled').value
    const loserSuffix = winner === 'one' ? 'two' : 'one'
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE actor_staff_id=? AND action='data_key.rewrapped' AND occurred_at>=?"
    ).bind(actorId, since).first()).count).toBe(5)
    expect((await env.DB.prepare('SELECT count(*) AS count FROM task6_rate_domain').first()).count).toBe(1)
    expect(await env.DB.prepare('SELECT id FROM task6_rate_domain WHERE id=?').bind(loserSuffix).first()).toBeNull()
    expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id=?').bind(`aud_rate_${loserSuffix}`).first())
      .toBeNull()
    const denials = await env.DB.prepare(
      `SELECT id,actor_staff_id,result,correlation_id
       FROM audit_events
       WHERE actor_staff_id=? AND action='authorization.denied'`
    ).bind(actorId).all()
    expect(denials.results).toEqual([{
      id: `aud_rate_denied_${loserSuffix}`,
      actor_staff_id: actorId,
      result: 'denied',
      correlation_id: loserSuffix === 'one'
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222',
    }])
    await expect(enforceAuditRateLimit(env.DB, {
      actorId, action: 'data_key.rewrapped', limit: 5, since,
    })).rejects.toThrow(/^RATE_LIMITED$/)
  })

  it('preserves an unrelated identity collision when a concurrent winner reaches the limit', async () => {
    const actorId = 'stf_uow_rate_provenance'
    const requestCorrelationId = '44444444-4444-4444-8444-444444444444'
    const since = '2027-01-15T07:00:00.000Z'
    await seedActor(actorId)
    await seedActor('stf_uow_rate_collision')
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS task6_rate_provenance (id TEXT PRIMARY KEY)'
    ).run()
    for (let index = 0; index < 4; index += 1) {
      await auditEventStatement(env.DB, {
        id: `aud_rate_provenance_seed_${index}`,
        occurredAt: `2027-01-15T07:0${index}:00.000Z`,
        actorStaffId: actorId,
        action: 'data_key.rewrapped',
        entityType: 'data_key',
        entityId: `key_rate_provenance_seed_${index}`,
        result: 'success',
        correlationId,
        metadata: { oldKekVersion: 1, newKekVersion: 2 },
        reasonEnvelope: null,
      }).run()
    }

    let enterBatch
    let releaseBatch
    let originalCollision
    let batchCalls = 0
    const entered = new Promise((resolve) => { enterBatch = resolve })
    const released = new Promise((resolve) => { releaseBatch = resolve })
    const loserDb = {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements) {
        batchCalls += 1
        if (batchCalls === 1) {
          enterBatch()
          await released
        }
        try {
          return await env.DB.batch(statements)
        } catch (error) {
          originalCollision = error
          throw error
        }
      },
    }
    const loserAuditId = 'aud_rate_provenance_loser'
    const loser = createUnitOfWork(loserDb, {
      mode: 'mutation', actorId, correlationId: requestCorrelationId,
    })
    loser.domain(loserDb.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at)
       VALUES ('stf_uow_rate_collision','collision','{}','{}','owner','pending',1,?,?)`
    ).bind(now, now))
    loser.domain(loserDb.prepare(
      "INSERT INTO task6_rate_provenance (id) VALUES ('loser_post_state')"
    ))
    loser.audit(auditEventStatement(loserDb, {
      id: loserAuditId,
      occurredAt: now,
      actorStaffId: actorId,
      action: 'data_key.rewrapped',
      entityType: 'data_key',
      entityId: 'key_rate_provenance_loser',
      result: 'success',
      correlationId: requestCorrelationId,
      metadata: { oldKekVersion: 1, newKekVersion: 2 },
      reasonEnvelope: null,
    }))
    loser.guard(rateLimitGuardStatement(loserDb, {
      auditId: loserAuditId,
      actorId,
      action: 'data_key.rewrapped',
      limit: 5,
      since,
      postconditionSql: "EXISTS (SELECT 1 FROM task6_rate_provenance WHERE id='loser_post_state')",
      postconditionBindings: [],
    }))
    const denialAudit = auditEventStatement(loserDb, {
      id: 'aud_rate_provenance_denied',
      occurredAt: now,
      actorStaffId: actorId,
      action: 'authorization.denied',
      entityType: 'staff_user',
      entityId: actorId,
      result: 'denied',
      correlationId: requestCorrelationId,
      metadata: { version: 1 },
      reasonEnvelope: encryptedReasonEnvelope,
    })

    const loserResult = commitRateLimitedMutation(loserDb, loser, {
      actorId,
      action: 'data_key.rewrapped',
      limit: 5,
      since,
      correlationId: requestCorrelationId,
      denialAudit,
    }).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    )
    await entered
    const winnerAuditId = 'aud_rate_provenance_winner'
    const winner = createUnitOfWork(env.DB, {
      mode: 'mutation',
      actorId,
      correlationId: '55555555-5555-4555-8555-555555555555',
    })
    winner.domain(env.DB.prepare(
      "INSERT INTO task6_rate_provenance (id) VALUES ('winner_post_state')"
    ))
    winner.audit(auditEventStatement(env.DB, {
      id: winnerAuditId,
      occurredAt: now,
      actorStaffId: actorId,
      action: 'data_key.rewrapped',
      entityType: 'data_key',
      entityId: 'key_rate_provenance_winner',
      result: 'success',
      correlationId: '55555555-5555-4555-8555-555555555555',
      metadata: { oldKekVersion: 1, newKekVersion: 2 },
      reasonEnvelope: null,
    }))
    winner.guard(rateLimitGuardStatement(env.DB, {
      auditId: winnerAuditId,
      actorId,
      action: 'data_key.rewrapped',
      limit: 5,
      since,
      postconditionSql: "EXISTS (SELECT 1 FROM task6_rate_provenance WHERE id='winner_post_state')",
      postconditionBindings: [],
    }))
    await winner.commit()
    releaseBatch()

    const outcome = await loserResult
    expect(outcome.status).toBe('rejected')
    expect(outcome.reason).toBe(originalCollision)
    expect(outcome.reason.message).toMatch(/identity_collision/)
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE actor_staff_id=? AND action='data_key.rewrapped' AND occurred_at>=?"
    ).bind(actorId, since).first()).count).toBe(5)
    expect(await env.DB.prepare('SELECT id FROM audit_events WHERE id=?').bind(loserAuditId).first()).toBeNull()
    expect(await env.DB.prepare(
      "SELECT id FROM audit_events WHERE id='aud_rate_provenance_denied'"
    ).first()).toBeNull()
    expect(await env.DB.prepare(
      "SELECT id FROM task6_rate_provenance WHERE id='loser_post_state'"
    ).first()).toBeNull()
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

  it('keeps expired tuples authoritative and rejects tampered or swapped-scope envelopes', async () => {
    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
      id: 'key_uow_expired',
      createdAt: now,
    })
    const cryptoContext = { keyring, dataKey }
    const input = {
      actorId: 'stf_uow_expired',
      operation: 'staff.invite',
      idempotencyKey: 'idem-expired-1234',
      requestDigest: 'expired digest',
      expectedScope: scope,
    }
    await (await createIdempotencyStatement(env.DB, cryptoContext, {
      ...input,
      resourceType: 'staff_user',
      resourceId: 'stf_expired',
      response: { status: 201, body: { data: { id: 'stf_expired' } } },
      createdAt: '2027-01-14T06:00:00.000Z',
      expiresAt: '2027-01-14T07:00:00.000Z',
    })).run()
    await expect(inspectIdempotency(env.DB, cryptoContext, input)).resolves.toEqual({
      status: 201,
      body: { data: { id: 'stf_expired' } },
    })
    await expect(inspectIdempotency(env.DB, cryptoContext, {
      ...input,
      requestDigest: 'different expired digest',
    })).rejects.toThrow(/^IDEMPOTENCY_CONFLICT$/)
    await expect(inspectIdempotency(env.DB, cryptoContext, {
      ...input,
      expectedScope: { ...scope, id: 'centre_swapped' },
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)

    await env.DB.prepare(
      `INSERT INTO idempotency_records
       (actor_id,operation,idempotency_key,request_hash,resource_type,resource_id,response_envelope,created_at,expires_at)
       VALUES ('stf_uow_tampered','staff.invite','idem-tampered-123','{}','staff_user','stf_tampered','{}',?,?)`
    ).bind(now, '2027-01-16T08:00:00.000Z').run()
    await expect(inspectIdempotency(env.DB, cryptoContext, {
      actorId: 'stf_uow_tampered',
      operation: 'staff.invite',
      idempotencyKey: 'idem-tampered-123',
      requestDigest: 'tampered',
      expectedScope: scope,
    })).rejects.toThrow(/^CRYPTO_FAILURE$/)
  })

  it('fails generically on a valid request envelope with a tampered response or missing data key', async () => {
    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
      id: 'key_uow_response_tamper',
      createdAt: now,
    })
    const input = {
      actorId: 'stf_uow_response_tamper',
      operation: 'staff.invite',
      idempotencyKey: 'idem-response-tamper',
      requestDigest: 'valid request digest',
      expectedScope: scope,
    }
    const tuple = new TextEncoder().encode(
      ['bwm:idempotency:record:v1', input.actorId, input.operation, input.idempotencyKey].join('\n')
    )
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', tuple))
    const recordId = `idem_${encodeBase64Url(digest)}`
    tuple.fill(0)
    digest.fill(0)
    const requestHash = JSON.stringify(await encryptForScope(keyring, dataKey, {
      expectedScope: scope,
      recordId,
      field: 'idempotency_request_hash',
      plaintext: input.requestDigest,
    }))
    await env.DB.prepare(
      `INSERT INTO idempotency_records
       (actor_id,operation,idempotency_key,request_hash,resource_type,resource_id,response_envelope,created_at,expires_at)
       VALUES (?,?,?,?,? ,?,'{}',?,?)`
    ).bind(
      input.actorId,
      input.operation,
      input.idempotencyKey,
      requestHash,
      'staff_user',
      'stf_response_tamper',
      now,
      '2027-01-16T08:00:00.000Z',
    ).run()
    await expect(inspectIdempotency(env.DB, { keyring, dataKey }, input))
      .rejects.toThrow(/^CRYPTO_FAILURE$/)
    const missingKeyInput = {
      actorId: 'stf_uow_missing_key',
      operation: 'staff.invite',
      idempotencyKey: 'idem-missing-key-123',
      requestDigest: 'missing key digest',
      expectedScope: scope,
    }
    await (await createIdempotencyStatement(env.DB, { keyring, dataKey }, {
      ...missingKeyInput,
      resourceType: 'staff_user',
      resourceId: 'stf_missing_key',
      response: { status: 201, body: { data: { id: 'stf_missing_key' } } },
      createdAt: now,
      expiresAt: '2027-01-16T08:00:00.000Z',
    })).run()
    await expect(inspectIdempotency(env.DB, {
      keyring,
      dataKey: { ...dataKey, id: 'key_missing' },
    }, missingKeyInput)).rejects.toThrow(/^CRYPTO_FAILURE$/)
  })

  it.each([
    ['same', false],
    ['different', true],
  ])('resolves barrier-controlled concurrent %s-request idempotency with one mutation', async (race, shouldConflict) => {
    const actorId = `stf_idem_${race}`
    await seedActor(actorId)
    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    const dataKey = await getOrCreateDataKey(env.DB, keyring, scope, {
      id: `key_idem_${race}`,
      createdAt: now,
    })
    const cryptoContext = { keyring, dataKey }
    for (const table of ['domain', 'version', 'outbox']) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS task6_idem_${race}_${table} (id TEXT PRIMARY KEY, value TEXT NOT NULL)`
      ).run()
    }
    let waiting = 0
    let release
    const barrierPromise = new Promise((resolve) => { release = resolve })
    const barrier = async () => {
      waiting += 1
      if (waiting === 2) release()
      await barrierPromise
    }
    const operation = `task6.${race}`
    const idempotencyKey = `idem-race-${race}-1234`
    const execute = async (suffix, requestDigest) => {
      const inspectInput = {
        actorId, operation, idempotencyKey, requestDigest, expectedScope: scope,
      }
      const replay = await inspectIdempotency(env.DB, cryptoContext, inspectInput)
      if (replay) return replay
      await barrier()
      const response = { status: 201, body: { data: { winner: suffix } } }
      const auditId = `aud_idem_${race}_${suffix}`
      const uow = createUnitOfWork(env.DB, { mode: 'mutation', actorId, correlationId })
      uow.audit(auditEventStatement(env.DB, {
        id: auditId,
        occurredAt: now,
        actorStaffId: actorId,
        action: 'data_key.rewrapped',
        entityType: 'data_key',
        entityId: `key_idem_${race}`,
        result: 'success',
        correlationId,
        metadata: { oldKekVersion: 1, newKekVersion: 2 },
        reasonEnvelope: null,
      }))
      uow.idempotency(await createIdempotencyStatement(env.DB, cryptoContext, {
        ...inspectInput,
        resourceType: 'staff_user',
        resourceId: `stf_idem_resource_${race}`,
        response,
        createdAt: now,
        expiresAt: '2027-01-16T08:00:00.000Z',
      }))
      uow.domain(env.DB.prepare(
        `INSERT INTO task6_idem_${race}_domain (id,value) VALUES ('resource',?)`
      ).bind(suffix))
      uow.version(env.DB.prepare(
        `INSERT INTO task6_idem_${race}_version (id,value) VALUES ('resource',?)`
      ).bind(suffix))
      uow.outbox(env.DB.prepare(
        `INSERT INTO task6_idem_${race}_outbox (id,value) VALUES ('resource',?)`
      ).bind(suffix))
      uow.guard(guardFor(
        env.DB,
        auditId,
        `EXISTS (SELECT 1 FROM task6_idem_${race}_domain WHERE id='resource')
         AND EXISTS (SELECT 1 FROM task6_idem_${race}_version WHERE id='resource')
         AND EXISTS (SELECT 1 FROM task6_idem_${race}_outbox WHERE id='resource')
         AND EXISTS (SELECT 1 FROM idempotency_records
                     WHERE actor_id=? AND operation=? AND idempotency_key=?)`,
        actorId,
        operation,
        idempotencyKey,
      ))
      try {
        await uow.commit()
        return response
      } catch (error) {
        return recoverIdempotencyAfterCollision(env.DB, cryptoContext, inspectInput, error)
      }
    }
    const digests = shouldConflict ? ['digest one', 'digest two'] : ['same digest', 'same digest']
    const settled = await Promise.allSettled([
      execute('one', digests[0]),
      execute('two', digests[1]),
    ])
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(shouldConflict ? 1 : 2)
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(shouldConflict ? 1 : 0)
    if (shouldConflict) {
      expect(settled.find(({ status }) => status === 'rejected').reason)
        .toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' })
    } else {
      expect(settled[0].value).toEqual(settled[1].value)
    }
    for (const table of ['domain', 'version', 'outbox']) {
      expect((await env.DB.prepare(
        `SELECT count(*) AS count FROM task6_idem_${race}_${table}`
      ).first()).count).toBe(1)
    }
    expect((await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_events WHERE actor_staff_id=? AND action='data_key.rewrapped'"
    ).bind(actorId).first()).count).toBe(1)
    expect((await env.DB.prepare(
      'SELECT count(*) AS count FROM idempotency_records WHERE actor_id=? AND operation=? AND idempotency_key=?'
    ).bind(actorId, operation, idempotencyKey).first()).count).toBe(1)
  })
})
