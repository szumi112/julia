import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  archiveClient,
  createClient,
  digestArchiveClientRequest,
  digestCreateClientRequest,
  digestEditClientRequest,
  editClient,
  validateArchiveClientBody,
  validateCreateClientBody,
  validateEditClientBody,
} from '../../worker/core/clients.js'
import { postClient, postClientArchive, postClientEdit } from '../../worker/routes/clients.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  decryptForScope,
  encryptForScope,
  getOrCreateDataKey,
  loadDataKey,
} from '../../worker/security/envelope.js'
import {
  buildClientDataKey,
  clientKeyScope,
  encryptClientIdentity,
} from '../../worker/core/crypto.js'
import { createD1QueryBudget, usageForD1QueryBudgetViews } from '../../worker/db/query-budget.js'
import { createApp } from '../../worker/app.js'
import {
  applyCoreDirectoryStageB,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'

const NOW_MS = 1_800_000_000_000
const BODY = Object.freeze({
  name: 'Fikcyjna', age: 12, status: 'active', specialistId: 'sp_target',
})

describe('persistent client archive', () => {
  let sequence = 0
  const actor = Object.freeze({ id: 'stf_client_owner', role: 'owner', specialistId: null })
  const seed = async ({ status = 'active', specialistId = 'sp_target', createdBy = actor } = {}) => {
    sequence += 1
    const marker = `archive_fixture_${sequence}`
    const ids = [`${marker}_client`, `${marker}_assignment`, `${marker}_client_ver`,
      `${marker}_assignment_ver`, `${marker}_audit`, `${marker}_key`]
    return (await createClient({
      db: env.DB, recoveryDb: env.DB, actor: createdBy, keyring: await ring(),
      nowMs: NOW_MS, correlationId: CORRELATION_ID, idFactory: () => ids.shift(),
      body: { ...BODY, status, specialistId }, idempotencyKey: `${marker}-create-key`,
    })).body.data.client
  }
  const archive = async (client, overrides = {}) => {
    const marker = `archive_command_${++sequence}`
    const ids = [`${marker}_client_ver`, `${marker}_assignment_ver`, `${marker}_audit`]
    return archiveClient({
      db: env.DB, recoveryDb: env.DB, actor, keyring: await ring(),
      nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => ids.shift(), clientId: client.id,
      body: { expectedVersion: client.version },
      idempotencyKey: `${marker}-key`, ...overrides,
    })
  }
  const addHistoricalAssignment = async (client, kind) => {
    const keyring = await ring()
    const clientRow = await env.DB.prepare('SELECT identity_envelope FROM clients WHERE id=?')
      .bind(client.id).first()
    const scope = clientKeyScope(client.id)
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(clientRow.identity_envelope), expectedScope: scope,
    })
    const id = `asg_archive_history_${++sequence}`
    const startsAt = new Date(NOW_MS - 20_000).toISOString()
    const endsAt = new Date(NOW_MS - 10_000).toISOString()
    const version = kind === 'missing' ? 1 : 2
    await env.DB.prepare(
      `INSERT INTO client_assignments
       (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
        version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(id, client.id, 'sp_target', startsAt, endsAt, 'stf_client_owner',
      version, startsAt, endsAt).run()
    if (kind === 'missing') return
    const snapshotVersions = kind === 'noncontiguous' ? [2] : [1, 2]
    for (const snapshotVersion of snapshotVersions) {
      const plaintext = JSON.stringify({
        assignedByStaffId: 'stf_client_owner',
        clientId: kind === 'corrupt' && snapshotVersion === 2
          ? 'cl_archive_corrupt' : client.id,
        createdAt: startsAt, endsAt: snapshotVersion === 2 ? endsAt : null, id,
        schema: 'client_assignment.v1', specialistId: 'sp_target', startsAt,
        updatedAt: snapshotVersion === 2 ? endsAt : startsAt, version: snapshotVersion,
      })
      const envelope = await encryptForScope(keyring, dataKey, {
        expectedScope: scope, recordId: id, field: 'record_version', plaintext,
      })
      if (kind === 'wrong-key' && snapshotVersion === 2) {
        envelope.dataKeyId = `key_archive_wrong_${sequence}`
      }
      await env.DB.prepare(
        `INSERT INTO record_versions
         (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
          changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`
      ).bind(`ver_archive_history_${sequence}_${snapshotVersion}`, 'client_assignment', id,
        snapshotVersion, JSON.stringify(envelope), 'stf_client_owner',
        snapshotVersion === 2 ? endsAt : startsAt, CORRELATION_ID).run()
    }
  }

  it('strictly captures one expected version and binds its digest to the target', async () => {
    expect(validateArchiveClientBody({ expectedVersion: 1 })).toEqual({ expectedVersion: 1 })
    for (const body of [{ expectedVersion: 0 }, { expectedVersion: 1, extra: true }]) {
      expect(() => validateArchiveClientBody(body)).toThrow('VALIDATION_FAILED')
    }
    const getter = vi.fn(() => 1)
    const hostile = Object.defineProperty({}, 'expectedVersion', { enumerable: true, get: getter })
    expect(() => validateArchiveClientBody(hostile)).toThrow('VALIDATION_FAILED/body')
    expect(getter).not.toHaveBeenCalled()
    const digest = await digestArchiveClientRequest('cl_archive_digest', { expectedVersion: 1 })
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await digestArchiveClientRequest('cl_archive_digest', { expectedVersion: 2 }))
      .not.toBe(digest)
    expect(await digestArchiveClientRequest('cl_archive_other', { expectedVersion: 1 }))
      .not.toBe(digest)
  })

  it('archives active and paused centre clients while closing only the current assignment', async () => {
    for (const status of ['active', 'paused']) {
      const client = await seed({ status })
      const beforeLedger = {
        appointments: (await env.DB.prepare('SELECT * FROM appointments WHERE client_id=?').bind(client.id).all()).results,
        charges: (await env.DB.prepare(`SELECT charge.* FROM session_charges charge JOIN appointments appointment ON appointment.id=charge.appointment_id WHERE appointment.client_id=?`).bind(client.id).all()).results,
        payments: (await env.DB.prepare(`SELECT payment.* FROM payment_entries payment JOIN appointments appointment ON appointment.id=payment.appointment_id WHERE appointment.client_id=?`).bind(client.id).all()).results,
        corrections: (await env.DB.prepare(`SELECT correction.* FROM payment_corrections correction JOIN payment_entries payment ON payment.id=correction.reversed_entry_id JOIN appointments appointment ON appointment.id=payment.appointment_id WHERE appointment.client_id=?`).bind(client.id).all()).results,
      }
      const result = await archive(client)
      expect(result).toEqual({ status: 200, body: { data: { client: {
        ...client, status: 'archived', version: 2,
        archivedAt: new Date(NOW_MS + 1_000).toISOString(),
        updatedAt: new Date(NOW_MS + 1_000).toISOString(), readOnly: true, assignment: null,
      } } } })
      expect(await env.DB.prepare('SELECT status,version,archived_at FROM clients WHERE id=?').bind(client.id).first())
        .toEqual({ status: 'archived', version: 2, archived_at: new Date(NOW_MS + 1_000).toISOString() })
      expect(await env.DB.prepare('SELECT ends_at,version FROM client_assignments WHERE id=?').bind(client.assignment.id).first())
        .toEqual({ ends_at: new Date(NOW_MS + 1_000).toISOString(), version: 2 })
      expect((await env.DB.prepare('SELECT version FROM record_versions WHERE entity_id=? ORDER BY version').bind(client.id).all()).results)
        .toEqual([{ version: 1 }, { version: 2 }])
      expect((await env.DB.prepare('SELECT version FROM record_versions WHERE entity_id=? ORDER BY version').bind(client.assignment.id).all()).results)
        .toEqual([{ version: 1 }, { version: 2 }])
      const audit = await env.DB.prepare("SELECT action,metadata_json FROM audit_events WHERE entity_id=? AND action='client.archived'").bind(client.id).first()
      expect(audit).toEqual({ action: 'client.archived', metadata_json: JSON.stringify({ assignmentId: client.assignment.id, assignmentVersion: 2, clientVersion: 2 }) })
      const afterLedger = {
        appointments: (await env.DB.prepare('SELECT * FROM appointments WHERE client_id=?').bind(client.id).all()).results,
        charges: (await env.DB.prepare(`SELECT charge.* FROM session_charges charge JOIN appointments appointment ON appointment.id=charge.appointment_id WHERE appointment.client_id=?`).bind(client.id).all()).results,
        payments: (await env.DB.prepare(`SELECT payment.* FROM payment_entries payment JOIN appointments appointment ON appointment.id=payment.appointment_id WHERE appointment.client_id=?`).bind(client.id).all()).results,
        corrections: (await env.DB.prepare(`SELECT correction.* FROM payment_corrections correction JOIN payment_entries payment ON payment.id=correction.reversed_entry_id JOIN appointments appointment ON appointment.id=payment.appointment_id WHERE appointment.client_id=?`).bind(client.id).all()).results,
      }
      expect(afterLedger).toEqual(beforeLedger)
    }
  })

  it('blocks exact-time and future non-cancelled appointments but permits past and cancelled', async () => {
    for (const [offset, status, blocked] of [[1_000, 'scheduled', true], [60_000, 'completed', true], [-1, 'completed', false], [60_000, 'cancelled', false]]) {
      const client = await seed()
      const startsAt = new Date(NOW_MS + offset).toISOString()
      const endsAt = new Date(NOW_MS + offset + 60_000).toISOString()
      await env.DB.prepare(`INSERT INTO appointments (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,status,source,version,cancelled_at,created_at,updated_at) VALUES (?,?,?,?,? ,?,'Europe/Warsaw',NULL,?,'panel',1,?,?,?)`).bind(
        `apt_archive_${sequence}_${status}`, client.id, 'sp_target', 'zajecia', startsAt, endsAt,
        status, status === 'cancelled' ? startsAt : null, new Date(NOW_MS).toISOString(), new Date(NOW_MS).toISOString(),
      ).run()
      const operation = archive(client)
      if (blocked) await expect(operation).rejects.toThrow('CLIENT_ARCHIVE_CONFLICT')
      else expect((await operation).status).toBe(200)
    }
  })

  it('keeps stale, archived, absent, cross-specialist, and paused specialist targets opaque', async () => {
    const stale = await seed()
    await expect(archive(stale, { body: { expectedVersion: 2 } })).rejects.toMatchObject({
      message: 'VERSION_CONFLICT', details: { currentVersion: 1 },
    })
    const archived = await seed(); await archive(archived)
    const cross = await seed()
    const paused = await seed({ status: 'paused' })
    const specialist = { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' }
    for (const client of [archived, { id: 'cl_archive_absent', version: 1 }, cross, paused]) {
      await expect(archive(client, { actor: specialist, idFactory: vi.fn(),
        idempotencyKey: `archive-opaque-${++sequence}-key` })).rejects.toThrow('NOT_FOUND')
    }
  })

  it('allows a specialist to archive only their active singly assigned client', async () => {
    const specialist = { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' }
    const client = await seed({ specialistId: 'sp_client_self', createdBy: specialist })
    expect((await archive(client, { actor: specialist })).body.data.client.status).toBe('archived')
  })

  it('allows the coordinator centre role to archive an assigned client', async () => {
    const client = await seed()
    const coordinator = { id: 'stf_client_coord', role: 'coordinator', specialistId: null }
    expect((await archive(client, { actor: coordinator })).body.data.client.status).toBe('archived')
  })

  it('allows centre roles to archive clients assigned to a retained disabled practitioner', async () => {
    const client = await seed({ specialistId: 'sp_archive_retained' })
    const visitAt = new Date(NOW_MS - 3_600_000).toISOString()
    const visitEnd = new Date(NOW_MS - 3_000_000).toISOString()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO appointments
        (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
         status,source,version,cancelled_at,created_at,updated_at)
        VALUES ('apt_archive_workspace',?,?,'zajecia',?,?,'Europe/Warsaw',NULL,
         'completed','panel',1,NULL,?,?)`).bind(
        client.id, 'sp_archive_retained', visitAt, visitEnd,
        new Date(NOW_MS - 7_200_000).toISOString(), visitEnd,
      ),
      env.DB.prepare(`INSERT INTO session_charges
        (id,appointment_id,service_id,expected_amount_grosze,currency,version,created_at,updated_at)
        VALUES ('chg_archive_workspace','apt_archive_workspace','zajecia',18000,'PLN',1,?,?)`
      ).bind(new Date(NOW_MS - 7_200_000).toISOString(), visitEnd),
    ])
    const disabledAt = new Date(NOW_MS + 500).toISOString()
    await env.DB.batch([
      env.DB.prepare("UPDATE staff_users SET status='disabled',version=2,disabled_at=?,updated_at=? WHERE id='stf_archive_retained'").bind(disabledAt, disabledAt),
      env.DB.prepare("UPDATE specialists SET status='archived',version=2,archived_at=?,updated_at=? WHERE id='sp_archive_retained'").bind(disabledAt, disabledAt),
      env.DB.prepare(`INSERT INTO record_versions
        (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,changed_at,correlation_id)
        VALUES ('ver_archive_disabled_practitioner','specialist','sp_archive_retained',2,'{}','stf_client_owner',?,?)`).bind(disabledAt, CORRELATION_ID),
    ])
    expect((await archive(client)).body.data.client.status).toBe('archived')
    const keyring = await ring()
    const staffScope = { type: 'staff_directory', id: 'centre_archive_workspace', purpose: 'identity' }
    const staffKey = await getOrCreateDataKey(env.DB, keyring, staffScope, {
      id: 'key_archive_workspace_staff', createdAt: new Date(NOW_MS).toISOString(),
    })
    for (const [staffId, name] of [
      ['stf_client_target', 'Fikcyjny Cel'],
      ['stf_client_self', 'Fikcyjna Specjalistka'],
    ]) {
      const envelope = await encryptForScope(keyring, staffKey, {
        expectedScope: staffScope, recordId: staffId, field: 'display_name', plaintext: name,
      })
      await env.DB.prepare(`UPDATE staff_users
        SET display_name_envelope=?,version=version+1,updated_at=? WHERE id=?`
      ).bind(JSON.stringify(envelope), new Date(NOW_MS + 1_000).toISOString(), staffId).run()
    }
    const workspaceApp = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
      db: env.DB, cryptoContext: { keyring, dataKey: staffKey, scope: staffScope },
      resolveAccessPrincipal: vi.fn(async () => ({ kind: 'human', subject: 'archive-history' })),
      resolveActor: vi.fn(async () => ({
        id: 'stf_archive_retained', role: 'specialist', specialistId: 'sp_archive_retained',
        version: 2,
      })),
    })
    const day = visitAt.slice(0, 10)
    const response = await workspaceApp.request(`/api/v1/workspace?from=${day}&to=${day}`)
    expect(response.status).toBe(200)
    const workspace = await response.json()
    expect(workspace.data.clients).toEqual([expect.objectContaining({
      id: client.id, status: 'archived', readOnly: true, assignment: null,
    })])
    expect(workspace.data.appointments).toEqual([expect.objectContaining({
      id: 'apt_archive_workspace', clientId: client.id, specialistId: 'sp_archive_retained',
      status: 'completed',
    })])
    expect(await env.DB.prepare('SELECT * FROM appointments WHERE id=?')
      .bind('apt_archive_workspace').first()).toMatchObject({ starts_at: visitAt, status: 'completed' })
  })

  it.each(['corrupt', 'missing', 'noncontiguous', 'wrong-key'])(
    'rejects %s older assignment history before IDs or writes', async (kind) => {
      const client = await seed()
      await addHistoricalAssignment(client, kind)
      const before = await env.DB.prepare('SELECT * FROM clients WHERE id=?').bind(client.id).first()
      const idFactory = vi.fn()
      await expect(archive(client, { idFactory,
        idempotencyKey: `archive-history-${kind}-${sequence}-key` })).rejects.toThrow('NOT_FOUND')
      expect(idFactory).not.toHaveBeenCalled()
      expect(await env.DB.prepare('SELECT * FROM clients WHERE id=?').bind(client.id).first())
        .toEqual(before)
    },
  )

  it('checks replay before target facts and generated IDs', async () => {
    const client = await seed()
    const key = `archive-replay-${++sequence}-key`
    const first = await archive(client, { idempotencyKey: key })
    const idFactory = vi.fn()
    expect(await archive(client, { idempotencyKey: key, idFactory })).toEqual(first)
    expect(idFactory).not.toHaveBeenCalled()
  })

  it('fails closed on replay key loss and rejects a changed archive digest', async () => {
    const client = await seed()
    const key = `archive-crypto-${++sequence}-key`
    await archive(client, { idempotencyKey: key })
    await expect(archive(client, { idempotencyKey: key, keyring: {}, idFactory: vi.fn() }))
      .rejects.toThrow('CRYPTO_FAILURE')
    await expect(archive(client, {
      idempotencyKey: key, body: { expectedVersion: 2 }, idFactory: vi.fn(),
    })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  })

  it('builds exactly the ordered seven-statement archive UOW', async () => {
    const client = await seed()
    let batchSql
    const innerByStatement = new WeakMap()
    const statement = (sql, inner) => {
      const wrapped = {
        sql, bind(...bindings) { return statement(sql, inner.bind(...bindings)) },
        first: (...args) => inner.first(...args), all: (...args) => inner.all(...args),
        raw: (...args) => inner.raw(...args), run: (...args) => inner.run(...args),
      }
      innerByStatement.set(wrapped, inner)
      return wrapped
    }
    const db = {
      prepare: (sql) => statement(sql, env.DB.prepare(sql)),
      batch: (statements) => {
        batchSql = statements.map(({ sql }) => sql.replace(/\s+/g, ' ').trim())
        return env.DB.batch(statements.map((current) => innerByStatement.get(current)))
      },
    }
    await archive(client, { db })
    expect(batchSql).toEqual([
      expect.stringMatching(/^UPDATE clients /),
      expect.stringMatching(/^UPDATE client_assignments /),
      expect.stringMatching(/^INSERT INTO record_versions /),
      expect.stringMatching(/^INSERT INTO record_versions /),
      expect.stringMatching(/^INSERT INTO audit_events /),
      expect.stringMatching(/^INSERT INTO idempotency_records /),
      expect.stringMatching(/^INSERT INTO core_directory_invariant_failures /),
    ])
    expect(batchSql.join(' ')).not.toMatch(/(?:UPDATE|DELETE FROM) (?:appointments|session_charges|payment_entries|payment_corrections)/)
  })

  it('recovers a concurrent same-key winner with exactly two reserved reads', async () => {
    const client = await seed()
    const keyring = await ring()
    const key = `archive-race-same-${++sequence}-key`
    let raced = false
    let budget
    let beforeRecovery
    const rawDb = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch() {
        beforeRecovery = budget.usage()
        if (!raced) {
          raced = true
          await archive(client, { keyring, idempotencyKey: key })
        }
        throw new Error('identity_collision: SQLITE_CONSTRAINT')
      },
    }
    budget = createD1QueryBudget(rawDb, { totalLimit: 50, recoveryReserve: 8 })
    const result = await archive(client, {
      db: budget.work, recoveryDb: budget.recovery, keyring, idempotencyKey: key,
    })
    expect(result.body.data.client.status).toBe('archived')
    expect(beforeRecovery.used).toBe(13)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery).used).toBe(15)
  })

  it('contains a concurrent different-key loser as a version conflict with no residue', async () => {
    const client = await seed()
    const keyring = await ring()
    let raced = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!raced) {
          raced = true
          await archive(client, { keyring, idempotencyKey: `archive-winner-${sequence}-key` })
        }
        return env.DB.batch(statements)
      },
    }
    await expect(archive(client, {
      db, keyring, idempotencyKey: `archive-loser-${sequence}-key`,
    })).rejects.toMatchObject({ message: 'VERSION_CONFLICT', details: { currentVersion: 2 } })
    expect(await env.DB.prepare('SELECT count(*) AS count FROM audit_events WHERE entity_id=? AND action=?').bind(client.id, 'client.archived').first())
      .toEqual({ count: 1 })
    expect(await env.DB.prepare('SELECT count(*) AS count FROM idempotency_records WHERE resource_id=? AND operation=?').bind(client.id, 'clients.archive').first())
      .toEqual({ count: 1 })
  })

  it('classifies a future appointment inserted after preflight without masking other guards', async () => {
    const client = await seed()
    let inserted = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!inserted) {
          inserted = true
          const startsAt = new Date(NOW_MS + 1_000).toISOString()
          await env.DB.prepare(`INSERT INTO appointments
            (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
             status,source,version,cancelled_at,created_at,updated_at)
            VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
          ).bind(`apt_archive_race_${sequence}`, client.id, 'sp_target', startsAt,
            new Date(NOW_MS + 61_000).toISOString(), new Date(NOW_MS).toISOString(),
            new Date(NOW_MS).toISOString()).run()
        }
        return env.DB.batch(statements)
      },
    }
    const budget = createD1QueryBudget(db, { totalLimit: 50, recoveryReserve: 8 })
    await expect(archive(client, {
      db: budget.work, recoveryDb: budget.recovery,
      idempotencyKey: `archive-appointment-race-${sequence}-key`,
    })).rejects.toThrow('CLIENT_ARCHIVE_CONFLICT')
    expect(await env.DB.prepare('SELECT status,version FROM clients WHERE id=?').bind(client.id).first())
      .toEqual({ status: 'active', version: 1 })
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 15, remaining: 35, workRemaining: 27, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('does not downgrade a combined appointment race and retired client key', async () => {
    const client = await seed()
    let mutated = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!mutated) {
          mutated = true
          const now = new Date(NOW_MS + 1_000).toISOString()
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO appointments
              (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
               status,source,version,cancelled_at,created_at,updated_at)
              VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
            ).bind(`apt_archive_key_race_${sequence}`, client.id, 'sp_target',
              new Date(NOW_MS + 2_000).toISOString(), new Date(NOW_MS + 62_000).toISOString(),
              now, now),
            env.DB.prepare("UPDATE data_keys SET retired_at=? WHERE scope_type='client' AND scope_id=?")
              .bind(now, client.id),
          ])
        }
        return env.DB.batch(statements)
      },
    }
    let failure
    try { await archive(client, { db }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).not.toBe('CLIENT_ARCHIVE_CONFLICT')
    expect(failure.message).toMatch(/core_directory_invariant/)
  })

  it('does not downgrade a combined appointment race and assignment-history corruption', async () => {
    const client = await seed()
    let mutated = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!mutated) {
          mutated = true
          const now = new Date(NOW_MS + 1_000).toISOString()
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO appointments
              (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
               status,source,version,cancelled_at,created_at,updated_at)
              VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
            ).bind(`apt_archive_history_race_${sequence}`, client.id, 'sp_target',
              new Date(NOW_MS + 2_000).toISOString(), new Date(NOW_MS + 62_000).toISOString(),
              now, now),
            env.DB.prepare(`INSERT INTO record_versions
              (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
               changed_at,correlation_id) VALUES (?, 'client', ?, 2, '{}', ?, ?, ?)`)
              .bind(`ver_archive_cross_history_${sequence}`, client.assignment.id,
                actor.id, now, CORRELATION_ID),
          ])
        }
        return env.DB.batch(statements)
      },
    }
    let failure
    try { await archive(client, { db }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).not.toBe('CLIENT_ARCHIVE_CONFLICT')
    expect(failure.message).toMatch(/core_directory_invariant/)
  })

  it('does not downgrade a combined appointment race and practitioner lifecycle corruption', async () => {
    const fixture = ++sequence
    const specialistId = `sp_archive_lifecycle_${fixture}`
    const staffId = `stf_archive_lifecycle_${fixture}`
    const now = new Date(NOW_MS).toISOString()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO staff_users
        (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
         specialist_id,version,activated_at,disabled_at,created_at,updated_at)
        VALUES (?,?,?,?,?,'active',?,?,1,?,NULL,?,?)`).bind(
        staffId, `lookup_archive_lifecycle_${fixture}`, '{}', '{}', 'specialist',
        `access-archive-lifecycle-${fixture}`, specialistId, now, now, now,
      ),
      env.DB.prepare(`INSERT INTO specialists
        (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
        VALUES (?,?,18000,'active',1,NULL,?,?)`).bind(specialistId, staffId, now, now),
      env.DB.prepare(`INSERT INTO record_versions
        (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
         changed_at,correlation_id) VALUES (?,'specialist',?,1,'{}',NULL,?,?)`)
        .bind(`ver_archive_lifecycle_${fixture}`, specialistId, now, CORRELATION_ID),
    ])
    const client = await seed({ specialistId })
    let mutated = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!mutated) {
          mutated = true
          const racedAt = new Date(NOW_MS + 1_000).toISOString()
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO appointments
              (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
               status,source,version,cancelled_at,created_at,updated_at)
              VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
            ).bind(`apt_archive_practitioner_race_${sequence}`, client.id, specialistId,
              new Date(NOW_MS + 2_000).toISOString(), new Date(NOW_MS + 62_000).toISOString(),
              racedAt, racedAt),
            env.DB.prepare(`UPDATE staff_users
              SET status='disabled',version=version+1,disabled_at=?,updated_at=? WHERE id=?`)
              .bind(racedAt, racedAt, staffId),
          ])
        }
        return env.DB.batch(statements)
      },
    }
    let failure
    try { await archive(client, { db }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).not.toBe('CLIENT_ARCHIVE_CONFLICT')
    expect(failure.message).toMatch(/core_directory_invariant/)
  })

  it('does not downgrade a combined appointment race and audit identity collision', async () => {
    const client = await seed()
    const ids = ['archive_round2_client_ver', 'archive_round2_assignment_ver',
      'archive_round2_audit']
    let mutated = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!mutated) {
          mutated = true
          const now = new Date(NOW_MS + 1_000).toISOString()
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO appointments
              (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
               status,source,version,cancelled_at,created_at,updated_at)
              VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
            ).bind(`apt_archive_audit_race_${sequence}`, client.id, 'sp_target',
              new Date(NOW_MS + 2_000).toISOString(), new Date(NOW_MS + 62_000).toISOString(),
              now, now),
            env.DB.prepare(`INSERT INTO audit_events
              (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,
               reason_envelope,correlation_id,metadata_json)
              VALUES ('aud_archive_round2_audit',?,?,'unrelated.action','client',?,'failure',NULL,?,'{}')`
            ).bind(now, actor.id, client.id, CORRELATION_ID),
          ])
        }
        return env.DB.batch(statements)
      },
    }
    let failure
    try {
      await archive(client, { db, idFactory: () => ids.shift() })
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).not.toBe('CLIENT_ARCHIVE_CONFLICT')
    expect(failure.message).toMatch(/identity_collision/)
  })

  it('preserves the guard failure when the rollback proof is malformed', async () => {
    const client = await seed()
    let inserted = false
    const db = {
      prepare(sql) {
        if (sql.includes('AS proven')) {
          return { bind: () => ({ first: async () => ({ blocked: 1, proven: 1, extra: true }) }) }
        }
        return env.DB.prepare(sql)
      },
      async batch(statements) {
        if (!inserted) {
          inserted = true
          const now = new Date(NOW_MS + 1_000).toISOString()
          await env.DB.prepare(`INSERT INTO appointments
            (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
             status,source,version,cancelled_at,created_at,updated_at)
            VALUES (?,?,?,'zajecia',?,?,'Europe/Warsaw',NULL,'scheduled','panel',1,NULL,?,?)`
          ).bind(`apt_archive_malformed_proof_${sequence}`, client.id, 'sp_target',
            new Date(NOW_MS + 2_000).toISOString(), new Date(NOW_MS + 62_000).toISOString(),
            now, now).run()
        }
        return env.DB.batch(statements)
      },
    }
    let failure
    try { await archive(client, { db }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).not.toBe('CLIENT_ARCHIVE_CONFLICT')
    expect(failure.message).toMatch(/core_directory_invariant/)
  })

  it('rolls back each ordered seven-statement archive position byte-for-byte', async () => {
    for (let failedAt = 0; failedAt < 7; failedAt += 1) {
      const client = await seed()
      const tables = async () => ({
        client: await env.DB.prepare('SELECT * FROM clients WHERE id=?').bind(client.id).first(),
        assignments: (await env.DB.prepare('SELECT * FROM client_assignments WHERE client_id=? ORDER BY id').bind(client.id).all()).results,
        versions: (await env.DB.prepare('SELECT * FROM record_versions WHERE entity_id IN (?,?) ORDER BY id').bind(client.id, client.assignment.id).all()).results,
        audits: (await env.DB.prepare('SELECT * FROM audit_events WHERE entity_id=? ORDER BY id').bind(client.id).all()).results,
        idem: (await env.DB.prepare('SELECT * FROM idempotency_records WHERE resource_id=? ORDER BY idempotency_key').bind(client.id).all()).results,
        appointments: (await env.DB.prepare('SELECT * FROM appointments WHERE client_id=? ORDER BY id').bind(client.id).all()).results,
        charges: (await env.DB.prepare(`SELECT charge.* FROM session_charges charge JOIN appointments appointment ON appointment.id=charge.appointment_id WHERE appointment.client_id=? ORDER BY charge.id`).bind(client.id).all()).results,
        payments: (await env.DB.prepare(`SELECT payment.* FROM payment_entries payment JOIN appointments appointment ON appointment.id=payment.appointment_id WHERE appointment.client_id=? ORDER BY payment.id`).bind(client.id).all()).results,
        corrections: (await env.DB.prepare(`SELECT correction.* FROM payment_corrections correction JOIN payment_entries payment ON payment.id=correction.reversed_entry_id JOIN appointments appointment ON appointment.id=payment.appointment_id WHERE appointment.client_id=? ORDER BY correction.id`).bind(client.id).all()).results,
      })
      const before = await tables()
      const db = { prepare: (sql) => env.DB.prepare(sql), batch: (statements) => env.DB.batch(statements.map((statement, index) => index === failedAt ? env.DB.prepare("INSERT INTO core_directory_invariant_failures (failure_kind) VALUES ('forced')") : statement)) }
      await expect(archive(client, { db, idempotencyKey: `archive-rollback-${sequence}-${failedAt}` })).rejects.toThrow()
      expect(await tables()).toEqual(before)
    }
  })

  it('stays inside the archive work and route budgets', async () => {
    const client = await seed()
    const budget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    await archive(client, { db: budget.work, recoveryDb: budget.recovery })
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery)).toEqual({
      used: 13, remaining: 37, workRemaining: 29, totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('keeps the archive adapter exact', async () => {
    const service = vi.fn(async () => ({ status: 200, body: { data: { client: {} } } }))
    const input = { db: {}, recoveryDb: {}, actor, keyring: {}, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory: vi.fn(), clientId: 'cl_archive_adapter',
      body: { expectedVersion: 1 }, idempotencyKey: 'archive-adapter-key-0001', archive: service }
    expect((await postClientArchive(input)).status).toBe(200)
    await expect(postClientArchive({ ...input, body: { expectedVersion: 0 } }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'expectedVersion' } })
  })
})
const CORRELATION_ID = '00000000-0000-4000-8000-000000000015'

const ring = () => createKeyring(env, {
  activeDataKekVersion: 1,
  activeLookupKeyVersion: 1,
  activeBackupKekVersion: 1,
})

beforeAll(async () => {
  expect(await completeCoreDirectoryStageA()).toMatchObject({ status: 'complete' })
  await applyCoreDirectoryStageB()
  const instant = new Date(NOW_MS).toISOString()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_owner', 'lookup_client_owner', '{}', '{}', 'owner', 'active',
      'access-client-owner', null, 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_coord', 'lookup_client_coord', '{}', '{}', 'coordinator', 'active',
      'access-client-coord', null, 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_target', 'lookup_client_target', '{}', '{}', 'owner', 'active',
      'access-client-target', 'sp_target', 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_target', 'stf_client_target', 18000, 'active', 1, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'ver_client_target_specialist', 'specialist', 'sp_target', 1, '{}', null,
      instant, CORRELATION_ID,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_archive_retained', 'lookup_archive_retained', '{}', '{}', 'specialist', 'active',
      'access-archive-retained', 'sp_archive_retained', 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_archive_retained', 'stf_archive_retained', 18000, 'active', 1, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id) VALUES (?,?,?,?,?,?,?,?)`).bind(
      'ver_archive_retained_specialist', 'specialist', 'sp_archive_retained', 1, '{}', null,
      instant, CORRELATION_ID,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_self', 'lookup_client_self', '{}', '{}', 'specialist', 'active',
      'access-client-self', 'sp_client_self', 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_client_self', 'stf_client_self', 18000, 'active', 1, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO record_versions
      (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
       changed_at,correlation_id)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'ver_client_self_specialist', 'specialist', 'sp_client_self', 1, '{}', null,
      instant, CORRELATION_ID,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_pending', 'lookup_client_pending', '{}', '{}', 'specialist', 'pending',
      null, 'sp_client_pending', 1, null, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_client_pending', 'stf_client_pending', 18000, 'pending', 1, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_archived', 'lookup_client_archived', '{}', '{}', 'specialist', 'disabled',
      'access-client-archived', 'sp_client_archived', 1, instant, instant, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_client_archived', 'stf_client_archived', 18000, 'archived', 1, instant, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_disabled_active', 'lookup_client_disabled_active', '{}', '{}', 'owner', 'disabled',
      'access-client-disabled-active', 'sp_client_disabled_active', 1, instant, instant, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_client_disabled_active', 'stf_client_disabled_active', 18000, 'active', 1, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_pending_active', 'lookup_client_pending_active', '{}', '{}', 'owner', 'pending',
      null, 'sp_client_pending_active', 1, null, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_client_pending_active', 'stf_client_pending_active', 18000, 'active', 1, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_forward', 'lookup_client_forward', '{}', '{}', 'owner', 'active',
      'access-client-forward', 'sp_client_forward_other', 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_client_forward', 'stf_client_forward', 18000, 'active', 1, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_backlink_pointer', 'lookup_client_backlink_pointer', '{}', '{}', 'owner', 'active',
      'access-client-backlink-pointer', 'sp_client_backlink', 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO staff_users
      (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
       specialist_id,version,activated_at,disabled_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'stf_client_backlink_profile', 'lookup_client_backlink_profile', '{}', '{}', 'owner', 'active',
      'access-client-backlink-profile', null, 1, instant, null, instant, instant,
    ),
    env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,standard_rate_grosze,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      'sp_client_backlink', 'stf_client_backlink_profile', 18000, 'active', 1, null, instant, instant,
    ),
  ])
})

describe('persistent client creation', () => {
  it('strictly captures the exact create body without invoking accessors', () => {
    expect(validateCreateClientBody(BODY)).toEqual(BODY)
    for (const [body, field] of [
      [{ ...BODY, name: ' Fikcyjna' }, 'name'],
      [{ ...BODY, name: '\uD800' }, 'name'],
      [{ ...BODY, age: 0 }, 'age'],
      [{ ...BODY, status: 'archived' }, 'status'],
      [{ ...BODY, specialistId: 'staff_target' }, 'specialistId'],
      [{ ...BODY, extra: true }, 'body'],
    ]) expect(() => validateCreateClientBody(body)).toThrow(`VALIDATION_FAILED/${field}`)

    const getter = vi.fn(() => 'Fikcyjna')
    const hostile = Object.defineProperty({
      age: 12, status: 'active', specialistId: 'sp_target',
    }, 'name', { enumerable: true, get: getter })
    expect(() => validateCreateClientBody(hostile)).toThrow('VALIDATION_FAILED/body')
    expect(getter).not.toHaveBeenCalled()

    for (const hostile of [
      Object.defineProperty({ ...BODY }, 'age', { value: 12, enumerable: false }),
      Object.assign({ ...BODY }, { [Symbol('hidden')]: true }),
      new Proxy({}, { ownKeys() { throw new Error('private-value') } }),
    ]) expect(() => validateCreateClientBody(hostile)).toThrow('VALIDATION_FAILED/body')
  })

  it('digests the normalized exact route and is stable across body key order', async () => {
    const reordered = {
      specialistId: 'sp_target', status: 'active', age: 12, name: 'Fikcyjna',
    }
    const digest = await digestCreateClientRequest(BODY)
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await digestCreateClientRequest(reordered)).toBe(digest)
    expect(await digestCreateClientRequest({ ...BODY, age: 13 })).not.toBe(digest)
  })

  it('checks stored idempotency before specialist lookup or ID generation', async () => {
    const calls = []
    const db = {
      prepare(sql) {
        calls.push(sql)
        return {
          bind(...bindings) {
            return {
              async first() { return null },
              bindings,
            }
          },
        }
      },
      batch: vi.fn(),
    }
    const idFactory = vi.fn(() => 'generated')
    await expect(createClient({
      db,
      recoveryDb: db,
      actor: { id: 'stf_owner', role: 'owner', specialistId: null },
      keyring: {},
      nowMs: NOW_MS,
      correlationId: CORRELATION_ID,
      idFactory,
      body: BODY,
      idempotencyKey: 'client-create-key-0001',
    })).rejects.toThrow('NOT_FOUND')
    expect(calls[0]).toContain('FROM idempotency_records')
    expect(calls[1]).toContain('FROM specialists')
    expect(idFactory).not.toHaveBeenCalled()
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('keeps the POST adapter exact and delegates only captured route context', async () => {
    const service = vi.fn(async () => ({ status: 201, body: { data: { client: {} } } }))
    const input = {
      db: {}, recoveryDb: {}, actor: { id: 'stf_owner' }, keyring: {},
      nowMs: NOW_MS, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      body: BODY, idempotencyKey: 'client-create-key-0002', create: service,
    }
    expect(await postClient(input)).toEqual({ status: 201, body: { data: { client: {} } } })
    expect(service).toHaveBeenCalledOnce()
    expect(service).toHaveBeenCalledWith(expect.objectContaining({
      db: input.db, recoveryDb: input.recoveryDb, body: BODY,
    }))
  })

  it('creates key, client, assignment, versions, one audit, idempotency, and guard atomically', async () => {
    const values = ['client_one', 'assignment_one', 'client_version_one',
      'assignment_version_one', 'audit_one', 'data_key_one']
    const idFactory = vi.fn(() => values.shift())
    const result = await createClient({
      db: env.DB,
      recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(),
      nowMs: NOW_MS,
      correlationId: CORRELATION_ID,
      idFactory,
      body: BODY,
      idempotencyKey: 'client-create-key-success-0001',
    })

    expect(result).toEqual({
      status: 201,
      body: { data: { client: {
        id: 'cl_client_one', name: 'Fikcyjna', age: 12, status: 'active', version: 1,
        archivedAt: null, createdAt: new Date(NOW_MS).toISOString(),
        updatedAt: new Date(NOW_MS).toISOString(), readOnly: false,
        assignment: {
          id: 'asg_assignment_one', specialistId: 'sp_target',
          startsAt: new Date(NOW_MS).toISOString(), version: 1,
        },
      } } },
    })
    expect(idFactory).toHaveBeenCalledTimes(6)

    const counts = await Promise.all([
      ['data_keys', "scope_id='cl_client_one'"],
      ['clients', "id='cl_client_one'"],
      ['client_assignments', "client_id='cl_client_one'"],
      ['record_versions', "entity_id IN ('cl_client_one','asg_assignment_one')"],
      ['audit_events', "entity_id='cl_client_one' AND action='client.created'"],
      ['idempotency_records', "resource_id='cl_client_one'"],
    ].map(async ([table, where]) => (await env.DB.prepare(
      `SELECT count(*) AS count FROM ${table} WHERE ${where}`
    ).first()).count))
    expect(counts).toEqual([1, 1, 1, 2, 1, 1])

    const replayFactory = vi.fn(() => { throw new Error('must not generate') })
    const replay = await createClient({
      db: env.DB,
      recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(),
      nowMs: NOW_MS + 1000,
      correlationId: CORRELATION_ID,
      idFactory: replayFactory,
      body: BODY,
      idempotencyKey: 'client-create-key-success-0001',
    })
    expect(replay).toEqual(result)
    expect(replayFactory).not.toHaveBeenCalled()

    await expect(createClient({
      db: env.DB,
      recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(),
      nowMs: NOW_MS + 2000,
      correlationId: CORRELATION_ID,
      idFactory: replayFactory,
      body: { ...BODY, age: 13 },
      idempotencyKey: 'client-create-key-success-0001',
    })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
    expect(replayFactory).not.toHaveBeenCalled()
  })

  it('builds exactly the ordered eight-statement UOW without prewrites', async () => {
    const terminals = []
    const statement = (sql, bindings = []) => ({
      sql,
      bindings,
      bind(...values) { return statement(sql, values) },
      run() { terminals.push(['run', sql]); return Promise.resolve({ success: true }) },
      all() { terminals.push(['all', sql]); return Promise.resolve({ results: [] }) },
      raw() { terminals.push(['raw', sql]); return Promise.resolve([]) },
      first() {
        terminals.push(['first', sql])
        if (sql.includes('idempotency_records')) return Promise.resolve(null)
        if (sql.includes('FROM specialists AS specialist')) {
          return Promise.resolve({ id: 'sp_target', staff_user_id: 'stf_client_target' })
        }
        return Promise.resolve(null)
      },
    })
    let batch
    const db = {
      prepare: (sql) => statement(sql),
      async batch(statements) { batch = statements; return statements.map(() => ({ success: true })) },
    }
    const values = ['ordered_client', 'ordered_assignment', 'ordered_client_ver',
      'ordered_assignment_ver', 'ordered_audit', 'ordered_key']
    await createClient({
      db, recoveryDb: db,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS, correlationId: CORRELATION_ID,
      idFactory: () => values.shift(), body: BODY,
      idempotencyKey: 'client-create-ordered-0001',
    })
    expect(terminals.map(([method]) => method)).toEqual(['first', 'first'])
    expect(batch.map(({ sql }) => sql.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringMatching(/^INSERT INTO data_keys /),
      expect.stringMatching(/^INSERT INTO clients /),
      expect.stringMatching(/^INSERT INTO client_assignments /),
      expect.stringMatching(/^INSERT INTO record_versions /),
      expect.stringMatching(/^INSERT INTO record_versions /),
      expect.stringMatching(/^INSERT INTO audit_events /),
      expect.stringMatching(/^INSERT INTO idempotency_records /),
      expect.stringMatching(/^INSERT INTO core_directory_invariant_failures /),
    ])
    expect(JSON.stringify(batch.map(({ bindings }) => bindings))).not.toContain('Fikcyjna')
  })

  it.each([
    [{ id: 'stf_owner', role: 'owner', specialistId: null }, 'sp_target', true],
    [{ id: 'stf_coord', role: 'coordinator', specialistId: null }, 'sp_target', true],
    [{ id: 'stf_spec', role: 'specialist', specialistId: 'sp_target' }, 'sp_target', true],
    [{ id: 'stf_spec', role: 'specialist', specialistId: 'sp_other' }, 'sp_target', false],
    [{ id: 'stf_owner', role: 'owner', specialistId: 'sp_owner' }, 'sp_target', true],
  ])('enforces assignment authorization for actor %o', async (actor, specialistId, allowed) => {
    const calls = []
    const db = {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                calls.push(sql)
                if (sql.includes('idempotency_records')) return null
                return { id: specialistId, staff_user_id: 'stf_target' }
              },
            }
          },
        }
      },
      batch: vi.fn(async () => []),
    }
    let generated = 0
    const idFactory = vi.fn(() => `bad_after_authorization_${generated++}`)
    const operation = createClient({
      db, recoveryDb: db, actor, keyring: {}, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory,
      body: { ...BODY, specialistId }, idempotencyKey: `client-role-${actor.role}-0001`,
    })
    if (allowed) await expect(operation).rejects.toThrow('CRYPTO_FAILURE')
    else await expect(operation).rejects.toThrow('NOT_FOUND')
    expect(calls).toHaveLength(2)
    expect(idFactory).toHaveBeenCalledTimes(allowed ? 6 : 0)
  })

  it('scopes the real D1 practitioner lookup and makes every opaque miss the same HTTP 404', async () => {
    const opaque = [
      ['missing', { id: 'stf_client_owner', role: 'owner', specialistId: null }, 'sp_client_absent'],
      ['guessed', { id: 'stf_client_owner', role: 'owner', specialistId: null }, 'sp_client_guessed'],
      ['pending profile', { id: 'stf_client_owner', role: 'owner', specialistId: null }, 'sp_client_pending'],
      ['archived profile', { id: 'stf_client_owner', role: 'owner', specialistId: null }, 'sp_client_archived'],
      ['disabled staff', { id: 'stf_client_owner', role: 'owner', specialistId: null }, 'sp_client_disabled_active'],
      ['pending staff', { id: 'stf_client_owner', role: 'owner', specialistId: null }, 'sp_client_pending_active'],
      ['forward mismatch', { id: 'stf_client_owner', role: 'owner', specialistId: null }, 'sp_client_forward'],
      ['backlink mismatch', { id: 'stf_client_owner', role: 'owner', specialistId: null }, 'sp_client_backlink'],
      ['other specialist', { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' }, 'sp_target'],
    ]
    const envelopes = []
    for (const [label, actor, specialistId] of opaque) {
      const idFactory = vi.fn(() => `forbidden_${label.replaceAll(' ', '_')}`)
      let usage
      const service = async (options) => {
        try { return await createClient(options) } finally {
          usage = usageForD1QueryBudgetViews(options.db, options.recoveryDb)
        }
      }
      const app = createApp({
        config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
        db: env.DB,
        cryptoContext: { keyring: await ring(), dataKey: {}, scope: {} },
        resolveAccessPrincipal: vi.fn(async () => ({
          kind: 'human', subject: `access-${label}`, normalizedEmail: `${label.replaceAll(' ', '-')}@example.test`,
        })),
        resolveActor: vi.fn(async () => ({ ...actor, version: 1 })),
        verifyCsrfToken: vi.fn(async () => true),
        readJsonBodyOnce: vi.fn(async (request) => request.json()),
        createClient: service,
        idFactory,
        safeLog: vi.fn(),
        now: () => NOW_MS,
      })
      const idempotencyKey = `client-opaque-${label.replaceAll(' ', '-')}-0001`
      const response = await app.request('/api/v1/clients', {
        method: 'POST',
        headers: {
          origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
          'idempotency-key': idempotencyKey, 'x-csrf-token': 'valid',
          'x-correlation-id': CORRELATION_ID,
        },
        body: JSON.stringify({ ...BODY, specialistId }),
      })
      expect(response.status, label).toBe(404)
      const envelope = await response.json()
      expect(envelope, label).toEqual({
        error: { code: 'NOT_FOUND', correlationId: CORRELATION_ID },
      })
      envelopes.push(envelope)
      expect(usage, label).toEqual({
        used: 2, remaining: 48, workRemaining: 40,
        totalLimit: 50, recoveryReserve: 8,
      })
      expect(idFactory, label).not.toHaveBeenCalled()
      expect(await env.DB.prepare(
        'SELECT count(*) AS count FROM idempotency_records WHERE idempotency_key=?'
      ).bind(idempotencyKey).first(), label).toEqual({ count: 0 })
    }
    expect(envelopes.every((value) => JSON.stringify(value) === JSON.stringify(envelopes[0])))
      .toBe(true)
  })

  it.each([
    ['owner', { id: 'stf_client_owner', role: 'owner', specialistId: null }, 'sp_target'],
    ['coordinator', { id: 'stf_client_coord', role: 'coordinator', specialistId: null }, 'sp_target'],
    ['specialist', { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' }, 'sp_client_self'],
  ])('allows %s through the real HTTP and D1 path for an exact active retained profile', async (label, actor, specialistId) => {
    const ids = [`${label}_client`, `${label}_assignment`, `${label}_client_ver`,
      `${label}_assignment_ver`, `${label}_audit`, `${label}_key`]
    let usage
    const service = async (options) => {
      try { return await createClient(options) } finally {
        usage = usageForD1QueryBudgetViews(options.db, options.recoveryDb)
      }
    }
    const app = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
      db: env.DB,
      cryptoContext: { keyring: await ring(), dataKey: {}, scope: {} },
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'human', subject: `access-${label}-positive`, normalizedEmail: `${label}@example.test`,
      })),
      resolveActor: vi.fn(async () => ({ ...actor, version: 1 })),
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
      createClient: service,
      idFactory: vi.fn(() => ids.shift()),
      safeLog: vi.fn(),
      now: () => NOW_MS,
    })
    const response = await app.request('/api/v1/clients', {
      method: 'POST',
      headers: {
        origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
        'idempotency-key': `client-positive-${label}-0001`, 'x-csrf-token': 'valid',
        'x-correlation-id': CORRELATION_ID,
      },
      body: JSON.stringify({ ...BODY, specialistId }),
    })
    expect(response.status).toBe(201)
    expect((await response.json()).data.client.assignment.specialistId).toBe(specialistId)
    expect(usage).toEqual({
      used: 10, remaining: 40, workRemaining: 32,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('rolls back every mutation statement position with no residue', async () => {
    const keyring = await ring()
    for (let failedAt = 0; failedAt < 8; failedAt += 1) {
      const marker = `rollback_${failedAt}`
      const values = [`client_${marker}`, `assignment_${marker}`, `client_ver_${marker}`,
        `assignment_ver_${marker}`, `audit_${marker}`, `key_${marker}`]
      const db = {
        prepare: (sql) => env.DB.prepare(sql),
        batch: (statements) => env.DB.batch(statements.map((statement, index) => (
          index === failedAt
            ? env.DB.prepare("INSERT INTO core_directory_invariant_failures (failure_kind) VALUES ('forced')")
            : statement
        ))),
      }
      await expect(createClient({
        db, recoveryDb: env.DB,
        actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
        keyring, nowMs: NOW_MS, correlationId: CORRELATION_ID,
        idFactory: () => values.shift(), body: BODY,
        idempotencyKey: `client-create-rollback-${failedAt}-0001`,
      })).rejects.toThrow()
      const residue = await Promise.all([
        ['data_keys', `scope_id='cl_client_${marker}'`],
        ['clients', `id='cl_client_${marker}'`],
        ['client_assignments', `client_id='cl_client_${marker}'`],
        ['record_versions', `entity_id IN ('cl_client_${marker}','asg_assignment_${marker}')`],
        ['audit_events', `entity_id='cl_client_${marker}'`],
        ['idempotency_records', `resource_id='cl_client_${marker}'`],
      ].map(async ([table, where]) => (await env.DB.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE ${where}`
      ).first()).count))
      expect(residue).toEqual([0, 0, 0, 0, 0, 0])
    }
  })

  it('recovers a concurrent winner with exactly two sibling recovery reads', async () => {
    const keyring = await ring()
    const key = 'client-create-collision-0001'
    const winnerIds = ['winner_client', 'winner_assignment', 'winner_client_ver',
      'winner_assignment_ver', 'winner_audit', 'winner_key']
    let raced = false
    let usageBeforeRecovery
    let budget
    const rawDb = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch() {
        usageBeforeRecovery = budget.usage()
        if (!raced) {
          raced = true
          await createClient({
            db: env.DB, recoveryDb: env.DB,
            actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
            keyring, nowMs: NOW_MS, correlationId: CORRELATION_ID,
            idFactory: () => winnerIds.shift(), body: BODY, idempotencyKey: key,
          })
        }
        throw new Error('identity_collision: SQLITE_CONSTRAINT')
      },
    }
    budget = createD1QueryBudget(rawDb, { totalLimit: 50, recoveryReserve: 8 })
    const loserIds = ['loser_client', 'loser_assignment', 'loser_client_ver',
      'loser_assignment_ver', 'loser_audit', 'loser_key']
    const result = await createClient({
      db: budget.work, recoveryDb: budget.recovery,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring, nowMs: NOW_MS, correlationId: CORRELATION_ID,
      idFactory: () => loserIds.shift(), body: BODY, idempotencyKey: key,
    })
    expect(result.body.data.client.id).toBe('cl_winner_client')
    expect(usageBeforeRecovery.used).toBe(10)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery).used).toBe(12)
    expect(await env.DB.prepare("SELECT count(*) AS count FROM clients WHERE id='cl_loser_client'").first())
      .toEqual({ count: 0 })
  })

  it('wires POST clients without dispatching archive to the create service', async () => {
    const create = vi.fn(async () => ({
      status: 201, body: { data: { client: { id: 'cl_shell' } } },
    }))
    const rawDb = {
      prepare() {
        return { bind() { return { first: async () => null } } }
      },
      batch: async () => [],
    }
    const app = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
      db: rawDb,
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'human', subject: 'access-client-shell', normalizedEmail: 'shell@example.test',
      })),
      resolveActor: vi.fn(async () => ({
        id: 'stf_shell', role: 'owner', specialistId: null, version: 1,
      })),
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
      createClient: create,
      archiveClient: vi.fn(async () => ({ status: 200, body: { data: { client: {
        id: 'cl_shell', status: 'archived',
      } } } })),
      now: () => NOW_MS,
    })
    const headers = {
      origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
      'idempotency-key': 'client-create-shell-0001', 'x-csrf-token': 'valid',
    }
    const response = await app.request('/api/v1/clients', {
      method: 'POST', headers, body: JSON.stringify(BODY),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ data: { client: { id: 'cl_shell' } } })
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0].db).not.toBe(rawDb)
    expect(create.mock.calls[0][0].recoveryDb).not.toBe(rawDb)
    expect(usageForD1QueryBudgetViews(
      create.mock.calls[0][0].db, create.mock.calls[0][0].recoveryDb,
    )).toEqual({
      used: 0, remaining: 50, workRemaining: 42, totalLimit: 50, recoveryReserve: 8,
    })

    const future = await app.request('/api/v1/clients/cl_shell/archive', {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 1 }),
    })
    expect(future.status).toBe(200)
    expect(create).toHaveBeenCalledOnce()
  })

  it('maps semantic create validation to the safe field without touching D1', async () => {
    const prepare = vi.fn()
    const app = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
      db: { prepare, batch: vi.fn() },
      cryptoContext: { keyring: {}, dataKey: {}, scope: {} },
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'human', subject: 'access-client-invalid', normalizedEmail: 'invalid@example.test',
      })),
      resolveActor: vi.fn(async () => ({
        id: 'stf_shell', role: 'owner', specialistId: null, version: 1,
      })),
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async () => ({ ...BODY, name: ' Fikcyjna' })),
      now: () => NOW_MS,
    })
    const response = await app.request('/api/v1/clients', {
      method: 'POST',
      headers: {
        origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
        'idempotency-key': 'client-create-invalid-0001', 'x-csrf-token': 'valid',
      },
      body: JSON.stringify({ ...BODY, name: ' Fikcyjna' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { field: 'name' } },
    })
    expect(prepare).not.toHaveBeenCalled()
  })
})

describe('persistent client edit and reassignment', () => {
  const editBody = Object.freeze({
    expectedVersion: 1, name: 'Fikcyjna Zmieniona', age: 13,
    status: 'paused', specialistId: 'sp_target',
  })
  let fixtureSequence = 0
  const seedEditable = async ({ specialistId = 'sp_target', status = 'active', actor = {
    id: 'stf_client_owner', role: 'owner', specialistId: null,
  } } = {}) => {
    fixtureSequence += 1
    const marker = `edit_fixture_${fixtureSequence}`
    const ids = [`${marker}_client`, `${marker}_assignment`, `${marker}_client_ver`,
      `${marker}_assignment_ver`, `${marker}_audit`, `${marker}_key`]
    const created = await createClient({
      db: env.DB, recoveryDb: env.DB, actor, keyring: await ring(),
      nowMs: NOW_MS, correlationId: CORRELATION_ID,
      idFactory: () => ids.shift(), body: { ...BODY, status, specialistId },
      idempotencyKey: `${marker}-create-key`,
    })
    return created.body.data.client
  }
  const seedMalformedHistory = async (kind) => {
    fixtureSequence += 1
    const marker = `malformed_history_${fixtureSequence}`
    const clientId = `cl_${marker}`
    const assignmentId = `asg_${marker}`
    const keyring = await ring()
    const now = new Date(NOW_MS).toISOString()
    const built = await buildClientDataKey(env.DB, keyring, {
      clientId, dataKeyId: `key_${marker}`, createdAt: now,
    })
    const context = { keyring, dataKey: built.row, scope: built.scope }
    const identityEnvelope = await encryptClientIdentity(context, {
      clientId, name: 'Historia Fikcyjna', age: 12,
    })
    const snapshot = async (recordId, dataKeyId = built.row.id) => {
      const envelope = await encryptForScope(keyring, built.row, {
        expectedScope: built.scope, recordId, field: 'record_version', plaintext: '{}',
      })
      return JSON.stringify({ ...envelope, dataKeyId })
    }
    const clientVersion = {
      id: `ver_${marker}_client`, entityType: 'client', entityId: clientId,
      version: 1, envelope: await snapshot(clientId),
    }
    const assignmentVersion = {
      id: `ver_${marker}_assignment`, entityType: 'client_assignment',
      entityId: assignmentId, version: 1, envelope: await snapshot(assignmentId),
    }
    const versions = [clientVersion, assignmentVersion]
    if (kind === 'missing') versions.shift()
    if (kind === 'duplicate') versions.push({
      ...clientVersion, id: `ver_${marker}_client_extra`, version: 2,
    })
    if (kind === 'wrong-entity') clientVersion.entityType = 'client_assignment'
    if (kind === 'wrong-id') clientVersion.entityId = `cl_${marker}_other`
    if (kind === 'wrong-version') clientVersion.version = 2
    if (kind === 'wrong-key') clientVersion.envelope = await snapshot(clientId, `key_${marker}_other`)
    if (kind === 'malformed-envelope') clientVersion.envelope = '{}'
    if (kind === 'tampered') {
      const envelope = JSON.parse(clientVersion.envelope)
      const last = envelope.ciphertext.at(-1)
      envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`
      clientVersion.envelope = JSON.stringify(envelope)
    }
    await env.DB.batch([
      built.statement,
      env.DB.prepare(
        `INSERT INTO clients
         (id,identity_envelope,status,version,archived_at,created_at,updated_at)
         VALUES (?,?,?,1,NULL,?,?)`
      ).bind(clientId, identityEnvelope, 'active', now, now),
      env.DB.prepare(
        `INSERT INTO client_assignments
         (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
          version,created_at,updated_at)
         VALUES (?,?,?, ?,NULL,?,1,?,?)`
      ).bind(assignmentId, clientId, 'sp_target', now, 'stf_client_owner', now, now),
      ...versions.map((version) => env.DB.prepare(
        `INSERT INTO record_versions
         (id,entity_type,entity_id,version,snapshot_envelope,changed_by_staff_id,
          changed_at,correlation_id)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(
        version.id, version.entityType, version.entityId, version.version,
        version.envelope, 'stf_client_owner', now, CORRELATION_ID,
      )),
    ])
    return { clientId, assignmentId, keyring }
  }

  it('strictly captures the exact edit target and five-key body', () => {
    expect(validateEditClientBody(editBody)).toEqual(editBody)
    for (const [body, field] of [
      [{ ...editBody, expectedVersion: 0 }, 'expectedVersion'],
      [{ ...editBody, name: ' Zmieniona' }, 'name'],
      [{ ...editBody, age: 27 }, 'age'],
      [{ ...editBody, status: 'archived' }, 'status'],
      [{ ...editBody, specialistId: 'staff_target' }, 'specialistId'],
      [{ ...editBody, extra: true }, 'body'],
    ]) expect(() => validateEditClientBody(body)).toThrow(`VALIDATION_FAILED/${field}`)

    const getter = vi.fn(() => 1)
    const hostile = Object.defineProperty({
      name: editBody.name, age: editBody.age, status: editBody.status,
      specialistId: editBody.specialistId,
    }, 'expectedVersion', { enumerable: true, get: getter })
    expect(() => validateEditClientBody(hostile)).toThrow('VALIDATION_FAILED/body')
    expect(getter).not.toHaveBeenCalled()
  })

  it('binds the digest to the normalized target, version, and values', async () => {
    const digest = await digestEditClientRequest('cl_edit_target', editBody)
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await digestEditClientRequest('cl_edit_target', {
      specialistId: 'sp_target', status: 'paused', age: 13,
      name: 'Fikcyjna Zmieniona', expectedVersion: 1,
    })).toBe(digest)
    expect(await digestEditClientRequest('cl_other_target', editBody)).not.toBe(digest)
    expect(await digestEditClientRequest('cl_edit_target', {
      ...editBody, expectedVersion: 2,
    })).not.toBe(digest)
    await expect(digestEditClientRequest('bad', editBody)).rejects
      .toThrow('VALIDATION_FAILED/clientId')
  })

  it('keeps the edit adapter exact and maps safe semantic fields', async () => {
    const service = vi.fn(async () => ({ status: 200, body: { data: { client: {} } } }))
    const input = {
      db: {}, recoveryDb: {}, actor: { id: 'stf_owner' }, keyring: {},
      nowMs: NOW_MS, correlationId: CORRELATION_ID, idFactory: vi.fn(),
      clientId: 'cl_edit_target', body: editBody,
      idempotencyKey: 'client-edit-adapter-0001', edit: service,
    }
    expect(await postClientEdit(input)).toEqual({
      status: 200, body: { data: { client: {} } },
    })
    expect(service).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'cl_edit_target', body: editBody,
    }))
    await expect(postClientEdit({ ...input, clientId: 'wrong' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'clientId' } })
    await expect(postClientEdit({
      ...input, body: { ...editBody, expectedVersion: 0 },
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { field: 'expectedVersion' } })
  })

  it('checks client-scoped replay before scope reads or generated IDs', async () => {
    const calls = []
    const db = {
      prepare(sql) {
        calls.push(sql)
        return { bind() { return { first: async () => null } } }
      },
      batch: vi.fn(),
    }
    const idFactory = vi.fn()
    await expect(editClient({
      db, recoveryDb: db,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: {}, nowMs: NOW_MS, correlationId: CORRELATION_ID, idFactory,
      clientId: 'cl_missing_edit', body: editBody,
      idempotencyKey: 'client-edit-replay-first-0001',
    })).rejects.toThrow('NOT_FOUND')
    expect(calls[0]).toContain('FROM idempotency_records')
    expect(calls[1]).toContain('FROM clients')
    expect(idFactory).not.toHaveBeenCalled()
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('atomically edits encrypted identity/status with only the client audit schema', async () => {
    const original = await seedEditable()
    const values = ['identity_client_version', 'identity_audit']
    const body = {
      expectedVersion: 1, name: 'Fikcyjna Po Edycji', age: null,
      status: 'paused', specialistId: 'sp_target',
    }
    const result = await editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 1_000,
      correlationId: CORRELATION_ID, idFactory: () => values.shift(),
      clientId: original.id, body, idempotencyKey: 'client-edit-identity-success-0001',
    })
    expect(result).toEqual({ status: 200, body: { data: { client: {
      ...original, name: body.name, age: null, status: 'paused', version: 2,
      updatedAt: new Date(NOW_MS + 1_000).toISOString(),
    } } } })
    const row = await env.DB.prepare(
      'SELECT identity_envelope,status,version FROM clients WHERE id=?'
    ).bind(original.id).first()
    expect(row.status).toBe('paused')
    expect(row.version).toBe(2)
    expect(row.identity_envelope).not.toContain(body.name)
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM record_versions WHERE entity_id=? AND entity_type='client'"
    ).bind(original.id).first()).toEqual({ count: 2 })
    const scope = clientKeyScope(original.id)
    const versions = (await env.DB.prepare(
      `SELECT version,snapshot_envelope FROM record_versions
       WHERE entity_type='client' AND entity_id=? ORDER BY version`
    ).bind(original.id).all()).results
    const dataKey = await loadDataKey(env.DB, {
      envelope: JSON.parse(versions[0].snapshot_envelope), expectedScope: scope,
    })
    const snapshots = await Promise.all(versions.map(async (version) => JSON.parse(
      await decryptForScope(await ring(), dataKey, {
        expectedScope: scope, recordId: original.id, field: 'record_version',
        envelope: JSON.parse(version.snapshot_envelope),
      })
    )))
    expect(snapshots.map(({ schema, name, age, status, version }) => ({
      schema, name, age, status, version,
    }))).toEqual([
      { schema: 'client.v1', name: 'Fikcyjna', age: 12, status: 'active', version: 1 },
      { schema: 'client.v1', name: body.name, age: null, status: 'paused', version: 2 },
    ])
    expect(await env.DB.prepare(
      "SELECT action,metadata_json FROM audit_events WHERE entity_id=? AND action LIKE 'client.%' ORDER BY occurred_at DESC LIMIT 1"
    ).bind(original.id).first()).toEqual({
      action: 'client.updated', metadata_json: JSON.stringify({ clientVersion: 2 }),
    })

    const replayFactory = vi.fn()
    expect(await editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 2_000,
      correlationId: CORRELATION_ID, idFactory: replayFactory,
      clientId: original.id, body, idempotencyKey: 'client-edit-identity-success-0001',
    })).toEqual(result)
    expect(replayFactory).not.toHaveBeenCalled()
  })

  it('closes the exact assignment and inserts a new encrypted v1 without overwriting history', async () => {
    const original = await seedEditable()
    const values = ['new_assignment', 'reassign_client_ver', 'closed_assignment_ver',
      'new_assignment_ver', 'reassign_audit']
    const body = {
      expectedVersion: 1, name: original.name, age: original.age,
      status: 'active', specialistId: 'sp_client_self',
    }
    const result = await editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 2_000,
      correlationId: CORRELATION_ID, idFactory: () => values.shift(),
      clientId: original.id, body, idempotencyKey: 'client-edit-reassign-success-0001',
    })
    expect(result.body.data.client).toMatchObject({
      id: original.id, version: 2,
      assignment: { id: 'asg_new_assignment', specialistId: 'sp_client_self', version: 1 },
    })
    expect((await env.DB.prepare(
      `SELECT id,specialist_id,ends_at,version FROM client_assignments
       WHERE client_id=? ORDER BY created_at,id`
    ).bind(original.id).all()).results).toEqual([
      {
        id: original.assignment.id, specialist_id: 'sp_target',
        ends_at: new Date(NOW_MS + 2_000).toISOString(), version: 2,
      },
      { id: 'asg_new_assignment', specialist_id: 'sp_client_self', ends_at: null, version: 1 },
    ])
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM record_versions WHERE entity_id IN (?,?) AND entity_type='client_assignment'"
    ).bind(original.assignment.id, 'asg_new_assignment').first()).toEqual({ count: 3 })
    expect(await env.DB.prepare(
      "SELECT action,metadata_json FROM audit_events WHERE entity_id=? AND action='client.assignment.changed'"
    ).bind(original.id).first()).toEqual({
      action: 'client.assignment.changed',
      metadata_json: JSON.stringify({
        clientVersion: 2,
        closedAssignmentId: original.assignment.id,
        closedAssignmentVersion: 2,
        newAssignmentId: 'asg_new_assignment',
        newAssignmentVersion: 1,
      }),
    })
  })

  it('rejects stale and complete no-op edits without side effects', async () => {
    const original = await seedEditable()
    const count = async (table) => (await env.DB.prepare(
      `SELECT count(*) AS count FROM ${table} WHERE ${table === 'clients' ? 'id' : 'entity_id'}=?`
    ).bind(original.id).first()).count
    const before = {
      clients: await count('clients'),
      versions: await count('record_versions'),
      audits: (await env.DB.prepare(
        'SELECT count(*) AS count FROM audit_events WHERE entity_id=?'
      ).bind(original.id).first()).count,
    }
    const common = {
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 1_000,
      correlationId: CORRELATION_ID, idFactory: vi.fn(), clientId: original.id,
    }
    const stale = editClient({
      ...common,
      body: { expectedVersion: 2, name: original.name, age: original.age,
        status: original.status, specialistId: original.assignment.specialistId },
      idempotencyKey: 'client-edit-stale-0001',
    })
    await expect(stale).rejects.toMatchObject({
      message: 'VERSION_CONFLICT', details: { currentVersion: 1 },
    })
    const noOp = editClient({
      ...common,
      body: { expectedVersion: 1, name: original.name, age: original.age,
        status: original.status, specialistId: original.assignment.specialistId },
      idempotencyKey: 'client-edit-noop-0001',
    })
    await expect(noOp).rejects.toThrow('VALIDATION_FAILED/body')
    expect(common.idFactory).not.toHaveBeenCalled()
    expect({
      clients: await count('clients'),
      versions: await count('record_versions'),
      audits: (await env.DB.prepare(
        'SELECT count(*) AS count FROM audit_events WHERE entity_id=?'
      ).bind(original.id).first()).count,
    }).toEqual(before)
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM idempotency_records WHERE idempotency_key IN ('client-edit-stale-0001','client-edit-noop-0001')"
    ).first()).toEqual({ count: 0 })
  })

  it('allows a coordinator to edit a centre-scoped paused client', async () => {
    const client = await seedEditable({ status: 'paused' })
    const ids = ['coordinator_edit_client_ver_unique', 'coordinator_edit_audit_unique']
    const result = await editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_coord', role: 'coordinator', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => ids.shift(), clientId: client.id,
      body: { expectedVersion: 1, name: 'Koordynowana', age: client.age,
        status: 'active', specialistId: 'sp_target' },
      idempotencyKey: 'client-edit-coordinator-paused-0001',
    })
    expect(result.body.data.client).toMatchObject({
      id: client.id, name: 'Koordynowana', status: 'active', version: 2,
    })
  })

  it('makes absent, archived, and closed-assignment targets identically opaque', async () => {
    const archived = await seedEditable()
    const closed = await seedEditable()
    const closedAt = new Date(NOW_MS + 1_000).toISOString()
    await env.DB.prepare(
      `UPDATE client_assignments SET ends_at=?,version=2,updated_at=?
       WHERE client_id=? AND ends_at IS NULL`
    ).bind(closedAt, closedAt, closed.id).run()
    await env.DB.prepare(
      `UPDATE client_assignments SET ends_at=?,version=2,updated_at=?
       WHERE client_id=? AND ends_at IS NULL`
    ).bind(closedAt, closedAt, archived.id).run()
    await env.DB.prepare(
      "UPDATE clients SET status='archived',archived_at=?,version=2,updated_at=? WHERE id=?"
    ).bind(closedAt, closedAt, archived.id).run()
    const errors = []
    for (const [label, clientId] of [
      ['absent', 'cl_edit_absent'], ['archived', archived.id], ['closed', closed.id],
    ]) {
      const idFactory = vi.fn()
      try {
        await editClient({
          db: env.DB, recoveryDb: env.DB,
          actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
          keyring: await ring(), nowMs: NOW_MS + 2_000, correlationId: CORRELATION_ID,
          idFactory, clientId,
          body: { expectedVersion: 1, name: 'Nieujawniona', age: 12,
            status: 'active', specialistId: 'sp_target' },
          idempotencyKey: `client-edit-opaque-${label}-0001`,
        })
      } catch (error) { errors.push(error.message) }
      expect(idFactory).not.toHaveBeenCalled()
    }
    expect(errors).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND'])
  })

  it('rejects malformed retained current histories identically before IDs or writes', async () => {
    const envelopes = []
    for (const kind of [
      'missing', 'duplicate', 'wrong-entity', 'wrong-id', 'wrong-version',
      'wrong-key', 'malformed-envelope', 'mismatched-snapshot', 'tampered',
    ]) {
      const fixture = await seedMalformedHistory(kind)
      const retained = async () => ({
        client: await env.DB.prepare('SELECT * FROM clients WHERE id=?')
          .bind(fixture.clientId).first(),
        assignments: (await env.DB.prepare(
          'SELECT * FROM client_assignments WHERE client_id=? ORDER BY id'
        ).bind(fixture.clientId).all()).results,
        versions: (await env.DB.prepare(
          'SELECT * FROM record_versions WHERE entity_id=? OR entity_id=? ORDER BY id'
        ).bind(fixture.clientId, fixture.assignmentId).all()).results,
        audits: (await env.DB.prepare(
          'SELECT * FROM audit_events WHERE entity_id=? ORDER BY id'
        ).bind(fixture.clientId).all()).results,
        idempotency: (await env.DB.prepare(
          'SELECT * FROM idempotency_records WHERE resource_id=? ORDER BY idempotency_key'
        ).bind(fixture.clientId).all()).results,
      })
      const before = await retained()
      const idFactory = vi.fn()
      let message
      try {
        await editClient({
          db: env.DB, recoveryDb: env.DB,
          actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
          keyring: fixture.keyring, nowMs: NOW_MS + 1_000,
          correlationId: CORRELATION_ID, idFactory, clientId: fixture.clientId,
          body: { expectedVersion: 1, name: `Edycja ${kind}`, age: 12,
            status: 'active', specialistId: 'sp_target' },
          idempotencyKey: `client-edit-malformed-${kind}-0001`,
        })
      } catch (error) { message = error.message }
      expect(message, kind).toBe('NOT_FOUND')
      expect(idFactory, kind).not.toHaveBeenCalled()
      expect(await retained(), kind).toEqual(before)
      envelopes.push(message)
    }
    expect(new Set(envelopes)).toEqual(new Set(['NOT_FOUND']))
  })

  it('authenticates stale retained heads before disclosing their current version', async () => {
    const messages = []
    for (const kind of ['mismatched-snapshot', 'tampered']) {
      const fixture = await seedMalformedHistory(kind)
      const retained = async () => ({
        client: await env.DB.prepare('SELECT * FROM clients WHERE id=?')
          .bind(fixture.clientId).first(),
        assignment: await env.DB.prepare('SELECT * FROM client_assignments WHERE id=?')
          .bind(fixture.assignmentId).first(),
        versions: (await env.DB.prepare(
          'SELECT * FROM record_versions WHERE entity_id=? OR entity_id=? ORDER BY id'
        ).bind(fixture.clientId, fixture.assignmentId).all()).results,
        audits: (await env.DB.prepare(
          'SELECT * FROM audit_events WHERE entity_id=? ORDER BY id'
        ).bind(fixture.clientId).all()).results,
        idempotency: (await env.DB.prepare(
          'SELECT * FROM idempotency_records WHERE resource_id=? ORDER BY idempotency_key'
        ).bind(fixture.clientId).all()).results,
      })
      const before = await retained()
      const idFactory = vi.fn()
      let failure
      try {
        await editClient({
          db: env.DB, recoveryDb: env.DB,
          actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
          keyring: fixture.keyring, nowMs: NOW_MS + 1_000,
          correlationId: CORRELATION_ID, idFactory, clientId: fixture.clientId,
          body: { expectedVersion: 2, name: `Stale ${kind}`, age: 12,
            status: 'active', specialistId: 'sp_target' },
          idempotencyKey: `client-edit-stale-history-${kind}-0001`,
        })
      } catch (error) { failure = { message: error.message, details: error.details } }
      expect(failure, kind).toEqual({ message: 'NOT_FOUND', details: undefined })
      expect(idFactory, kind).not.toHaveBeenCalled()
      expect(await retained(), kind).toEqual(before)
      messages.push(failure.message)
    }
    expect(new Set(messages)).toEqual(new Set(['NOT_FOUND']))
  })

  it('unwraps the owning key before returning a stale version conflict', async () => {
    const messages = []
    for (const kind of ['missing-kek', 'unwrappable-key']) {
      const client = await seedEditable()
      let keyring = {}
      const dataKeyId = JSON.parse((await env.DB.prepare(
        'SELECT identity_envelope FROM clients WHERE id=?'
      ).bind(client.id).first()).identity_envelope).dataKeyId
      if (kind === 'unwrappable-key') {
        const row = await env.DB.prepare(
          'SELECT wrapped_key_b64,wrap_nonce_b64 FROM data_keys WHERE id=?'
        ).bind(dataKeyId).first()
        const flip = (value) => `${value.slice(0, -1)}${value.at(-1) === 'A' ? 'B' : 'A'}`
        await env.DB.prepare(
          'UPDATE data_keys SET wrapped_key_b64=?,wrap_nonce_b64=?,kek_version=2 WHERE id=?'
        ).bind(flip(row.wrapped_key_b64), flip(row.wrap_nonce_b64), dataKeyId).run()
        const base = await ring()
        keyring = Object.freeze({
          ...base,
          getDataKek: (version) => version === 2 ? base.getDataKek(1) : base.getDataKek(version),
        })
      }
      const retained = async () => ({
        client: await env.DB.prepare('SELECT * FROM clients WHERE id=?').bind(client.id).first(),
        assignment: (await env.DB.prepare(
          'SELECT * FROM client_assignments WHERE client_id=? ORDER BY id'
        ).bind(client.id).all()).results,
        key: await env.DB.prepare('SELECT * FROM data_keys WHERE id=?').bind(dataKeyId).first(),
        versions: (await env.DB.prepare(
          'SELECT * FROM record_versions WHERE entity_id=? OR entity_id=? ORDER BY id'
        ).bind(client.id, client.assignment.id).all()).results,
        audits: (await env.DB.prepare(
          'SELECT * FROM audit_events WHERE entity_id=? ORDER BY id'
        ).bind(client.id).all()).results,
        idempotency: (await env.DB.prepare(
          'SELECT * FROM idempotency_records WHERE resource_id=? ORDER BY idempotency_key'
        ).bind(client.id).all()).results,
      })
      const before = await retained()
      const idFactory = vi.fn()
      let failure
      try {
        await editClient({
          db: env.DB, recoveryDb: env.DB,
          actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
          keyring,
          nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
          idFactory, clientId: client.id,
          body: { expectedVersion: 2, name: client.name, age: client.age,
            status: client.status, specialistId: client.assignment.specialistId },
          idempotencyKey: `client-edit-stale-key-${kind}-0001`,
        })
      } catch (error) { failure = { message: error.message, details: error.details } }
      expect(failure, kind).toEqual({ message: 'CRYPTO_FAILURE', details: undefined })
      expect(idFactory, kind).not.toHaveBeenCalled()
      expect(await retained(), kind).toEqual(before)
      messages.push(failure.message)
    }
    expect(new Set(messages)).toEqual(new Set(['CRYPTO_FAILURE']))
  })

  it('contains hostile retained-history row descriptors without reading values', async () => {
    const getter = vi.fn(() => 'private-history')
    const hostile = Object.defineProperty({ id: 'cl_hostile_history' }, 'identity_envelope', {
      enumerable: true, get: getter,
    })
    let reads = 0
    const db = {
      prepare(sql) {
        return { bind() { return { async first() {
          reads += 1
          return sql.includes('idempotency_records') ? null : hostile
        } } } }
      },
      batch: vi.fn(),
    }
    const idFactory = vi.fn()
    await expect(editClient({
      db, recoveryDb: db,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: {}, nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory, clientId: 'cl_hostile_history',
      body: { expectedVersion: 1, name: 'Hostile', age: 12,
        status: 'active', specialistId: 'sp_target' },
      idempotencyKey: 'client-edit-hostile-history-0001',
    })).rejects.toThrow('NOT_FOUND')
    expect(reads).toBe(2)
    expect(getter).not.toHaveBeenCalled()
    expect(idFactory).not.toHaveBeenCalled()
    expect(db.batch).not.toHaveBeenCalled()
  })

  it('enforces specialist ownership, active scope, and opaque non-reassignment', async () => {
    const owned = await seedEditable({
      specialistId: 'sp_client_self',
      actor: { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' },
    })
    const values = ['edit_owned_specialist_client_version_unique', 'edit_owned_specialist_audit_unique']
    const result = await editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' },
      keyring: await ring(), nowMs: NOW_MS + 1_000,
      correlationId: CORRELATION_ID, idFactory: () => values.shift(), clientId: owned.id,
      body: { expectedVersion: 1, name: 'Własny Klient', age: 12,
        status: 'active', specialistId: 'sp_client_self' },
      idempotencyKey: 'client-edit-specialist-own-0001',
    })
    expect(result.body.data.client.name).toBe('Własny Klient')

    const paused = await seedEditable({
      status: 'paused',
      specialistId: 'sp_client_self',
      actor: { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' },
    })
    const cross = await seedEditable()
    for (const [label, clientId, body] of [
      ['paused', paused.id, { expectedVersion: 1, name: paused.name, age: paused.age,
        status: 'active', specialistId: 'sp_client_self' }],
      ['cross', cross.id, { expectedVersion: 1, name: 'X', age: 12,
        status: 'active', specialistId: 'sp_target' }],
    ]) {
      const factory = vi.fn()
      await expect(editClient({
        db: env.DB, recoveryDb: env.DB,
        actor: { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' },
        keyring: await ring(), nowMs: NOW_MS + 2_000,
        correlationId: CORRELATION_ID, idFactory: factory, clientId,
        body, idempotencyKey: `client-edit-specialist-${label}-0001`,
      })).rejects.toThrow('NOT_FOUND')
      expect(factory).not.toHaveBeenCalled()
    }

    const reassignTarget = await seedEditable({
      specialistId: 'sp_client_self',
      actor: { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' },
    })
    await expect(editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_self', role: 'specialist', specialistId: 'sp_client_self' },
      keyring: await ring(), nowMs: NOW_MS + 2_000,
      correlationId: CORRELATION_ID, idFactory: vi.fn(), clientId: reassignTarget.id,
      body: { expectedVersion: 1, name: reassignTarget.name, age: reassignTarget.age,
        status: 'active', specialistId: 'sp_target' },
      idempotencyKey: 'client-edit-specialist-reassign-0001',
    })).rejects.toThrow('CLIENT_ASSIGNMENT_CONFLICT')
  })

  it('blocks future old-practitioner visits but allows cancelled and past visits', async () => {
    const insertAppointment = async (clientId, id, startsAt, status) => {
      const endsAt = new Date(Date.parse(startsAt) + 50 * 60 * 1000).toISOString()
      await env.DB.prepare(
        `INSERT INTO appointments
         (id,client_id,specialist_id,service_id,starts_at,ends_at,time_zone,location,
          status,source,version,cancelled_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id, clientId, 'sp_target', 'zajecia', startsAt, endsAt, 'Europe/Warsaw', null,
        status, 'panel', 1, status === 'cancelled' ? startsAt : null,
        new Date(NOW_MS - 10_000).toISOString(), new Date(NOW_MS - 10_000).toISOString(),
      ).run()
    }
    const blocked = await seedEditable()
    await insertAppointment(
      blocked.id, 'apt_edit_future_block', new Date(NOW_MS + 60_000).toISOString(), 'scheduled',
    )
    const bodyFor = (client) => ({
      expectedVersion: 1, name: client.name, age: client.age, status: 'active',
      specialistId: 'sp_client_self',
    })
    await expect(editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: vi.fn(), clientId: blocked.id, body: bodyFor(blocked),
      idempotencyKey: 'client-edit-future-block-0001',
    })).rejects.toThrow('CLIENT_ASSIGNMENT_CONFLICT')

    for (const [label, offset, status] of [
      ['cancelled', 60_000, 'cancelled'],
      ['past', -60_000, 'completed'],
    ]) {
      const client = await seedEditable()
      await insertAppointment(
        client.id, `apt_edit_${label}_allow`, new Date(NOW_MS + offset).toISOString(), status,
      )
      const ids = [`${label}_new_asg`, `${label}_client_ver`, `${label}_old_asg_ver`,
        `${label}_new_asg_ver`, `${label}_audit`]
      expect((await editClient({
        db: env.DB, recoveryDb: env.DB,
        actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
        keyring: await ring(), nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
        idFactory: () => ids.shift(), clientId: client.id, body: bodyFor(client),
        idempotencyKey: `client-edit-${label}-allow-0001`,
      })).status).toBe(200)
    }
  })

  it('keeps normal and reassignment work within exact measured budgets', async () => {
    const keyring = await ring()
    const normalClient = await seedEditable()
    const normalBudget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const normalIds = ['budget_normal_client_ver', 'budget_normal_audit']
    await editClient({
      db: normalBudget.work, recoveryDb: normalBudget.recovery,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring, nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => normalIds.shift(), clientId: normalClient.id,
      body: { expectedVersion: 1, name: 'Budżet Zwykły', age: 12,
        status: 'active', specialistId: 'sp_target' },
      idempotencyKey: 'client-edit-budget-normal-0001',
    })
    expect(usageForD1QueryBudgetViews(normalBudget.work, normalBudget.recovery)).toEqual({
      used: 8, remaining: 42, workRemaining: 34,
      totalLimit: 50, recoveryReserve: 8,
    })

    const reassignedClient = await seedEditable()
    const reassignedBudget = createD1QueryBudget(env.DB, { totalLimit: 50, recoveryReserve: 8 })
    const reassignIds = ['budget_new_asg', 'budget_reassign_client_ver',
      'budget_reassign_old_ver', 'budget_reassign_new_ver', 'budget_reassign_audit']
    await editClient({
      db: reassignedBudget.work, recoveryDb: reassignedBudget.recovery,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring, nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => reassignIds.shift(), clientId: reassignedClient.id,
      body: { expectedVersion: 1, name: reassignedClient.name, age: 12,
        status: 'active', specialistId: 'sp_client_self' },
      idempotencyKey: 'client-edit-budget-reassign-0001',
    })
    expect(usageForD1QueryBudgetViews(reassignedBudget.work, reassignedBudget.recovery)).toEqual({
      used: 14, remaining: 36, workRemaining: 28,
      totalLimit: 50, recoveryReserve: 8,
    })
  })

  it('builds the exact ordered five- and nine-statement optimistic UOWs', async () => {
    const keyring = await ring()
    for (const reassigned of [false, true]) {
      const client = await seedEditable()
      let batchSql
      const innerByStatement = new WeakMap()
      const statement = (sql, inner) => {
        const wrapped = {
          sql,
          bind(...bindings) { return statement(sql, inner.bind(...bindings)) },
          first: (...args) => inner.first(...args),
          all: (...args) => inner.all(...args),
          raw: (...args) => inner.raw(...args),
          run: (...args) => inner.run(...args),
        }
        innerByStatement.set(wrapped, inner)
        return wrapped
      }
      const db = {
        prepare: (sql) => statement(sql, env.DB.prepare(sql)),
        batch: async (statements) => {
          batchSql = statements.map(({ sql }) => sql.replace(/\s+/g, ' ').trim())
          return env.DB.batch(statements.map((current) => innerByStatement.get(current)))
        },
      }
      const marker = reassigned ? 'ordered_reassign' : 'ordered_normal'
      const ids = reassigned
        ? [`${marker}_asg`, `${marker}_client_ver`, `${marker}_old_ver`,
            `${marker}_new_ver`, `${marker}_audit`]
        : [`${marker}_client_ver`, `${marker}_audit`]
      await editClient({
        db, recoveryDb: env.DB,
        actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
        keyring, nowMs: NOW_MS + 3_000, correlationId: CORRELATION_ID,
        idFactory: () => ids.shift(), clientId: client.id,
        body: { expectedVersion: 1, name: reassigned ? client.name : 'Uporządkowana',
          age: client.age, status: 'active',
          specialistId: reassigned ? 'sp_client_self' : 'sp_target' },
        idempotencyKey: `client-edit-${marker}-key`,
      })
      expect(batchSql).toEqual(reassigned ? [
        expect.stringMatching(/^UPDATE clients /),
        expect.stringMatching(/^UPDATE client_assignments /),
        expect.stringMatching(/^INSERT INTO client_assignments /),
        expect.stringMatching(/^INSERT INTO record_versions /),
        expect.stringMatching(/^INSERT INTO record_versions /),
        expect.stringMatching(/^INSERT INTO record_versions /),
        expect.stringMatching(/^INSERT INTO audit_events /),
        expect.stringMatching(/^INSERT INTO idempotency_records /),
        expect.stringMatching(/^INSERT INTO core_directory_invariant_failures /),
      ] : [
        expect.stringMatching(/^UPDATE clients /),
        expect.stringMatching(/^INSERT INTO record_versions /),
        expect.stringMatching(/^INSERT INTO audit_events /),
        expect.stringMatching(/^INSERT INTO idempotency_records /),
        expect.stringMatching(/^INSERT INTO core_directory_invariant_failures /),
      ])
    }
  })

  it.each([
    ['normal', 5, false],
    ['reassignment', 9, true],
  ])('rolls back every %s edit statement position byte-for-byte', async (_label, size, reassigned) => {
    const keyring = await ring()
    for (let failedAt = 0; failedAt < size; failedAt += 1) {
      const client = await seedEditable()
      const marker = `${reassigned ? 'reassign' : 'normal'}_rollback_${failedAt}`
      const tables = async () => ({
        client: await env.DB.prepare('SELECT * FROM clients WHERE id=?').bind(client.id).first(),
        assignments: (await env.DB.prepare(
          'SELECT * FROM client_assignments WHERE client_id=? ORDER BY id'
        ).bind(client.id).all()).results,
        versions: (await env.DB.prepare(
          'SELECT * FROM record_versions WHERE entity_id=? OR entity_id=? ORDER BY id'
        ).bind(client.id, client.assignment.id).all()).results,
        audits: (await env.DB.prepare(
          'SELECT * FROM audit_events WHERE entity_id=? ORDER BY id'
        ).bind(client.id).all()).results,
        idempotency: (await env.DB.prepare(
          'SELECT * FROM idempotency_records WHERE resource_id=? ORDER BY idempotency_key'
        ).bind(client.id).all()).results,
      })
      const before = await tables()
      const db = {
        prepare: (sql) => env.DB.prepare(sql),
        batch: (statements) => env.DB.batch(statements.map((statement, index) => (
          index === failedAt
            ? env.DB.prepare("INSERT INTO core_directory_invariant_failures (failure_kind) VALUES ('forced')")
            : statement
        ))),
      }
      const ids = reassigned
        ? [`${marker}_asg`, `${marker}_client_ver`, `${marker}_old_ver`,
            `${marker}_new_ver`, `${marker}_audit`]
        : [`${marker}_client_ver`, `${marker}_audit`]
      await expect(editClient({
        db, recoveryDb: env.DB,
        actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
        keyring, nowMs: NOW_MS + 5_000, correlationId: CORRELATION_ID,
        idFactory: () => ids.shift(), clientId: client.id,
        body: {
          expectedVersion: 1,
          name: reassigned ? client.name : `Rollback ${failedAt}`,
          age: client.age, status: 'active',
          specialistId: reassigned ? 'sp_client_self' : 'sp_target',
        },
        idempotencyKey: `client-edit-${marker}-key`,
      })).rejects.toThrow()
      expect(await tables()).toEqual(before)
    }
  })

  it('recovers the exact concurrent idempotency winner with two reserved reads', async () => {
    const keyring = await ring()
    const client = await seedEditable()
    const key = 'client-edit-concurrent-replay-0001'
    const body = { expectedVersion: 1, name: 'Wygrana', age: 12,
      status: 'active', specialistId: 'sp_target' }
    let raced = false
    let budget
    let usageBeforeRecovery
    const rawDb = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch() {
        usageBeforeRecovery = budget.usage()
        if (!raced) {
          raced = true
          const winnerIds = ['concurrent_winner_client_ver', 'concurrent_winner_audit']
          await editClient({
            db: env.DB, recoveryDb: env.DB,
            actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
            keyring, nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
            idFactory: () => winnerIds.shift(), clientId: client.id, body,
            idempotencyKey: key,
          })
        }
        throw new Error('identity_collision: SQLITE_CONSTRAINT')
      },
    }
    budget = createD1QueryBudget(rawDb, { totalLimit: 50, recoveryReserve: 8 })
    const loserIds = ['concurrent_loser_client_ver', 'concurrent_loser_audit']
    const result = await editClient({
      db: budget.work, recoveryDb: budget.recovery,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring, nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => loserIds.shift(), clientId: client.id, body,
      idempotencyKey: key,
    })
    expect(result.body.data.client.name).toBe('Wygrana')
    expect(usageBeforeRecovery.used).toBe(8)
    expect(usageForD1QueryBudgetViews(budget.work, budget.recovery).used).toBe(10)
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM record_versions WHERE id='ver_concurrent_loser_client_ver'"
    ).first()).toEqual({ count: 0 })
  })

  it('rejects a reused edit key with a different resource-bound digest', async () => {
    const client = await seedEditable()
    const ids = ['digest_conflict_client_ver', 'digest_conflict_audit']
    const body = { expectedVersion: 1, name: 'Pierwsza Treść', age: 12,
      status: 'active', specialistId: 'sp_target' }
    await editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => ids.shift(), clientId: client.id, body,
      idempotencyKey: 'client-edit-digest-conflict-0001',
    })
    await expect(editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 2_000, correlationId: CORRELATION_ID,
      idFactory: vi.fn(), clientId: client.id,
      body: { ...body, name: 'Druga Treść' },
      idempotencyKey: 'client-edit-digest-conflict-0001',
    })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  })

  it('rejects duplicate generated reassignment IDs before any write', async () => {
    const client = await seedEditable()
    const before = await env.DB.prepare('SELECT * FROM clients WHERE id=?').bind(client.id).first()
    await expect(editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => 'duplicate', clientId: client.id,
      body: { expectedVersion: 1, name: client.name, age: client.age,
        status: 'active', specialistId: 'sp_client_self' },
      idempotencyKey: 'client-edit-duplicate-helper-0001',
    })).rejects.toThrow('INTERNAL_ERROR')
    expect(await env.DB.prepare('SELECT * FROM clients WHERE id=?').bind(client.id).first())
      .toEqual(before)
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM idempotency_records WHERE idempotency_key='client-edit-duplicate-helper-0001'"
    ).first()).toEqual({ count: 0 })
  })

  it('contains a concurrent different-key loser as a version conflict', async () => {
    const keyring = await ring()
    const client = await seedEditable()
    const winnerBody = { expectedVersion: 1, name: 'Pierwszy Zapis', age: 12,
      status: 'active', specialistId: 'sp_target' }
    const loserBody = { ...winnerBody, name: 'Drugi Zapis' }
    let raced = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!raced) {
          raced = true
          const winnerIds = ['different_winner_client_ver', 'different_winner_audit']
          await editClient({
            db: env.DB, recoveryDb: env.DB,
            actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
            keyring, nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
            idFactory: () => winnerIds.shift(), clientId: client.id,
            body: winnerBody, idempotencyKey: 'client-edit-different-winner-0001',
          })
        }
        return env.DB.batch(statements)
      },
    }
    const loserIds = ['different_loser_client_ver', 'different_loser_audit']
    await expect(editClient({
      db, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring, nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => loserIds.shift(), clientId: client.id,
      body: loserBody, idempotencyKey: 'client-edit-different-loser-0001',
    })).rejects.toMatchObject({
      message: 'VERSION_CONFLICT', details: { currentVersion: 2 },
    })
    expect(await env.DB.prepare(
      'SELECT version FROM clients WHERE id=?'
    ).bind(client.id).first()).toEqual({ version: 2 })
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM record_versions WHERE id='ver_different_loser_client_ver'"
    ).first()).toEqual({ count: 0 })
  })

  it('contains a concurrent different reassignment without extra open history', async () => {
    const keyring = await ring()
    const client = await seedEditable()
    const winnerBody = { expectedVersion: 1, name: client.name, age: 12,
      status: 'active', specialistId: 'sp_client_self' }
    const loserBody = { ...winnerBody, name: 'Przegrana Zmiana' }
    let raced = false
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        if (!raced) {
          raced = true
          const winnerIds = ['reassign_race_winner_asg', 'reassign_race_winner_client_ver',
            'reassign_race_winner_old_ver', 'reassign_race_winner_new_ver',
            'reassign_race_winner_audit']
          await editClient({
            db: env.DB, recoveryDb: env.DB,
            actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
            keyring, nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
            idFactory: () => winnerIds.shift(), clientId: client.id,
            body: winnerBody, idempotencyKey: 'client-edit-reassign-race-winner-0001',
          })
        }
        return env.DB.batch(statements)
      },
    }
    const loserIds = ['reassign_race_loser_asg', 'reassign_race_loser_client_ver',
      'reassign_race_loser_old_ver', 'reassign_race_loser_new_ver',
      'reassign_race_loser_audit']
    await expect(editClient({
      db, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring, nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => loserIds.shift(), clientId: client.id,
      body: loserBody, idempotencyKey: 'client-edit-reassign-race-loser-0001',
    })).rejects.toMatchObject({
      message: 'VERSION_CONFLICT', details: { currentVersion: 2 },
    })
    expect(await env.DB.prepare(
      'SELECT count(*) AS count FROM client_assignments WHERE client_id=? AND ends_at IS NULL'
    ).bind(client.id).first()).toEqual({ count: 1 })
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM client_assignments WHERE id='asg_reassign_race_loser_asg'"
    ).first()).toEqual({ count: 0 })
    expect(await env.DB.prepare(
      'SELECT count(*) AS count FROM client_assignments WHERE client_id=?'
    ).bind(client.id).first()).toEqual({ count: 2 })
  })

  it('fails closed when the owning client KEK is retired before replay', async () => {
    const client = await seedEditable()
    const ids = ['retired_replay_client_ver', 'retired_replay_audit']
    const body = { expectedVersion: 1, name: 'Klucz Retired', age: 12,
      status: 'active', specialistId: 'sp_target' }
    await editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: await ring(), nowMs: NOW_MS + 1_000, correlationId: CORRELATION_ID,
      idFactory: () => ids.shift(), clientId: client.id, body,
      idempotencyKey: 'client-edit-retired-replay-0001',
    })
    await expect(editClient({
      db: env.DB, recoveryDb: env.DB,
      actor: { id: 'stf_client_owner', role: 'owner', specialistId: null },
      keyring: {}, nowMs: NOW_MS + 3_000, correlationId: CORRELATION_ID,
      idFactory: vi.fn(), clientId: client.id, body,
      idempotencyKey: 'client-edit-retired-replay-0001',
    })).rejects.toThrow('CRYPTO_FAILURE')
  })

  it('serves edit through the real HTTP security and shared-budget path', async () => {
    const client = await seedEditable()
    const ids = ['http_edit_client_ver_unique', 'http_edit_audit_unique']
    let usage
    const service = async (options) => {
      try { return await editClient(options) } finally {
        usage = usageForD1QueryBudgetViews(options.db, options.recoveryDb)
      }
    }
    const app = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://panel.bearwithme.pl', dataMode: 'fictional' },
      db: env.DB,
      cryptoContext: { keyring: await ring(), dataKey: {}, scope: {} },
      resolveAccessPrincipal: vi.fn(async () => ({
        kind: 'human', subject: 'access-client-edit-http', normalizedEmail: 'edit-http@example.test',
      })),
      resolveActor: vi.fn(async () => ({
        id: 'stf_client_owner', role: 'owner', specialistId: null, version: 1,
      })),
      verifyCsrfToken: vi.fn(async () => true),
      readJsonBodyOnce: vi.fn(async (request) => request.json()),
      editClient: service,
      idFactory: vi.fn(() => ids.shift()),
      safeLog: vi.fn(),
      now: () => NOW_MS + 1_000,
    })
    const response = await app.request(`/api/v1/clients/${client.id}/edits`, {
      method: 'POST',
      headers: {
        origin: 'https://panel.bearwithme.pl', 'content-type': 'application/json',
        'idempotency-key': 'client-edit-http-success-0001', 'x-csrf-token': 'valid',
        'x-correlation-id': CORRELATION_ID,
      },
      body: JSON.stringify({ expectedVersion: 1, name: 'HTTP Edycja', age: 12,
        status: 'paused', specialistId: 'sp_target' }),
    })
    expect(response.status).toBe(200)
    expect((await response.json()).data.client).toMatchObject({
      id: client.id, name: 'HTTP Edycja', status: 'paused', version: 2,
    })
    expect(usage).toEqual({
      used: 8, remaining: 42, workRemaining: 34,
      totalLimit: 50, recoveryReserve: 8,
    })
  })
})
