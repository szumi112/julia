import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createClientNote, listClientNotes } from '../../worker/core/client-notes.js'
import { createApp } from '../../worker/app.js'
import { buildClientDataKey, encryptClientIdentity } from '../../worker/core/crypto.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  completeCoreDirectoryStageA,
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  applyAuthenticationStageF,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const NOW_MS = Date.parse('2027-01-15T10:00:00.000Z')
const NOW = new Date(NOW_MS).toISOString()
const CORRELATION_ID = '00000000-0000-4000-8000-000000000029'
const lead = authorityActor({ id: 'stf_note_lead', role: 'specialist', specialistId: 'sp_note_lead' })
const other = authorityActor({ id: 'stf_note_other', role: 'specialist', specialistId: 'sp_note_other' })
const dualOwner = authorityActor({ id: 'stf_note_owner', role: 'owner', specialistId: 'sp_note_owner' })
const owner = authorityActor({ id: 'stf_note_admin', role: 'owner' })
const coordinator = authorityActor({ id: 'stf_note_coord', role: 'coordinator' })
const keyring = () => createKeyring(env, {
  activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1,
})

let sequence = 0
const nextId = (prefix) => `${prefix}_note_test_${++sequence}`
const write = (clientId, actor = lead, text = 'Fikcyjna obserwacja.', options = {}) => {
  const noteId = options.noteId ?? nextId('note')
  const auditId = options.auditId ?? nextId('audit')
  const ids = [noteId, auditId]
  return createClientNote({
    db: options.db ?? env.DB,
    recoveryDb: options.recoveryDb ?? env.DB,
    actor, keyring: options.keyring ?? options.ring,
    nowMs: options.nowMs ?? NOW_MS,
    correlationId: CORRELATION_ID,
    idFactory: () => ids.shift(),
    clientId,
    body: { text },
    idempotencyKey: options.idempotencyKey ?? `note-test-${++sequence}-key`,
  })
}

const read = (clientId, actor = lead, query = {}) => listClientNotes({
  db: env.DB, actor, keyring: read.ring, nowMs: NOW_MS, clientId, query,
})

const seedStaff = async (actor) => {
  await env.DB.prepare(`INSERT INTO staff_users
    (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,
     specialist_id,version,activated_at,disabled_at,created_at,updated_at)
    VALUES (?,?,'{}','{}',?,'active',?,?,1,?,NULL,?,?)`
  ).bind(actor.id, `lookup_${actor.id}`, actor.role, `access_${actor.id}`,
    actor.specialistId, NOW, NOW, NOW).run()
  if (actor.specialistId) {
    await env.DB.prepare(`INSERT INTO specialists
      (id,staff_user_id,display_name_envelope,standard_rate_grosze,status,version,
       archived_at,created_at,updated_at)
      VALUES (?,?,'{}',18000,'active',1,NULL,?,?)`
    ).bind(actor.specialistId, actor.id, NOW, NOW).run()
  }
}

const seedClient = async (clientId, specialistId) => {
  const built = await buildClientDataKey(env.DB, read.ring, {
    clientId, dataKeyId: `key_${clientId}`, createdAt: NOW,
  })
  const envelope = await encryptClientIdentity({
    keyring: read.ring, dataKey: built.row, scope: built.scope,
  }, { clientId, name: 'Fikcyjna Klientka', age: 12 })
  await env.DB.batch([
    built.statement,
    env.DB.prepare(`INSERT INTO clients
      (id,identity_envelope,status,version,archived_at,created_at,updated_at)
      VALUES (?,?,'active',1,NULL,?,?)`).bind(clientId, envelope, NOW, NOW),
    env.DB.prepare(`INSERT INTO client_assignments
      (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
       version,created_at,updated_at)
      VALUES (?,?,?,?,NULL,?,1,?,?)`
    ).bind(`asg_${clientId.slice(3)}`, clientId, specialistId, NOW, owner.id, NOW, NOW),
  ])
}

beforeAll(async () => {
  expect(await completeCoreDirectoryStageA()).toMatchObject({ status: 'complete' })
  await applyCoreDirectoryStageB()
  await applyFinanceStageC()
  await applySpecialistProfilesStageD()
  await applyWorkbookRegistryStageE()
  await applyAuthenticationStageF()
  read.ring = await keyring()
  for (const actor of [lead, other, dualOwner, owner, coordinator]) await seedStaff(actor)
  for (const [clientId, specialistId] of [
    ['cl_note_lead', lead.specialistId], ['cl_note_owner', dualOwner.specialistId],
    ['cl_note_page', lead.specialistId], ['cl_note_reassign', lead.specialistId],
    ['cl_note_atomic', lead.specialistId], ['cl_note_guard', lead.specialistId],
    ['cl_note_concurrent', lead.specialistId],
    ['cl_note_authority', lead.specialistId],
  ]) await seedClient(clientId, specialistId)
})

describe('private client session notes', () => {
  it('lets only the current assigned specialist read and create, including a dual-role owner', async () => {
    for (const actor of [other, owner, coordinator, dualOwner]) {
      await expect(read('cl_note_lead', actor)).rejects.toThrow('NOT_FOUND')
      await expect(write('cl_note_lead', actor, 'Fikcyjna prywatna uwaga.', { ring: read.ring }))
        .rejects.toThrow('NOT_FOUND')
    }
    const result = await write('cl_note_owner', dualOwner, 'Fikcyjna uwaga właścicielki.', { ring: read.ring })
    expect(result.body.data.note.authorStaffId).toBe(dualOwner.id)
    expect((await read('cl_note_owner', dualOwner)).body.data.items).toEqual([result.body.data.note])
  })

  it('stores only ciphertext and a generic audit event while returning the author and date', async () => {
    const text = 'Fikcyjna obserwacja.\nNastępna sesja.'
    const result = await write('cl_note_lead', lead, text, { ring: read.ring })
    const note = result.body.data.note
    expect(result.status).toBe(201)
    expect(note).toMatchObject({
      clientId: 'cl_note_lead', authorStaffId: lead.id,
      authorSpecialistId: lead.specialistId, createdAt: NOW, text,
    })
    const stored = await env.DB.prepare('SELECT * FROM client_session_notes WHERE id=?')
      .bind(note.id).first()
    expect(stored.body_envelope).not.toContain(text)
    expect(JSON.parse(stored.body_envelope)).toMatchObject({ algorithm: 'A256GCM' })
    const audit = await env.DB.prepare(`SELECT metadata_json,reason_envelope
      FROM audit_events WHERE action='client.note.created' AND entity_id=?`
    ).bind(note.clientId).first()
    expect(audit).toEqual({ metadata_json: '{}', reason_envelope: null })
    const idempotency = await env.DB.prepare(`SELECT request_hash,response_envelope
      FROM idempotency_records WHERE resource_id=? AND operation='clients.notes.create'`
    ).bind(note.clientId).first()
    expect(JSON.stringify({ stored, audit, idempotency })).not.toContain(text)
  })

  it('returns newest-first pages bound to the author, assignment and limit', async () => {
    const first = await write('cl_note_page', lead, 'Fikcyjna pierwsza.', { ring: read.ring, nowMs: NOW_MS + 1 })
    const second = await write('cl_note_page', lead, 'Fikcyjna druga.', { ring: read.ring, nowMs: NOW_MS + 2 })
    const third = await write('cl_note_page', lead, 'Fikcyjna trzecia.', { ring: read.ring, nowMs: NOW_MS + 3 })
    const page = (await read('cl_note_page', lead, { limit: 2 })).body.data
    expect(page.items.map((note) => note.id)).toEqual([
      third.body.data.note.id, second.body.data.note.id,
    ])
    expect(typeof page.nextCursor).toBe('string')
    const tail = (await read('cl_note_page', lead, { limit: 2, cursor: page.nextCursor })).body.data
    expect(tail.items.map((note) => note.id)).toEqual([first.body.data.note.id])
    expect(tail.nextCursor).toBeNull()
    await expect(read('cl_note_page', lead, { limit: 3, cursor: page.nextCursor }))
      .rejects.toThrow('VALIDATION_FAILED')
    await expect(read('cl_note_lead', lead, { limit: 2, cursor: page.nextCursor }))
      .rejects.toThrow('VALIDATION_FAILED')
  })

  it('does not duplicate notes on the same idempotency key and rejects a changed request', async () => {
    const idempotencyKey = `note-retry-${++sequence}-key`
    const first = await write('cl_note_lead', lead, 'Fikcyjna ponawiana.', { ring: read.ring, idempotencyKey })
    const replay = await write('cl_note_lead', lead, 'Fikcyjna ponawiana.', { ring: read.ring, idempotencyKey })
    expect(replay).toEqual(first)
    await expect(write('cl_note_lead', lead, 'Inna fikcyjna treść.', { ring: read.ring, idempotencyKey }))
      .rejects.toThrow('IDEMPOTENCY_CONFLICT')
    expect((await env.DB.prepare('SELECT count(*) AS count FROM client_session_notes WHERE client_id=? AND id=?')
      .bind('cl_note_lead', first.body.data.note.id).first()).count).toBe(1)
  })

  it('settles concurrent same-key retries as one stored note', async () => {
    const idempotencyKey = `note-concurrent-${++sequence}-key`
    const requests = [0, 1].map(() => write(
      'cl_note_concurrent', lead, 'Fikcyjna równoległa.',
      { ring: read.ring, idempotencyKey },
    ))
    const [first, second] = await Promise.all(requests)
    expect(second).toEqual(first)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM client_session_notes
      WHERE client_id='cl_note_concurrent'`
    ).first()).count).toBe(1)
  })

  it('invalidates former lead access before note text or idempotency replay can be exposed', async () => {
    const idempotencyKey = `note-reassign-${++sequence}-key`
    const result = await write('cl_note_reassign', lead, 'Fikcyjna dawna uwaga.', { ring: read.ring, idempotencyKey })
    await env.DB.prepare(`UPDATE client_assignments
      SET ends_at=?,version=2,updated_at=? WHERE client_id=? AND ends_at IS NULL`
    ).bind(new Date(NOW_MS + 1000).toISOString(), new Date(NOW_MS + 1000).toISOString(), 'cl_note_reassign').run()
    await env.DB.prepare(`INSERT INTO client_assignments
      (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
       version,created_at,updated_at)
      VALUES (?,?,?,?,NULL,?,1,?,?)`
    ).bind('asg_note_reassigned', 'cl_note_reassign', other.specialistId,
      new Date(NOW_MS + 1000).toISOString(), owner.id,
      new Date(NOW_MS + 1000).toISOString(), new Date(NOW_MS + 1000).toISOString()).run()
    await expect(read('cl_note_reassign', lead)).rejects.toThrow('NOT_FOUND')
    await expect(write('cl_note_reassign', lead, result.body.data.note.text,
      { ring: read.ring, idempotencyKey })).rejects.toThrow('NOT_FOUND')
    expect((await read('cl_note_reassign', other)).body.data.items).toEqual([])
  })

  it('rolls back the note and idempotency record when audit insertion fails', async () => {
    const auditId = 'note_collision'
    await write('cl_note_atomic', lead, 'Fikcyjna pierwsza audytowana.', {
      ring: read.ring, auditId,
    })
    const before = await env.DB.prepare('SELECT count(*) AS count FROM client_session_notes WHERE client_id=?')
      .bind('cl_note_atomic').first()
    await expect(write('cl_note_atomic', lead, 'Fikcyjna druga audytowana.', {
      ring: read.ring, auditId,
    })).rejects.toThrow()
    expect((await env.DB.prepare('SELECT count(*) AS count FROM client_session_notes WHERE client_id=?')
      .bind('cl_note_atomic').first()).count).toBe(before.count)
  })

  it('rolls back a write when the assignment changes just before the command batch', async () => {
    const db = {
      prepare: (sql) => env.DB.prepare(sql),
      async batch(statements) {
        const changedAt = new Date(NOW_MS + 1000).toISOString()
        await env.DB.prepare(`UPDATE client_assignments
          SET ends_at=?,version=2,updated_at=? WHERE client_id=? AND ends_at IS NULL`
        ).bind(changedAt, changedAt, 'cl_note_guard').run()
        await env.DB.prepare(`INSERT INTO client_assignments
          (id,client_id,specialist_id,starts_at,ends_at,assigned_by_staff_id,
           version,created_at,updated_at)
          VALUES (?,?,?,?,NULL,?,1,?,?)`
        ).bind('asg_note_guard_new', 'cl_note_guard', other.specialistId,
          changedAt, owner.id, changedAt, changedAt).run()
        return env.DB.batch(statements)
      },
    }
    await expect(write('cl_note_guard', lead, 'Fikcyjna spóźniona uwaga.', {
      ring: read.ring, db,
    })).rejects.toThrow('NOT_FOUND')
    expect((await env.DB.prepare('SELECT count(*) AS count FROM client_session_notes WHERE client_id=?')
      .bind('cl_note_guard').first()).count).toBe(0)
    expect((await env.DB.prepare(`SELECT count(*) AS count FROM audit_events
      WHERE entity_id=? AND action='client.note.created'`
    ).bind('cl_note_guard').first()).count).toBe(0)
  })

  it('serves the real HTTP route for the lead and keeps a non-leading owner out', async () => {
    const appFor = (actor) => createApp({
      config: { appEnv: 'staging', appOrigin: 'https://notes.example.test', dataMode: 'fictional' },
      db: env.DB, keyring: read.ring, cryptoContext: { keyring: read.ring },
      now: () => NOW_MS,
      idFactory: () => nextId('cno'),
      resolveAccessPrincipal: async () => ({
        kind: 'human', subject: `access-${actor.id}`, normalizedEmail: `${actor.id}@example.test`,
      }),
      resolveActor: async () => actor,
      verifyCsrfToken: async () => true,
      safeLog: () => {},
    })
    const path = '/api/v1/clients/cl_note_lead/notes'
    const denied = await appFor(owner).request(`${path}?limit=20`)
    expect(denied.status).toBe(404)
    const leadApp = createApp({
      config: { appEnv: 'staging', appOrigin: 'https://notes.example.test', dataMode: 'fictional' },
      db: env.DB, keyring: read.ring, cryptoContext: { keyring: read.ring },
      now: () => NOW_MS,
      resolveAccessPrincipal: async () => ({
        kind: 'human', subject: 'access-note-lead', normalizedEmail: 'note-lead@example.test',
      }),
      resolveActor: async () => lead,
      verifyCsrfToken: async () => true,
      safeLog: () => {},
    })
    const posted = await leadApp.request(path, {
      method: 'POST',
      headers: {
        origin: 'https://notes.example.test', 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', 'x-csrf-token': 'valid',
        'idempotency-key': 'note-http-create-0001',
      },
      body: JSON.stringify({ text: 'Fikcyjna notatka HTTP.' }),
    })
    expect(posted.status).toBe(201)
    const created = (await posted.json()).data.note
    expect(created).toMatchObject({ text: 'Fikcyjna notatka HTTP.' })
    expect(created.id).toMatch(/^cno_[a-f0-9]{32}$/)
    const listed = await leadApp.request(`${path}?limit=20`)
    expect(listed.status).toBe(200)
    expect((await listed.json()).data.items).toContainEqual(created)
    const deniedPost = await appFor(owner).request(path, {
      method: 'POST',
      headers: {
        origin: 'https://notes.example.test', 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', 'x-csrf-token': 'valid',
        'idempotency-key': 'note-http-owner-0001',
      },
      body: JSON.stringify({ text: 'Fikcyjna niedozwolona.' }),
    })
    expect(deniedPost.status).toBe(404)
  })

  it('rejects a stale authority revision before reading ciphertext', async () => {
    await write('cl_note_authority', lead, 'Fikcyjna uwaga przed zmianą dostępu.', { ring: read.ring })
    await env.DB.prepare('UPDATE staff_authorities SET revision=2,updated_at=? WHERE staff_id=?')
      .bind(new Date(NOW_MS + 1).toISOString(), lead.id).run()
    await expect(read('cl_note_authority', lead)).rejects.toThrow('NOT_FOUND')
    await expect(write('cl_note_authority', lead, 'Fikcyjna po zmianie.', { ring: read.ring }))
      .rejects.toThrow('NOT_FOUND')
  })
})
