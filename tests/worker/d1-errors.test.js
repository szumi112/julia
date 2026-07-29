import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { classifyOwnerTransitionError, isD1IdentityCollision, isD1LastActiveOwner } from '../../worker/db/errors.js'

it('classifies only exact D1 identity and last-owner errors', () => {
  expect(isD1IdentityCollision(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'))).toBe(true)
  expect(isD1LastActiveOwner(new Error('last_active_owner: SQLITE_CONSTRAINT'))).toBe(true)
  expect(isD1IdentityCollision(new Error('transport identity_collision downstream'))).toBe(false)
  expect(isD1LastActiveOwner(new Error('last_active_owner later'))).toBe(false)
  expect(classifyOwnerTransitionError(new Error('last_active_owner: SQLITE_CONSTRAINT'))).toBe('LAST_ACTIVE_OWNER')
  expect(classifyOwnerTransitionError(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'))).toBeNull()
  expect(classifyOwnerTransitionError(new Error('unknown'))).toBeNull()
  expect(classifyOwnerTransitionError(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'), { guardProven: false })).toBeNull()
  expect(classifyOwnerTransitionError(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'), { guardProven: true })).toBe('VERSION_CONFLICT')
})

it('preserves one active owner across two direct concurrent transitions and classifies the loser exactly', async () => {
  const now = '2027-01-15T10:00:00.000Z'
  const later = '2027-01-15T10:01:00.000Z'
  for (const suffix of ['one', 'two']) {
    await env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,access_subject,version,activated_at,created_at,updated_at)
       VALUES (?, ?, '{}', '{}', 'owner', 'active', ?, 1, ?, ?, ?)`
    ).bind(`stf_owner_${suffix}`, `owner_lookup_${suffix}`, `access_owner_${suffix}`, now, now, now).run()
  }
  const settled = await Promise.allSettled(['one', 'two'].map((suffix) => env.DB.prepare(
    `UPDATE staff_users SET status='disabled',disabled_at=?,version=2,updated_at=?
     WHERE id=? AND version=1`
  ).bind(later, later, `stf_owner_${suffix}`).run()))
  expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
  const loser = settled.find((entry) => entry.status === 'rejected')
  expect(classifyOwnerTransitionError(loser.reason)).toBe('LAST_ACTIVE_OWNER')
  expect((await env.DB.prepare("SELECT count(*) AS count FROM staff_users WHERE role='owner' AND status='active'").first()).count).toBe(1)
})
