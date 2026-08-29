import { expect, it } from 'vitest'
import {
  BROWSER_CORE_AUDIT_SCHEMAS,
  browserCoreAuditEvent,
} from '../../src/api.js'
import {
  BOOTSTRAP_CORE_AUDIT_SCHEMAS,
  bootstrapCoreAuditEvent,
} from '../../scripts/bootstrap-core.js'
import { CORE_ROUTE_DESCRIPTORS } from '../../worker/app.js'
import {
  WRITER_CORE_AUDIT_SCHEMAS,
  writerCoreAuditEvent,
} from '../../worker/audit/events.js'
import {
  READER_CORE_AUDIT_SCHEMAS,
  readerCoreAuditEvent,
} from '../../worker/routes/operations.js'
import {
  CORE_AUDIT_ACTIONS,
  CORE_AUDIT_SCHEMAS,
} from '../../src/core-audit-contract.js'

const validators = Object.freeze([
  bootstrapCoreAuditEvent,
  browserCoreAuditEvent,
  readerCoreAuditEvent,
  writerCoreAuditEvent,
])

const valueFor = (type) => ({
  assignmentId: 'asg_one',
  clientId: 'cl_one',
  correctionId: 'cor_one',
  count: 2,
  financeBatchId: 'fib_one',
  financeEntryId: 'fin_one',
  nullableVersion: null,
  nullablePaymentId: null,
  paymentId: 'pay_one',
  staffId: 'stf_one',
  version: 1,
  workbookImportId: 'wbi_one',
  workbookExportId: 'wbe_one',
})[type]

const eventFor = (action) => {
  const schema = CORE_AUDIT_SCHEMAS[action]
  return {
    action,
    actorStaffId: 'stf_one',
    entityType: schema.entityType,
    entityId: schema.entityIdKind === 'clientId' ? 'cl_one'
      : schema.entityIdKind === 'activityGroupId' ? 'agr_one'
        : schema.entityIdKind === 'activityParticipantId' ? 'acp_one'
          : schema.entityIdKind === 'activityMembershipId' ? 'amb_one'
            : schema.entityIdKind === 'activityClassId' ? 'acl_one'
              : schema.entityIdKind === 'activityAttendanceId' ? 'aat_one'
                : schema.entityIdKind === 'activityProjectionJobId' ? 'apj_one'
      : schema.entityIdKind === 'appointmentId' ? 'apt_one'
        : schema.entityIdKind === 'financeBatchId' ? 'fib_one'
          : schema.entityIdKind === 'financeEntryId' ? 'fin_one'
            : schema.entityIdKind === 'specialistId' ? 'sp_one'
                : schema.entityIdKind === 'workbookImportId' ? 'wbi_one'
                  : schema.entityIdKind === 'workbookExportId' ? 'wbe_one'
                : schema.entityIdKind === 'historicalClientId' ? 'hcl_one'
                  : schema.entityIdKind === 'staffId' ? 'stf_one' : 'pay_one',
    result: 'success',
    metadata: Object.fromEntries(Object.entries(schema.metadata)
      .map(([key, type]) => [key, valueFor(type)])),
  }
}

it('keeps staff capability audit metadata exact, typed, and free of presentation data', () => {
  expect(CORE_AUDIT_SCHEMAS['staff.capabilities.updated']).toEqual({
    entityIdKind: 'staffId',
    entityType: 'staff_user',
    metadata: {
      actorAuthorityRevision: 'version',
      allowCount: 'count',
      denyCount: 'count',
      targetAuthorityRevision: 'version',
    },
  })
  const valid = {
    action: 'staff.capabilities.updated',
    actorStaffId: 'stf_owner',
    entityType: 'staff_user',
    entityId: 'stf_target',
    result: 'success',
    metadata: {
      actorAuthorityRevision: 4,
      allowCount: 1,
      denyCount: 2,
      targetAuthorityRevision: 7,
    },
  }
  for (const validate of validators) expect(validate(valid)).toEqual(valid)
  for (const metadata of [
    { ...valid.metadata, displayName: 'Dane osobowe' },
    { ...valid.metadata, email: 'private@example.test' },
    { ...valid.metadata, actorAuthorityRevision: 0 },
    { ...valid.metadata, allowCount: -1 },
  ]) {
    for (const validate of validators) expect(validate({ ...valid, metadata })).toBeNull()
  }
})

it('keeps staff role audit metadata exact across authority, directory, and Access generations', () => {
  expect(CORE_AUDIT_SCHEMAS['staff.role.updated']).toEqual({
    entityIdKind: 'staffId',
    entityType: 'staff_user',
    metadata: {
      actorAuthorityRevision: 'version',
      desiredGeneration: 'version',
      invitationVersion: 'nullableVersion',
      specialistVersion: 'nullableVersion',
      staffVersion: 'version',
      targetAuthorityRevision: 'version',
    },
  })
  const valid = {
    action: 'staff.role.updated',
    actorStaffId: 'stf_owner',
    entityType: 'staff_user',
    entityId: 'stf_target',
    result: 'success',
    metadata: {
      actorAuthorityRevision: 4,
      desiredGeneration: 9,
      invitationVersion: null,
      specialistVersion: null,
      staffVersion: 7,
      targetAuthorityRevision: 3,
    },
  }
  for (const validate of validators) expect(validate(valid)).toEqual(valid)
  for (const [field, value] of [
    ['invitationVersion', 0],
    ['invitationVersion', '1'],
    ['invitationVersion', -1],
    ['specialistVersion', 0],
    ['specialistVersion', '1'],
    ['specialistVersion', -1],
  ]) {
    for (const validate of validators) {
      expect(validate({
        ...valid,
        metadata: { ...valid.metadata, [field]: value },
      })).toBeNull()
    }
  }
  for (const validate of validators) {
    expect(validate({
      ...valid,
      metadata: {
        ...valid.metadata,
        invitationVersion: 3,
        specialistVersion: 2,
      },
    })).toEqual({
      ...valid,
      metadata: {
        ...valid.metadata,
        invitationVersion: 3,
        specialistVersion: 2,
      },
    })
  }
})

it('keeps every advertised core action on one deeply frozen four-consumer contract', () => {
  expect(Object.isFrozen(CORE_AUDIT_SCHEMAS)).toBe(true)
  for (const [action, schema] of Object.entries(CORE_AUDIT_SCHEMAS)) {
    expect(Object.isFrozen(schema), action).toBe(true)
    expect(Object.isFrozen(schema.metadata), action).toBe(true)
  }
  for (const snapshot of [
    BOOTSTRAP_CORE_AUDIT_SCHEMAS,
    BROWSER_CORE_AUDIT_SCHEMAS,
    READER_CORE_AUDIT_SCHEMAS,
    WRITER_CORE_AUDIT_SCHEMAS,
  ]) expect(snapshot).toBe(CORE_AUDIT_SCHEMAS)
  expect([...new Set(CORE_ROUTE_DESCRIPTORS.flatMap(({ auditActions }) => auditActions))].sort())
    .toEqual([...CORE_AUDIT_ACTIONS].sort())
  for (const action of CORE_ROUTE_DESCRIPTORS.flatMap(({ auditActions }) => auditActions)) {
    expect(Object.hasOwn(CORE_AUDIT_SCHEMAS, action), action).toBe(true)
  }
})

it('accepts and rejects every core audit schema identically at all four boundaries', () => {
  for (const action of CORE_AUDIT_ACTIONS) {
    const valid = eventFor(action)
    for (const validate of validators) expect(validate(valid), `${validate.name}:${action}`).toEqual(valid)

    const keys = Object.keys(valid.metadata)
    const malformed = [
      ...Object.keys(valid).map((missing) => Object.fromEntries(
        Object.entries(valid).filter(([key]) => key !== missing)
      )),
      { ...valid, unexpected: 1 },
      { ...valid, action: 1 },
      { ...valid, actorStaffId: null },
      { ...valid, entityId: 'wrong' },
      { ...valid, entityType: 'wrong' },
      { ...valid, result: 'failed' },
      { ...valid, metadata: { ...valid.metadata, unexpected: 1 } },
      ...keys.map((missing) => ({
        ...valid,
        metadata: Object.fromEntries(Object.entries(valid.metadata)
          .filter(([key]) => key !== missing)),
      })),
      ...keys.map((key) => ({ ...valid, metadata: { ...valid.metadata, [key]: 'wrong' } })),
    ]
    const other = CORE_AUDIT_ACTIONS.find((candidate) => candidate !== action
      && JSON.stringify(CORE_AUDIT_SCHEMAS[candidate].metadata) !== JSON.stringify(CORE_AUDIT_SCHEMAS[action].metadata))
    if (other) malformed.push({ ...valid, metadata: eventFor(other).metadata })
    for (const candidate of malformed) {
      for (const validate of validators) expect(validate(candidate), `${validate.name}:${action}`).toBeNull()
    }
  }
})

it('contains hostile core event and metadata reflection identically at all four boundaries', () => {
  const valid = eventFor('client.updated')
  const hostileEvents = [
    new Proxy(valid, { ownKeys() { throw new Error('private event keys') } }),
    { ...valid, metadata: new Proxy(valid.metadata, {
      getOwnPropertyDescriptor() { throw new Error('private metadata descriptor') },
    }) },
  ]
  for (const hostile of hostileEvents) {
    for (const validate of validators) expect(() => validate(hostile)).not.toThrow()
    for (const validate of validators) expect(validate(hostile)).toBeNull()
  }
})
