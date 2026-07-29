import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createKeyring } from '../../worker/security/keyring.js'
import { blindEmailIndex, decryptForScope, encryptForScope, getOrCreateDataKey } from '../../worker/security/envelope.js'
import { reindexEmailLookupsBatch, resolveActor, verifyNoOldEmailLookups } from '../../worker/identity/staff.js'
import { NOW_MS, TEST_IDENTITIES } from './fixtures.js'

const scope = { type: 'staff_directory', id: 'centre_1', purpose: 'identity' }
const instant = new Date(NOW_MS).toISOString()
const cryptoContext = async () => {
  const keyring = await createKeyring(env, { activeDataKekVersion: 1, activeLookupKeyVersion: 1, activeBackupKekVersion: 1 })
  return { keyring, dataKey: await getOrCreateDataKey(env.DB, keyring, scope, { id: 'key_identity', createdAt: instant }), scope }
}

const ids = (prefix) => { let sequence = 0; return () => `${prefix}_${++sequence}` }
const cryptoContextV2 = async () => {
  const keyring = await createKeyring({
    BWM_DATA_KEK_V1: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    BWM_LOOKUP_HMAC_V1: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
    BWM_LOOKUP_HMAC_V2: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU',
    BWM_BACKUP_KEK_V1: 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg',
  }, { activeDataKekVersion: 1, activeLookupKeyVersion: 2, activeBackupKekVersion: 1 })
  return { keyring, dataKey: await getOrCreateDataKey(env.DB, keyring, scope, { id: 'key_identity', createdAt: instant }), scope }
}

async function seedPending(context, { staffId = 'stf_pending', invitationId = 'inv_pending', email = TEST_IDENTITIES.owner.email, expiresAt = new Date(NOW_MS + 1_000).toISOString(), lookupVersion, invitationEmail = email, invitationStatus = 'pending', accessAllowedAt = instant } = {}) {
  const lookup = await blindEmailIndex(email, context.keyring, lookupVersion)
  const invitationLookup = await blindEmailIndex(invitationEmail, context.keyring, lookupVersion)
  const encrypted = async (recordId, field, plaintext) => JSON.stringify(await encryptForScope(context.keyring, context.dataKey, { expectedScope: scope, recordId, field, plaintext }))
  await env.DB.prepare(`INSERT INTO staff_users (id,email_lookup,email_envelope,display_name_envelope,role,status,version,created_at,updated_at) VALUES (?,?,?,?,?,'pending',1,?,?)`)
    .bind(staffId, lookup, await encrypted(staffId, 'email', email), await encrypted(staffId, 'display_name', 'Fixture Staff'), 'owner', instant, instant).run()
  await env.DB.prepare(`INSERT INTO staff_invitations (id,staff_id,email_lookup,email_envelope,display_name_envelope,role,status,inviter_id,expires_at,access_allowed_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?, 'pending', ?, ?, ?, 1, ?, ?)`)
    .bind(invitationId, staffId, invitationLookup, await encrypted(invitationId, 'email', invitationEmail), await encrypted(invitationId, 'display_name', 'Fixture Staff'), 'owner', staffId, expiresAt, accessAllowedAt, instant, instant).run()
}

describe('D1-authoritative staff resolution', () => {
  it('never creates an actor from a valid Access identity alone', async () => {
    const context = await cryptoContext()
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-absent', normalizedEmail: 'absent@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_absent', idFactory: () => 'id_absent' })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect((await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first()).count).toBe(0)
  })

  it('activates exactly the pending invited staff and returns no PII', async () => {
    const context = await cryptoContext()
    await seedPending(context)
    await expect(resolveActor(env.DB, { kind: 'human', subject: TEST_IDENTITIES.owner.sub, normalizedEmail: TEST_IDENTITIES.owner.email }, context, { nowMs: NOW_MS, correlationId: 'corr_activation', idFactory: (() => { let n = 0; return () => `evt_activation_${++n}` })() }))
      .resolves.toEqual({ id: 'stf_pending', role: 'owner', specialistId: null, version: 2 })
    expect(await env.DB.prepare("SELECT status, access_subject, version FROM staff_users WHERE id = 'stf_pending'").first()).toEqual({ status: 'active', access_subject: TEST_IDENTITIES.owner.sub, version: 2 })
    expect(await env.DB.prepare("SELECT status, version FROM staff_invitations WHERE id = 'inv_pending'").first()).toEqual({ status: 'activated', version: 2 })
    const snapshot = await env.DB.prepare("SELECT snapshot_envelope FROM record_versions WHERE entity_id='stf_pending'").first()
    const full = JSON.parse(await decryptForScope(context.keyring, context.dataKey, { expectedScope: scope, recordId: 'stf_pending', field: 'record_version', envelope: JSON.parse(snapshot.snapshot_envelope) }))
    expect(full).toMatchObject({ id: 'stf_pending', status: 'active', access_subject: TEST_IDENTITIES.owner.sub, version: 2, activated_at: instant, updated_at: instant })
    expect(JSON.stringify(snapshot)).not.toContain(TEST_IDENTITIES.owner.email)
    expect(JSON.stringify(snapshot)).not.toContain(TEST_IDENTITIES.owner.sub)
  })

  it('denies exact expiry and rolls all mutations back when invitation compare-and-set loses', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_expired', invitationId: 'inv_expired', email: 'expired@example.test', expiresAt: instant })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-expired', normalizedEmail: 'expired@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_expired', idFactory: () => 'evt_expired' })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(await env.DB.prepare("SELECT status, version FROM staff_users WHERE id = 'stf_expired'").first()).toEqual({ status: 'pending', version: 1 })
  })

  it('denies staff and invitation lookup disagreement without modifying identity records', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_mismatch', invitationId: 'inv_mismatch', email: 'staff-mismatch@example.test', invitationEmail: 'invite-mismatch@example.test' })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-mismatch', normalizedEmail: 'staff-mismatch@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_mismatch', idFactory: ids('mismatch') })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(await env.DB.prepare("SELECT status,access_subject,version FROM staff_users WHERE id='stf_mismatch'").first()).toEqual({ status: 'pending', access_subject: null, version: 1 })
    expect(await env.DB.prepare("SELECT status,version FROM staff_invitations WHERE id='inv_mismatch'").first()).toEqual({ status: 'pending', version: 1 })
  })

  it('converges a same-subject activation once and rejects a competing subject', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_race', invitationId: 'inv_race', email: 'race@example.test' })
    const input = { kind: 'human', subject: 'access-race', normalizedEmail: 'race@example.test' }
    const options = (correlationId) => ({ nowMs: NOW_MS, correlationId, idFactory: ids(correlationId) })
    const same = await Promise.all([resolveActor(env.DB, input, context, options('corr_race_one')), resolveActor(env.DB, input, context, options('corr_race_two'))])
    expect(same).toEqual([{ id: 'stf_race', role: 'owner', specialistId: null, version: 2 }, { id: 'stf_race', role: 'owner', specialistId: null, version: 2 }])
    expect((await env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action='identity.activation' AND entity_id='stf_race'").first()).count).toBe(1)
    await expect(resolveActor(env.DB, { ...input, subject: 'access-race-other' }, context, options('corr_race_other'))).rejects.toThrow(/^ACCESS_DENIED$/)
  })

  it('allows only an exact active subject and audits an identified disabled row without changing it', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_disabled', invitationId: 'inv_disabled', email: 'disabled@example.test' })
    await env.DB.prepare("UPDATE staff_users SET status='disabled', disabled_at=?, version=2, updated_at=? WHERE id='stf_disabled'").bind(instant, instant).run()
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-disabled', normalizedEmail: 'disabled@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_disabled', idFactory: ids('disabled') })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(await env.DB.prepare("SELECT status,access_subject,version FROM staff_users WHERE id='stf_disabled'").first()).toEqual({ status: 'disabled', access_subject: null, version: 2 })
    expect((await env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action='identity.denied' AND entity_id='stf_disabled'").first()).count).toBe(1)
  })

  it('audits the exact subject-bound actor when its JWT email no longer matches a lookup', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_subject_only', invitationId: 'inv_subject_only', email: 'subject-only@example.test' })
    await resolveActor(env.DB, { kind: 'human', subject: 'access-subject-only', normalizedEmail: 'subject-only@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_subject_activate', idFactory: ids('subject_activate') })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-subject-only', normalizedEmail: 'wrong-email@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_subject_wrong', idFactory: ids('subject_wrong') })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect((await env.DB.prepare("SELECT count(*) AS count FROM audit_events WHERE action='identity.denied' AND entity_id='stf_subject_only'").first()).count).toBe(1)
  })

  it('uses the final batch guard to roll back a zero-row invitation CAS after staff CAS', async () => {
    const context = await cryptoContext()
    await seedPending(context, { staffId: 'stf_guard', invitationId: 'inv_guard', email: 'guard@example.test' })
    const sabotaged = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements) => env.DB.batch([statements[0], env.DB.prepare('UPDATE staff_invitations SET version=version WHERE 0'), ...statements.slice(2)]),
    }
    await expect(resolveActor(sabotaged, { kind: 'human', subject: 'access-guard', normalizedEmail: 'guard@example.test' }, context, { nowMs: NOW_MS, correlationId: 'corr_guard', idFactory: ids('guard') })).rejects.toThrow(/^ACCESS_DENIED$/)
    expect(await env.DB.prepare("SELECT status,access_subject,version FROM staff_users WHERE id='stf_guard'").first()).toEqual({ status: 'pending', access_subject: null, version: 1 })
    expect(await env.DB.prepare("SELECT status,version FROM staff_invitations WHERE id='inv_guard'").first()).toEqual({ status: 'pending', version: 1 })
    expect((await env.DB.prepare("SELECT count(*) AS count FROM record_versions WHERE entity_id IN ('stf_guard','inv_guard')").first()).count).toBe(0)
  })

  it('activates retained V1 rows under active V2 and updates both lookups with encrypted-only audit history', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_rotate', invitationId: 'inv_rotate', email: 'rotate@example.test', lookupVersion: 1 })
    await resolveActor(env.DB, { kind: 'human', subject: 'access-rotate', normalizedEmail: 'rotate@example.test' }, v2, { nowMs: NOW_MS, correlationId: 'corr_rotate', idFactory: ids('rotate') })
    const expected = await blindEmailIndex('rotate@example.test', v2.keyring)
    expect(await env.DB.prepare("SELECT email_lookup FROM staff_users WHERE id='stf_rotate'").first()).toEqual({ email_lookup: expected })
    expect(await env.DB.prepare("SELECT email_lookup FROM staff_invitations WHERE id='inv_rotate'").first()).toEqual({ email_lookup: expected })
    const history = await env.DB.prepare("SELECT snapshot_envelope,metadata_json FROM record_versions JOIN audit_events ON 1=1 WHERE record_versions.entity_id IN ('stf_rotate','inv_rotate')").all()
    expect(JSON.stringify(history.results)).not.toContain('rotate@example.test')
    expect(JSON.stringify(history.results)).not.toContain('access-rotate')
    expect(JSON.stringify(history.results)).not.toContain(expected)
  })

  it('lazily reindexes an exact active actor under V2 without changing its Access subject', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_lazy', invitationId: 'inv_lazy', email: 'lazy@example.test', lookupVersion: 1 })
    await resolveActor(env.DB, { kind: 'human', subject: 'access-lazy', normalizedEmail: 'lazy@example.test' }, v1, { nowMs: NOW_MS, correlationId: 'corr_lazy_activate', idFactory: ids('lazy_activate') })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-lazy', normalizedEmail: 'lazy@example.test' }, v2, { nowMs: NOW_MS, correlationId: 'corr_lazy_reindex', idFactory: ids('lazy_reindex') }))
      .resolves.toEqual({ id: 'stf_lazy', role: 'owner', specialistId: null, version: 3 })
    expect(await env.DB.prepare("SELECT email_lookup,access_subject,version FROM staff_users WHERE id='stf_lazy'").first())
      .toEqual({ email_lookup: await blindEmailIndex('lazy@example.test', v2.keyring), access_subject: 'access-lazy', version: 3 })
  })

  it('reindexes bounded staff and terminal invitations then verifies no retained old index remains', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_reindex_a', invitationId: 'inv_reindex_a', email: 'reindex-a@example.test', lookupVersion: 1 })
    await seedPending(v1, { staffId: 'stf_reindex_b', invitationId: 'inv_reindex_b', email: 'reindex-b@example.test', lookupVersion: 1 })
    await env.DB.prepare("UPDATE staff_invitations SET status='revoked', revoked_at=?, version=2, updated_at=? WHERE id='inv_reindex_b'").bind(instant, instant).run()
    const first = await reindexEmailLookupsBatch(env.DB, v2, { table: 'staff_users', afterId: 'stf_reindex_a', limit: 1, nowMs: NOW_MS, correlationId: 'corr_reindex_staff', idFactory: ids('reindex_staff') })
    expect(first.scanned).toBe(1)
    const invitation = await reindexEmailLookupsBatch(env.DB, v2, { table: 'staff_invitations', afterId: 'inv_reindex_a', limit: 10, nowMs: NOW_MS, correlationId: 'corr_reindex_inv', idFactory: ids('reindex_inv') })
    expect(invitation.changed).toBeGreaterThanOrEqual(1)
    expect((await verifyNoOldEmailLookups(env.DB, v2)).count).toBeGreaterThanOrEqual(1)
    const drain = async (table) => {
      const next = ids(`drain_${table}`)
      let cursor = ''
      while (true) {
        const page = await reindexEmailLookupsBatch(env.DB, v2, { table, afterId: cursor, limit: 10, nowMs: NOW_MS, correlationId: `corr_drain_${table}`, idFactory: next })
        if (page.done) return
        cursor = page.afterId
      }
    }
    await drain('staff_users')
    await drain('staff_invitations')
    await expect(verifyNoOldEmailLookups(env.DB, v2)).resolves.toEqual({ complete: true, count: 0 })
  })

  it('fails closed for multiple retained-version logical staff candidates', async () => {
    const v1 = await cryptoContext()
    const v2 = await cryptoContextV2()
    await seedPending(v1, { staffId: 'stf_ambiguous_v1', invitationId: 'inv_ambiguous_v1', email: 'ambiguous@example.test', lookupVersion: 1 })
    await seedPending(v2, { staffId: 'stf_ambiguous_v2', invitationId: 'inv_ambiguous_v2', email: 'ambiguous@example.test', lookupVersion: 2 })
    await expect(resolveActor(env.DB, { kind: 'human', subject: 'access-ambiguous', normalizedEmail: 'ambiguous@example.test' }, v2, { nowMs: NOW_MS, correlationId: 'corr_ambiguous', idFactory: ids('ambiguous') })).rejects.toThrow(/^ACCESS_DENIED$/)
  })
})
