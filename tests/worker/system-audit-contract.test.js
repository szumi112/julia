import { expect, it } from 'vitest'
import {
  BROWSER_SYSTEM_AUDIT_SCHEMAS,
  browserSystemAuditEvent,
} from '../../src/api.js'
import {
  SYSTEM_AUDIT_SCHEMAS,
} from '../../src/system-audit-contract.js'
import {
  WRITER_SYSTEM_AUDIT_SCHEMAS,
  writerSystemAuditEvent,
} from '../../worker/audit/events.js'
import {
  READER_SYSTEM_AUDIT_SCHEMAS,
  readerSystemAuditEvent,
} from '../../worker/routes/operations.js'

const validators = Object.freeze([
  browserSystemAuditEvent,
  readerSystemAuditEvent,
  writerSystemAuditEvent,
])

it('keeps the staging profile convergence schema on one frozen system contract', () => {
  expect(SYSTEM_AUDIT_SCHEMAS['staff.profile.updated']).toEqual({
    entityIdKind: 'staffId',
    entityType: 'staff_user',
    metadata: { staffVersion: 'version' },
  })
  expect(Object.isFrozen(SYSTEM_AUDIT_SCHEMAS)).toBe(true)
  expect(Object.isFrozen(SYSTEM_AUDIT_SCHEMAS['staff.profile.updated'])).toBe(true)
  expect(Object.isFrozen(SYSTEM_AUDIT_SCHEMAS['staff.profile.updated'].metadata)).toBe(true)
  for (const snapshot of [
    BROWSER_SYSTEM_AUDIT_SCHEMAS,
    READER_SYSTEM_AUDIT_SCHEMAS,
    WRITER_SYSTEM_AUDIT_SCHEMAS,
  ]) expect(snapshot).toBe(SYSTEM_AUDIT_SCHEMAS)
})

it('accepts the exact system event and rejects human attribution or untyped entities everywhere', () => {
  const valid = {
    action: 'staff.profile.updated',
    actorStaffId: null,
    entityType: 'staff_user',
    entityId: 'stf_target',
    result: 'success',
    metadata: { staffVersion: 2 },
  }
  for (const validate of validators) expect(validate(valid)).toEqual(valid)
  for (const malformed of [
    { ...valid, actorStaffId: 'stf_actor' },
    { ...valid, entityId: 'profile_target' },
    { ...valid, metadata: { staffVersion: 0 } },
    { ...valid, metadata: { staffVersion: 2, extra: 1 } },
  ]) {
    for (const validate of validators) expect(validate(malformed)).toBeNull()
  }
})
