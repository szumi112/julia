import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ROLE_DEFAULT_CAPABILITIES,
  effectiveCapabilitiesFor,
} from '../../src/capabilities.js'
import {
  getCapabilityOverrides,
  listCapabilityTargets,
  replaceCapabilityOverrides,
} from '../../worker/identity/capability-overrides.js'
import {
  createKeyring,
} from '../../worker/security/keyring.js'
import {
  encryptForScope,
  getOrCreateDataKey,
} from '../../worker/security/envelope.js'
import { publicError } from '../../worker/http/errors.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = Date.parse('2026-08-28T12:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const SCOPE = Object.freeze({
  type: 'staff_directory',
  id: 'centre_1',
  purpose: 'identity',
})

let context
let serial = 0

const encrypted = async (recordId, field, plaintext) => JSON.stringify(
  await encryptForScope(context.keyring, context.dataKey, {
    expectedScope: SCOPE,
    recordId,
    field,
    plaintext,
  }),
)

async function seedStaff({
  displayName,
  role = 'coordinator',
  status = 'active',
  suffix = `${++serial}`,
} = {}) {
  const id = `stf_capability_${suffix}`
  const specialistId = role === 'specialist' ? `sp_capability_${suffix}` : null
  await env.DB.prepare(
    `INSERT INTO staff_users
     (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
      specialist_id,version,activated_at,disabled_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`,
  ).bind(
    id,
    `lookup-capability-${suffix}`,
    await encrypted(id, 'email', `${suffix}@example.test`),
    await encrypted(id, 'display_name', displayName ?? `Osoba ${suffix}`),
    role,
    status,
    status === 'pending' ? null : `subject-${suffix}`,
    specialistId,
    status === 'active' ? NOW : null,
    status === 'disabled' ? NOW : null,
    NOW,
    NOW,
  ).run()
  if (role === 'specialist') {
    await env.DB.prepare(
      `INSERT INTO specialists
       (id,staff_user_id,display_name_envelope,professional_title_envelope,
        standard_rate_grosze,status,version,archived_at,created_at,updated_at)
       VALUES (?,?,?,NULL,18000,?,1,?,?,?)`,
    ).bind(
      specialistId,
      id,
      await encrypted(specialistId, 'display_name', displayName ?? `Osoba ${suffix}`),
      status === 'disabled' ? 'archived' : status,
      status === 'disabled' ? NOW : null,
      NOW,
      NOW,
    ).run()
  }
  return Object.freeze({
    id,
    role,
    specialistId,
    status,
    version: 1,
    authorityRevision: 1,
    capabilities: ROLE_DEFAULT_CAPABILITIES[role],
  })
}

const ownerWithOverrides = (staff, allow = [], deny = []) => Object.freeze({
  id: staff.id,
  role: staff.role,
  specialistId: staff.specialistId,
  version: staff.version,
  authorityRevision: staff.authorityRevision,
  capabilities: effectiveCapabilitiesFor({ role: staff.role, allow, deny }),
})

const ids = (prefix) => {
  let count = 0
  return () => `${prefix}_${++count}`
}

const replace = (actor, staffId, input, options = {}) => replaceCapabilityOverrides({
  db: options.db ?? env.DB,
  recoveryDb: options.recoveryDb ?? env.DB,
  cryptoContext: context,
  actor,
  staffId,
  input,
  idempotencyKey: options.idempotencyKey ?? `capability-key-${staffId}`,
  correlationId: options.correlationId ?? '88888888-8888-4888-8888-888888888888',
  nowMs: options.nowMs ?? NOW_MS,
  idFactory: options.idFactory ?? ids(`capability_${staffId}`),
})

const batchBarrierDb = (participants = 2) => {
  let waiting = 0
  let release
  const ready = new Promise((resolve) => { release = resolve })
  return Object.freeze({
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements) {
      waiting += 1
      if (waiting === participants) release()
      await ready
      return env.DB.batch(statements)
    },
  })
}

const actorRevisionRaceDb = (actorId) => {
  let raced = false
  return Object.freeze({
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements) {
      if (!raced) {
        raced = true
        await env.DB.prepare(
          `UPDATE staff_authorities SET revision=revision+1,updated_at=?
           WHERE staff_id=? AND revision=1`,
        ).bind(NOW, actorId).run()
      }
      return env.DB.batch(statements)
    },
  })
}

const failingPostconditionDb = () => Object.freeze({
  prepare(sql) {
    const statement = String(sql).includes("'capability_override_postcondition'")
      ? String(sql).replace('WHERE NOT (', 'WHERE 1 OR NOT (')
      : sql
    return env.DB.prepare(statement)
  },
  batch: env.DB.batch.bind(env.DB),
})

beforeAll(async () => {
  await completeCoreDirectoryStageA()
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  const keyring = await createKeyring(env, {
    activeDataKekVersion: 1,
    activeLookupKeyVersion: 1,
    activeBackupKekVersion: 1,
  })
  const dataKey = await getOrCreateDataKey(env.DB, keyring, SCOPE, {
    id: 'key_capability_overrides',
    createdAt: NOW,
  })
  context = Object.freeze({ keyring, dataKey, scope: SCOPE })
})

describe('permissions target directory', () => {
  it('uses constitutional permission and returns only sorted minimal decrypted targets', async () => {
    const owner = await seedStaff({
      displayName: 'Żaneta Właścicielka', role: 'owner', suffix: 'list_owner',
    })
    const first = await seedStaff({
      displayName: 'Ądam Specjalista', role: 'specialist', suffix: 'list_first',
    })
    const second = await seedStaff({
      displayName: 'Zofia Koordynatorka', role: 'coordinator', suffix: 'list_second',
    })
    await env.DB.prepare(
      `INSERT INTO staff_capability_overrides
       (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
       VALUES (?,'staff.manage','deny',1,?,?,?)`,
    ).bind(owner.id, owner.id, NOW, NOW).run()
    const actor = ownerWithOverrides(owner, [], ['staff.manage'])

    const result = await listCapabilityTargets({
      db: env.DB,
      cryptoContext: context,
      actor,
      nowMs: NOW_MS,
    })

    const selected = result.data.targets.filter(({ staffId }) => (
      [owner.id, first.id, second.id].includes(staffId)
    ))
    expect(selected).toEqual([
      {
        staffId: first.id,
        displayName: 'Ądam Specjalista',
        role: 'specialist',
        status: 'active',
        authorityRevision: 1,
      },
      {
        staffId: second.id,
        displayName: 'Zofia Koordynatorka',
        role: 'coordinator',
        status: 'active',
        authorityRevision: 1,
      },
      {
        staffId: owner.id,
        displayName: 'Żaneta Właścicielka',
        role: 'owner',
        status: 'active',
        authorityRevision: 1,
      },
    ])
    for (const target of result.data.targets) {
      expect(Object.keys(target)).toEqual([
        'staffId', 'displayName', 'role', 'status', 'authorityRevision',
      ])
      expect(JSON.stringify(target)).not.toMatch(/email|subject|invitation/i)
    }
  })
})

describe('capability override read', () => {
  it('returns the exact normalized authority projection with decrypted display name', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'read_owner' })
    const target = await seedStaff({
      displayName: 'Cel Uprawnień', role: 'coordinator', suffix: 'read_target',
    })
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO staff_capability_overrides
         (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
         VALUES (?,'finance.import','allow',1,?,?,?)`,
      ).bind(target.id, owner.id, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO staff_capability_overrides
         (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
         VALUES (?,'client.manage','deny',1,?,?,?)`,
      ).bind(target.id, owner.id, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO staff_capability_overrides
         (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
         VALUES (?,'chat.general','cleared',1,?,?,?)`,
      ).bind(target.id, owner.id, NOW, NOW),
    ])

    const result = await getCapabilityOverrides({
      db: env.DB,
      cryptoContext: context,
      actor: ownerWithOverrides(owner),
      staffId: target.id,
      nowMs: NOW_MS,
    })

    expect(result).toEqual({
      data: {
        authority: {
          staffId: target.id,
          displayName: 'Cel Uprawnień',
          role: 'coordinator',
          status: 'active',
          authorityRevision: 1,
          allow: ['finance.import'],
          deny: ['client.manage'],
          effectiveCapabilities: [
            'appointment.charge.read',
            'appointment.manage',
            'chat.direct',
            'chat.general',
            'client.operational.read',
            'finance.centre.read',
            'finance.import',
            'operations.health.read',
            'payment.manage',
            'specialist.directory.read',
            'tus.manage',
            'workbook.centre.export',
          ],
        },
      },
    })
    expect(Object.keys(result.data.authority)).toEqual([
      'staffId', 'displayName', 'role', 'status', 'authorityRevision',
      'allow', 'deny', 'effectiveCapabilities',
    ])
    expect(JSON.stringify(result)).not.toMatch(/email|subject|invitation|envelope/i)
  })

  it('conceals missing identities and requires a current active owner snapshot', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'read_guard_owner' })
    const coordinator = await seedStaff({
      role: 'coordinator', suffix: 'read_guard_coordinator',
    })

    await expect(getCapabilityOverrides({
      db: env.DB,
      cryptoContext: context,
      actor: ownerWithOverrides(owner),
      staffId: 'stf_capability_absent',
      nowMs: NOW_MS,
    })).rejects.toMatchObject({ message: 'NOT_FOUND' })
    await expect(getCapabilityOverrides({
      db: env.DB,
      cryptoContext: context,
      actor: ownerWithOverrides(owner),
      staffId: '../outside',
      nowMs: NOW_MS,
    })).rejects.toMatchObject({ message: 'NOT_FOUND' })
    for (const operation of [
      () => listCapabilityTargets({
        db: env.DB,
        cryptoContext: context,
        actor: ownerWithOverrides(coordinator),
        nowMs: NOW_MS,
      }),
      () => getCapabilityOverrides({
        db: env.DB,
        cryptoContext: context,
        actor: ownerWithOverrides(coordinator),
        staffId: owner.id,
        nowMs: NOW_MS,
      }),
      () => getCapabilityOverrides({
        db: env.DB,
        cryptoContext: context,
        actor: Object.freeze({ ...ownerWithOverrides(owner), authorityRevision: 2 }),
        staffId: coordinator.id,
        nowMs: NOW_MS,
      }),
    ]) await expect(operation()).rejects.toMatchObject({ message: 'FORBIDDEN' })
  })

  it('fails closed on corrupt encrypted presentation and hostile stored escalation', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'corrupt_owner' })
    const corruptName = await seedStaff({
      role: 'coordinator', suffix: 'corrupt_display_name',
    })
    const escalated = await seedStaff({
      role: 'coordinator', suffix: 'corrupt_escalation',
    })
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE staff_users
         SET display_name_envelope='not-json',version=version+1,updated_at=?
         WHERE id=? AND version=1`,
      ).bind(NOW, corruptName.id),
      env.DB.prepare(
        `INSERT INTO staff_capability_overrides
         (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
         VALUES (?,'backup.manage','allow',1,?,?,?)`,
      ).bind(escalated.id, owner.id, NOW, NOW),
    ])
    const actor = ownerWithOverrides(owner)

    await expect(getCapabilityOverrides({
      db: env.DB,
      cryptoContext: context,
      actor,
      staffId: corruptName.id,
      nowMs: NOW_MS,
    })).rejects.toMatchObject({ message: 'CRYPTO_FAILURE' })
    await expect(getCapabilityOverrides({
      db: env.DB,
      cryptoContext: context,
      actor,
      staffId: escalated.id,
      nowMs: NOW_MS,
    })).rejects.toMatchObject({ message: 'INTERNAL_ERROR' })
    await expect(replace(actor, escalated.id, {
      expectedAuthorityRevision: 1,
      allow: [],
      deny: [],
    }, {
      idempotencyKey: 'capability-corrupt-escalation',
    })).rejects.toMatchObject({ message: 'INTERNAL_ERROR' })
  })
})

describe('capability override replacement', () => {
  it('normalizes one complete replacement and commits current, history, revisions, audit, and replay atomically', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'replace_owner' })
    const target = await seedStaff({
      displayName: 'Koordynatorka Zmieniana',
      role: 'coordinator',
      suffix: 'replace_target',
    })

    const result = await replace(ownerWithOverrides(owner), target.id, {
      expectedAuthorityRevision: 1,
      allow: ['finance.import', 'client.manage', 'finance.import'],
      deny: ['client.manage', 'client.manage'],
    }, {
      idempotencyKey: 'capability-replace-happy',
      idFactory: ids('replace_happy'),
    })

    expect(result).toEqual({
      data: {
        authority: {
          staffId: target.id,
          displayName: 'Koordynatorka Zmieniana',
          role: 'coordinator',
          status: 'active',
          authorityRevision: 2,
          allow: ['finance.import'],
          deny: ['client.manage'],
          effectiveCapabilities: [
            'appointment.charge.read',
            'appointment.manage',
            'chat.direct',
            'chat.general',
            'client.operational.read',
            'finance.centre.read',
            'finance.import',
            'operations.health.read',
            'payment.manage',
            'specialist.directory.read',
            'tus.manage',
            'workbook.centre.export',
          ],
        },
      },
    })
    expect(await env.DB.prepare(
      `SELECT staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at
       FROM staff_capability_overrides WHERE staff_id=? ORDER BY capability`,
    ).bind(target.id).all()).toMatchObject({
      results: [
        {
          staff_id: target.id,
          capability: 'client.manage',
          decision: 'deny',
          version: 1,
          changed_by_staff_id: owner.id,
          created_at: NOW,
          updated_at: NOW,
        },
        {
          staff_id: target.id,
          capability: 'finance.import',
          decision: 'allow',
          version: 1,
          changed_by_staff_id: owner.id,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    })
    expect(await env.DB.prepare(
      `SELECT staff_id,capability,role_at_change,decision,override_version,
              authority_revision,changed_by_staff_id,reason,changed_at
       FROM staff_capability_override_history WHERE staff_id=? ORDER BY capability`,
    ).bind(target.id).all()).toMatchObject({
      results: [
        {
          staff_id: target.id,
          capability: 'client.manage',
          role_at_change: 'coordinator',
          decision: 'deny',
          override_version: 1,
          authority_revision: 2,
          changed_by_staff_id: owner.id,
          reason: 'owner_update',
          changed_at: NOW,
        },
        {
          staff_id: target.id,
          capability: 'finance.import',
          role_at_change: 'coordinator',
          decision: 'allow',
          override_version: 1,
          authority_revision: 2,
          changed_by_staff_id: owner.id,
          reason: 'owner_update',
          changed_at: NOW,
        },
      ],
    })
    expect(await env.DB.prepare(
      `SELECT staff_id,revision,updated_at FROM staff_authorities
       WHERE staff_id IN (?,?) ORDER BY staff_id`,
    ).bind(owner.id, target.id).all()).toMatchObject({
      results: [
        { staff_id: owner.id, revision: 2, updated_at: NOW },
        { staff_id: target.id, revision: 2, updated_at: NOW },
      ].sort((left, right) => left.staff_id.localeCompare(right.staff_id)),
    })
    const audit = await env.DB.prepare(
      `SELECT actor_staff_id,entity_type,entity_id,result,reason_envelope,
              correlation_id,metadata_json
       FROM audit_events WHERE action='staff.capabilities.updated' AND entity_id=?`,
    ).bind(target.id).first()
    expect(audit).toEqual({
      actor_staff_id: owner.id,
      entity_type: 'staff_user',
      entity_id: target.id,
      result: 'success',
      reason_envelope: null,
      correlation_id: '88888888-8888-4888-8888-888888888888',
      metadata_json: JSON.stringify({
        actorAuthorityRevision: 2,
        allowCount: 1,
        denyCount: 1,
        targetAuthorityRevision: 2,
      }),
    })
    expect(await env.DB.prepare(
      `SELECT actor_id,operation,idempotency_key,resource_type,resource_id
       FROM idempotency_records WHERE actor_id=? AND operation='staff.capabilities.update'`,
    ).bind(owner.id).all()).toMatchObject({
      results: [{
        actor_id: owner.id,
        operation: 'staff.capabilities.update',
        idempotency_key: 'capability-replace-happy',
        resource_type: 'staff_authority',
        resource_id: target.id,
      }],
    })
    expect(JSON.stringify(result)).not.toMatch(/email|subject|invitation|envelope/i)
  })

  it('continues per-capability history and retains cleared current tombstones', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'chain_owner' })
    const target = await seedStaff({ role: 'coordinator', suffix: 'chain_target' })
    const firstActor = ownerWithOverrides(owner)
    await replace(firstActor, target.id, {
      expectedAuthorityRevision: 1,
      allow: ['finance.import'],
      deny: ['client.manage'],
    }, {
      idempotencyKey: 'capability-chain-first',
      idFactory: ids('chain_first'),
    })
    const secondActor = Object.freeze({ ...firstActor, authorityRevision: 2 })
    const laterMs = NOW_MS + 60_000
    const later = new Date(laterMs).toISOString()

    const result = await replace(secondActor, target.id, {
      expectedAuthorityRevision: 2,
      allow: [],
      deny: ['appointment.manage'],
    }, {
      idempotencyKey: 'capability-chain-second',
      idFactory: ids('chain_second'),
      nowMs: laterMs,
    })

    expect(result.data.authority).toMatchObject({
      authorityRevision: 3,
      allow: [],
      deny: ['appointment.manage'],
    })
    expect(await env.DB.prepare(
      `SELECT capability,decision,version,created_at,updated_at
       FROM staff_capability_overrides WHERE staff_id=? ORDER BY capability`,
    ).bind(target.id).all()).toMatchObject({
      results: [
        {
          capability: 'appointment.manage', decision: 'deny', version: 1,
          created_at: later, updated_at: later,
        },
        {
          capability: 'client.manage', decision: 'cleared', version: 2,
          created_at: NOW, updated_at: later,
        },
        {
          capability: 'finance.import', decision: 'cleared', version: 2,
          created_at: NOW, updated_at: later,
        },
      ],
    })
    expect(await env.DB.prepare(
      `SELECT capability,decision,override_version,authority_revision,reason
       FROM staff_capability_override_history WHERE staff_id=?
       ORDER BY capability,override_version`,
    ).bind(target.id).all()).toMatchObject({
      results: [
        {
          capability: 'appointment.manage', decision: 'deny', override_version: 1,
          authority_revision: 3, reason: 'owner_update',
        },
        {
          capability: 'client.manage', decision: 'deny', override_version: 1,
          authority_revision: 2, reason: 'owner_update',
        },
        {
          capability: 'client.manage', decision: 'cleared', override_version: 2,
          authority_revision: 3, reason: 'owner_update',
        },
        {
          capability: 'finance.import', decision: 'allow', override_version: 1,
          authority_revision: 2, reason: 'owner_update',
        },
        {
          capability: 'finance.import', decision: 'cleared', override_version: 2,
          authority_revision: 3, reason: 'owner_update',
        },
      ],
    })
  })

  it('bumps a self-targeting owner authority exactly once and preserves constitutional access', async () => {
    const owner = await seedStaff({
      displayName: 'Właścicielka Samodzielna', role: 'owner', suffix: 'self_owner',
    })

    const result = await replace(ownerWithOverrides(owner), owner.id, {
      expectedAuthorityRevision: 1,
      allow: [],
      deny: ['staff.manage'],
    }, {
      idempotencyKey: 'capability-self-target',
      idFactory: ids('self_target'),
    })

    expect(result.data.authority).toMatchObject({
      staffId: owner.id,
      authorityRevision: 2,
      allow: [],
      deny: ['staff.manage'],
    })
    expect(result.data.authority.effectiveCapabilities).toContain('permissions.manage')
    expect(result.data.authority.effectiveCapabilities).not.toContain('staff.manage')
    expect(await env.DB.prepare(
      'SELECT revision,updated_at FROM staff_authorities WHERE staff_id=?',
    ).bind(owner.id).first()).toEqual({ revision: 2, updated_at: NOW })
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action='staff.capabilities.updated' AND entity_id=?`,
    ).bind(owner.id).first()
    expect(JSON.parse(audit.metadata_json)).toEqual({
      actorAuthorityRevision: 2,
      allowCount: 0,
      denyCount: 1,
      targetAuthorityRevision: 2,
    })
  })

  it('returns one exact same-key replay and rejects a changed request without new residue', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'replay_owner' })
    const target = await seedStaff({ role: 'coordinator', suffix: 'replay_target' })
    const input = {
      expectedAuthorityRevision: 1,
      allow: ['finance.import'],
      deny: ['client.manage'],
    }
    const options = {
      idempotencyKey: 'capability-exact-replay',
      idFactory: ids('exact_replay'),
    }
    const first = await replace(ownerWithOverrides(owner), target.id, input, options)
    const refreshedActor = ownerWithOverrides({ ...owner, authorityRevision: 2 })

    const replay = await replace(refreshedActor, target.id, input, {
      ...options,
      idFactory: () => { throw new Error('replay must not allocate ids') },
    })

    expect(replay).toEqual(first)
    await expect(replace(refreshedActor, target.id, {
      ...input,
      deny: ['appointment.manage'],
    }, options)).rejects.toMatchObject({ message: 'IDEMPOTENCY_CONFLICT' })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='staff.capabilities.updated' AND entity_id=?`,
    ).bind(target.id).first()).toEqual({ count: 1 })
    expect(await env.DB.prepare(
      'SELECT count(*) AS count FROM staff_capability_override_history WHERE staff_id=?',
    ).bind(target.id).first()).toEqual({ count: 2 })
    expect(await env.DB.prepare(
      `SELECT staff_id,revision FROM staff_authorities
       WHERE staff_id IN (?,?) ORDER BY staff_id`,
    ).bind(owner.id, target.id).all()).toMatchObject({
      results: [
        { staff_id: owner.id, revision: 2 },
        { staff_id: target.id, revision: 2 },
      ].sort((left, right) => left.staff_id.localeCompare(right.staff_id)),
    })
  })

  it('allows one different-key concurrent winner and reports the current authority revision', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'race_owner' })
    const target = await seedStaff({ role: 'coordinator', suffix: 'race_target' })
    const actor = ownerWithOverrides(owner)
    const db = batchBarrierDb()

    const outcomes = await Promise.allSettled([
      replace(actor, target.id, {
        expectedAuthorityRevision: 1,
        allow: ['finance.import'],
        deny: [],
      }, {
        db,
        idempotencyKey: 'capability-race-first',
        idFactory: ids('race_first'),
      }),
      replace(actor, target.id, {
        expectedAuthorityRevision: 1,
        allow: [],
        deny: ['appointment.manage'],
      }, {
        db,
        idempotencyKey: 'capability-race-second',
        idFactory: ids('race_second'),
      }),
    ])

    const fulfilled = outcomes.filter(({ status }) => status === 'fulfilled')
    const rejected = outcomes.filter(({ status }) => status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({
      message: 'VERSION_CONFLICT',
      details: { currentVersion: 2 },
    })
    const authority = fulfilled[0].value.data.authority
    expect(authority.authorityRevision).toBe(2)
    expect(await env.DB.prepare(
      `SELECT capability,decision FROM staff_capability_overrides
       WHERE staff_id=? AND decision IN ('allow','deny') ORDER BY capability`,
    ).bind(target.id).all()).toMatchObject({
      results: [
        ...authority.allow.map((capability) => ({ capability, decision: 'allow' })),
        ...authority.deny.map((capability) => ({ capability, decision: 'deny' })),
      ].sort((left, right) => left.capability.localeCompare(right.capability)),
    })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='staff.capabilities.updated' AND entity_id=?`,
    ).bind(target.id).first()).toEqual({ count: 1 })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM idempotency_records
       WHERE actor_id=? AND operation='staff.capabilities.update'`,
    ).bind(owner.id).first()).toEqual({ count: 1 })
    expect(await env.DB.prepare(
      `SELECT staff_id,revision FROM staff_authorities
       WHERE staff_id IN (?,?) ORDER BY staff_id`,
    ).bind(owner.id, target.id).all()).toMatchObject({
      results: [
        { staff_id: owner.id, revision: 2 },
        { staff_id: target.id, revision: 2 },
      ].sort((left, right) => left.staff_id.localeCompare(right.staff_id)),
    })
  })

  it('recovers two concurrent same-key requests as one exact mutation', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'same_race_owner' })
    const target = await seedStaff({ role: 'coordinator', suffix: 'same_race_target' })
    const actor = ownerWithOverrides(owner)
    const db = batchBarrierDb()
    const input = {
      expectedAuthorityRevision: 1,
      allow: ['finance.import'],
      deny: ['client.manage'],
    }

    const outcomes = await Promise.all([
      replace(actor, target.id, input, {
        db,
        idempotencyKey: 'capability-same-key-race',
        idFactory: ids('same_race_first'),
      }),
      replace(actor, target.id, input, {
        db,
        idempotencyKey: 'capability-same-key-race',
        idFactory: ids('same_race_second'),
      }),
    ])

    expect(outcomes[1]).toEqual(outcomes[0])
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='staff.capabilities.updated' AND entity_id=?`,
    ).bind(target.id).first()).toEqual({ count: 1 })
    expect(await env.DB.prepare(
      'SELECT count(*) AS count FROM staff_capability_override_history WHERE staff_id=?',
    ).bind(target.id).first()).toEqual({ count: 2 })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM idempotency_records
       WHERE actor_id=? AND operation='staff.capabilities.update'
         AND idempotency_key='capability-same-key-race'`,
    ).bind(owner.id).first()).toEqual({ count: 1 })
  })

  it('CAS-rejects actor authority drift without leaving target mutation residue', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'actor_cas_owner' })
    const target = await seedStaff({ role: 'coordinator', suffix: 'actor_cas_target' })

    await expect(replace(ownerWithOverrides(owner), target.id, {
      expectedAuthorityRevision: 1,
      allow: ['finance.import'],
      deny: [],
    }, {
      db: actorRevisionRaceDb(owner.id),
      idempotencyKey: 'capability-actor-cas-race',
      idFactory: ids('actor_cas'),
    })).rejects.toMatchObject({
      message: 'VERSION_CONFLICT',
      details: { currentVersion: 1 },
    })
    expect(await env.DB.prepare(
      `SELECT staff_id,revision FROM staff_authorities
       WHERE staff_id IN (?,?) ORDER BY staff_id`,
    ).bind(owner.id, target.id).all()).toMatchObject({
      results: [
        { staff_id: owner.id, revision: 2 },
        { staff_id: target.id, revision: 1 },
      ].sort((left, right) => left.staff_id.localeCompare(right.staff_id)),
    })
    expect(await env.DB.prepare(
      'SELECT count(*) AS count FROM staff_capability_overrides WHERE staff_id=?',
    ).bind(target.id).first()).toEqual({ count: 0 })
    expect(await env.DB.prepare(
      'SELECT count(*) AS count FROM staff_capability_override_history WHERE staff_id=?',
    ).bind(target.id).first()).toEqual({ count: 0 })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='staff.capabilities.updated' AND entity_id=?`,
    ).bind(target.id).first()).toEqual({ count: 0 })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM idempotency_records
       WHERE actor_id=? AND operation='staff.capabilities.update'`,
    ).bind(owner.id).first()).toEqual({ count: 0 })
  })

  it('rolls back every fact when the final exact postcondition is forced to fail', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'rollback_owner' })
    const target = await seedStaff({ role: 'coordinator', suffix: 'rollback_target' })
    const beforeAuthorities = (await env.DB.prepare(
      `SELECT staff_id,revision,updated_at FROM staff_authorities
       WHERE staff_id IN (?,?) ORDER BY staff_id`,
    ).bind(owner.id, target.id).all()).results

    await expect(replace(ownerWithOverrides(owner), target.id, {
      expectedAuthorityRevision: 1,
      allow: ['finance.import'],
      deny: ['client.manage'],
    }, {
      db: failingPostconditionDb(),
      idempotencyKey: 'capability-final-guard-failure',
      idFactory: ids('final_guard'),
    })).rejects.toThrow(/core_directory_invariant_failed/)

    expect((await env.DB.prepare(
      `SELECT staff_id,revision,updated_at FROM staff_authorities
       WHERE staff_id IN (?,?) ORDER BY staff_id`,
    ).bind(owner.id, target.id).all()).results).toEqual(beforeAuthorities)
    expect(await env.DB.prepare(
      'SELECT count(*) AS count FROM staff_capability_overrides WHERE staff_id=?',
    ).bind(target.id).first()).toEqual({ count: 0 })
    expect(await env.DB.prepare(
      'SELECT count(*) AS count FROM staff_capability_override_history WHERE staff_id=?',
    ).bind(target.id).first()).toEqual({ count: 0 })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='staff.capabilities.updated' AND entity_id=?`,
    ).bind(target.id).first()).toEqual({ count: 0 })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM idempotency_records
       WHERE actor_id=? AND operation='staff.capabilities.update'`,
    ).bind(owner.id).first()).toEqual({ count: 0 })
  })

  it('strictly rejects malformed and ceiling-escaping replacements before mutation', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'strict_owner' })
    const coordinator = await seedStaff({ role: 'coordinator', suffix: 'strict_target' })
    const specialist = await seedStaff({ role: 'specialist', suffix: 'strict_specialist' })
    const actor = ownerWithOverrides(owner)
    const cases = [
      {
        staffId: coordinator.id,
        input: { expectedAuthorityRevision: 1, allow: [], deny: [], extra: true },
        field: 'body',
      },
      {
        staffId: coordinator.id,
        input: { allow: [], deny: [] },
        field: 'body',
      },
      {
        staffId: coordinator.id,
        input: Object.defineProperty({ allow: [], deny: [] }, 'expectedAuthorityRevision', {
          enumerable: true,
          get: () => 1,
        }),
        field: 'body',
      },
      {
        staffId: coordinator.id,
        input: { expectedAuthorityRevision: 0, allow: [], deny: [] },
        field: 'expectedAuthorityRevision',
      },
      {
        staffId: coordinator.id,
        input: { expectedAuthorityRevision: 1, allow: ['unknown.manage'], deny: [] },
        field: 'allow',
      },
      {
        staffId: coordinator.id,
        input: { expectedAuthorityRevision: 1, allow: ['backup.manage'], deny: [] },
        field: 'allow',
      },
      {
        staffId: specialist.id,
        input: { expectedAuthorityRevision: 1, allow: ['finance.import'], deny: [] },
        field: 'allow',
      },
      {
        staffId: owner.id,
        input: { expectedAuthorityRevision: 1, allow: [], deny: ['permissions.manage'] },
        field: 'deny',
      },
      {
        staffId: coordinator.id,
        input: { expectedAuthorityRevision: 1, allow: [], deny: {} },
        field: 'deny',
      },
    ]

    for (const entry of cases) {
      await expect(replace(actor, entry.staffId, entry.input, {
        idempotencyKey: 'capability-strict-input',
        idFactory: ids(`strict_${entry.field}`),
      })).rejects.toMatchObject({
        message: 'VALIDATION_FAILED',
        details: { field: entry.field },
      })
    }
    await expect(replace(actor, coordinator.id, {
      expectedAuthorityRevision: 1,
      allow: [],
      deny: [],
    }, {
      correlationId: 'not-a-correlation-id',
      idempotencyKey: 'capability-strict-correlation',
      idFactory: ids('strict_correlation'),
    })).rejects.toMatchObject({
      message: 'VALIDATION_FAILED',
      details: { field: 'body' },
    })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM audit_events
       WHERE action='staff.capabilities.updated'
         AND entity_id IN (?,?,?)`,
    ).bind(owner.id, coordinator.id, specialist.id).first()).toEqual({ count: 0 })
    expect(await env.DB.prepare(
      `SELECT count(*) AS count FROM staff_capability_override_history
       WHERE staff_id IN (?,?,?)`,
    ).bind(owner.id, coordinator.id, specialist.id).first()).toEqual({ count: 0 })
    expect(await env.DB.prepare(
      `SELECT min(revision) AS minimum,max(revision) AS maximum
       FROM staff_authorities WHERE staff_id IN (?,?,?)`,
    ).bind(owner.id, coordinator.id, specialist.id).first()).toEqual({
      minimum: 1,
      maximum: 1,
    })
  })

  it('preserves only the override contract validation fields at the HTTP boundary', () => {
    for (const field of ['allow', 'deny', 'expectedAuthorityRevision']) {
      const source = new Error('VALIDATION_FAILED')
      source.details = { field }
      expect(publicError(source)).toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 400,
        details: { field },
      })
    }
  })

  it('conceals unavailable mutation targets and denies non-owner mutation actors', async () => {
    const owner = await seedStaff({ role: 'owner', suffix: 'mutation_guard_owner' })
    const coordinator = await seedStaff({
      role: 'coordinator', suffix: 'mutation_guard_coordinator',
    })
    const disabled = await seedStaff({
      role: 'coordinator', status: 'disabled', suffix: 'mutation_guard_disabled',
    })
    const body = { expectedAuthorityRevision: 1, allow: [], deny: [] }

    await expect(replace(ownerWithOverrides(coordinator), owner.id, body, {
      idempotencyKey: 'capability-non-owner-denied',
    })).rejects.toMatchObject({ message: 'FORBIDDEN' })
    for (const staffId of ['stf_capability_absent_mutation', disabled.id, '../outside']) {
      await expect(replace(ownerWithOverrides(owner), staffId, body, {
        idempotencyKey: 'capability-unavailable-target',
      })).rejects.toMatchObject({ message: 'NOT_FOUND' })
    }
  })
})
