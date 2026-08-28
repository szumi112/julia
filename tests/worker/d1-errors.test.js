import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import {
  classifyOwnerTransitionError,
  isD1CoreDirectoryInvariantFailure,
  isD1FinanceSourceDuplicate,
  isD1IdentityCollision,
  isD1LastActiveOwner,
  isD1MissingColumn,
  isD1RateLimitGuardFailure,
} from '../../worker/db/errors.js'
import * as d1Errors from '../../worker/db/errors.js'

it('maps only the exact unambiguous payment-correction guard and contains hostile messages', () => {
  expect(d1Errors.classifyCoreConstraintError(
    new Error('invalid_payment_correction: SQLITE_CONSTRAINT')
  )).toBe('PAYMENT_CORRECTION_CONFLICT')
  expect(d1Errors.classifyCoreConstraintError(
    new Error('D1_ERROR: invalid_payment_correction: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)')
  )).toBe('PAYMENT_CORRECTION_CONFLICT')
  for (const message of [
    'charge_service_mismatch: SQLITE_CONSTRAINT',
    'append_only: SQLITE_CONSTRAINT',
    'transport invalid_payment_correction downstream',
  ]) expect(d1Errors.classifyCoreConstraintError(new Error(message))).toBeNull()
  let hostileReads = 0
  const hostile = Object.defineProperty(new Error(), 'message', {
    configurable: true,
    get() {
      hostileReads += 1
      return 'invalid_payment_correction: SQLITE_CONSTRAINT'
    },
  })
  expect(d1Errors.classifyCoreConstraintError(hostile)).toBeNull()
  expect(hostileReads).toBe(0)

  const forged = new Proxy(new Error('transport failure'), {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'message') return {
        configurable: true,
        enumerable: false,
        value: 'invalid_payment_correction: SQLITE_CONSTRAINT',
        writable: true,
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  expect(d1Errors.classifyCoreConstraintError(forged)).toBeNull()
})

it('classifies only exact D1 guard errors', () => {
  expect(isD1IdentityCollision(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'))).toBe(true)
  expect(isD1LastActiveOwner(new Error('last_active_owner: SQLITE_CONSTRAINT'))).toBe(true)
  expect(isD1IdentityCollision(new Error('transport identity_collision downstream'))).toBe(false)
  expect(isD1FinanceSourceDuplicate(
    new Error('D1_ERROR: finance_source_duplicate: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)')
  )).toBe(true)
  expect(isD1FinanceSourceDuplicate(new Error('finance_source_duplicate later'))).toBe(false)
  expect(isD1LastActiveOwner(new Error('last_active_owner later'))).toBe(false)
  expect(isD1RateLimitGuardFailure(
    new Error('D1_ERROR: rate_limit_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)')
  )).toBe(true)
  expect(isD1RateLimitGuardFailure(new Error('transport rate_limit_guard_failed downstream'))).toBe(false)
  expect(isD1CoreDirectoryInvariantFailure(
    new Error('D1_ERROR: core_directory_invariant_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)')
  )).toBe(true)
  expect(isD1CoreDirectoryInvariantFailure(
    new Error('transport core_directory_invariant_failed downstream')
  )).toBe(false)
  expect(typeof d1Errors.isD1OutboxOperationGuardFailure).toBe('function')
  expect(d1Errors.isD1OutboxOperationGuardFailure(
    new Error('D1_ERROR: outbox_operation_guard_failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)')
  )).toBe(true)
  expect(d1Errors.isD1OutboxOperationGuardFailure(
    new Error('outbox_operation_guard_failed: SQLITE_CONSTRAINT')
  )).toBe(true)
  expect(d1Errors.isD1OutboxOperationGuardFailure(
    new Error('transport outbox_operation_guard_failed downstream')
  )).toBe(false)
  expect(d1Errors.isD1OutboxOperationGuardFailure(
    new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT')
  )).toBe(false)
  expect(classifyOwnerTransitionError(new Error('last_active_owner: SQLITE_CONSTRAINT'))).toBe('LAST_ACTIVE_OWNER')
  expect(classifyOwnerTransitionError(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'))).toBeNull()
  expect(classifyOwnerTransitionError(new Error('unknown'))).toBeNull()
  expect(classifyOwnerTransitionError(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'), { guardProven: false })).toBeNull()
  expect(classifyOwnerTransitionError(new Error('D1_ERROR: identity_collision: SQLITE_CONSTRAINT'), { guardProven: true })).toBe('VERSION_CONFLICT')
})

it('recognizes only an exact D1 missing-column signal for the requested column', () => {
  const column = 'specialist.professional_title_envelope'
  expect(isD1MissingColumn(
    new Error(`D1_ERROR: no such column: ${column} at offset 321: SQLITE_ERROR`),
    column,
  )).toBe(true)
  expect(isD1MissingColumn(new Error(`no such column: ${column}`), column)).toBe(true)
  for (const message of [
    `D1_ERROR: no such column: ${column}: SQLITE_ERROR: retry`,
    `D1_ERROR: query failed; no such column: ${column} at offset 321: SQLITE_ERROR`,
    `D1_ERROR: no such column: other.${column} at offset 321: SQLITE_ERROR`,
    `prefix no such column: ${column}`,
  ]) {
    expect(isD1MissingColumn(new Error(message), column)).toBe(false)
  }
  expect(isD1MissingColumn(new Error(`no such column: ${column}`), 'unsafe(column)'))
    .toBe(false)
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
