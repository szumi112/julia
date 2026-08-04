import { describe, expect, it } from 'vitest'
import { ACTORS, NOW_MS } from './fixtures.js'
import { CAPABILITIES, authorize, capabilitiesForActor } from '../../worker/identity/policy.js'

const activeAssignment = { kind: 'client', clientId: 'cl_1', assignment: { kind: 'client_assignment', clientId: 'cl_1', specialistId: 'sp_spec', status: 'active' } }
const centre = { kind: 'centre', centreId: 'centre_1' }
const directory = { kind: 'specialist_directory', centreId: 'centre_1' }
const archivedHistory = { kind: 'client_history', clientId: 'cl_1', appointmentId: 'apt_1', specialistId: 'sp_spec' }

describe('authorization matrix', () => {
  it('exposes frozen role-level UI hints but keeps record checks authoritative', () => {
    expect(Object.isFrozen(CAPABILITIES)).toBe(true)
    expect(capabilitiesForActor(ACTORS.owner)).toContain('staff.manage')
    expect(Object.isFrozen(capabilitiesForActor(ACTORS.owner))).toBe(true)
    expect(authorize(ACTORS.specialist, 'client.operational.read', activeAssignment, { nowMs: NOW_MS })).toBe(true)
    expect(authorize(ACTORS.specialist, 'client.operational.read', { ...activeAssignment, assignment: { ...activeAssignment.assignment, specialistId: 'sp_other' } }, { nowMs: NOW_MS })).toBe(false)
  })

  it('returns the exact frozen UI capability sets for each valid role', () => {
    expect(capabilitiesForActor(ACTORS.owner)).toEqual(CAPABILITIES)
    expect(capabilitiesForActor(ACTORS.coordinator)).toEqual([
      'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general', 'client.manage',
      'client.operational.read', 'finance.centre.read', 'operations.health.read', 'payment.manage',
      'specialist.directory.read', 'tus.manage',
    ])
    expect(capabilitiesForActor(ACTORS.specialist)).toEqual([
      'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general', 'client.manage',
      'client.operational.read', 'clinical.read', 'payment.manage', 'specialist.directory.read', 'tus.manage',
    ])
    expect(capabilitiesForActor({ id: 'stf_unknown', role: 'unknown', specialistId: null })).toEqual([])
  })

  it.each([
    ['centre.manage', centre, true, false, false],
    ['staff.manage', centre, true, false, false],
    ['client.manage', activeAssignment, true, true, true],
    ['specialist.directory.read', directory, true, true, true],
    ['client.operational.read', activeAssignment, true, true, true],
    ['appointment.manage', { kind: 'appointment', appointmentId: 'apt_1', specialistId: 'sp_spec' }, true, true, true],
    ['appointment.charge.read', { kind: 'appointment', appointmentId: 'apt_1', specialistId: 'sp_spec' }, true, true, true],
    ['payment.manage', { kind: 'appointment', appointmentId: 'apt_1', specialistId: 'sp_spec' }, true, true, true],
    ['finance.centre.read', centre, true, true, false],
    ['tus.manage', { kind: 'tus_group', groupId: 'tus', leaderSpecialistIds: ['sp_spec'] }, true, true, true],
    ['clinical.read', activeAssignment, false, false, true],
    ['chat.general', centre, true, true, true],
    ['chat.direct', { kind: 'conversation', conversationId: 'con', participantStaffIds: ['stf_owner', 'stf_coord', 'stf_spec'] }, true, true, true],
    ['operations.health.read', centre, true, true, false],
    ['security.audit.read', centre, true, false, false],
  ])('enforces matrix row %s', (capability, resource, owner, coordinator, specialist) => {
    expect(authorize(ACTORS.owner, capability, resource, { nowMs: NOW_MS })).toBe(owner)
    expect(authorize(ACTORS.coordinator, capability, resource, { nowMs: NOW_MS })).toBe(coordinator)
    expect(authorize(ACTORS.specialist, capability, resource, { nowMs: NOW_MS })).toBe(specialist)
  })

  it('keeps archived history read-only and bound to the owning specialist ledger', () => {
    expect(authorize(ACTORS.owner, 'client.operational.read', archivedHistory, { nowMs: NOW_MS })).toBe(true)
    expect(authorize(ACTORS.coordinator, 'client.operational.read', archivedHistory, { nowMs: NOW_MS })).toBe(true)
    expect(authorize(ACTORS.specialist, 'client.operational.read', archivedHistory, { nowMs: NOW_MS })).toBe(true)
    expect(authorize(ACTORS.specialist, 'client.operational.read', {
      ...archivedHistory, specialistId: 'sp_other',
    }, { nowMs: NOW_MS })).toBe(false)
    for (const capability of ['client.manage', 'clinical.read']) {
      for (const actor of Object.values(ACTORS)) {
        expect(authorize(actor, capability, archivedHistory, { nowMs: NOW_MS })).toBe(false)
      }
    }
  })

  it('requires exact centre and directory identities and contains hostile facts', () => {
    for (const [capability, resource] of [
      ['centre.manage', { ...centre, centreId: 'centre_2' }],
      ['specialist.directory.read', { ...directory, centreId: 'centre_2' }],
      ['client.manage', { ...activeAssignment, extra: true }],
    ]) expect(authorize(ACTORS.owner, capability, resource, { nowMs: NOW_MS })).toBe(false)

    const hostile = new Proxy({}, { ownKeys() { throw new Error('private-row-detail') } })
    expect(authorize(ACTORS.owner, 'client.manage', hostile, { nowMs: NOW_MS })).toBe(false)
    expect(authorize(hostile, 'client.manage', activeAssignment, { nowMs: NOW_MS })).toBe(false)
  })

  it('fails closed for malformed resource facts and independently wrong fact ids', () => {
    const cases = [
      [ACTORS.owner, 'client.manage', { kind: 'client', clientId: 'cli_1', assignment: null }],
      [ACTORS.owner, 'appointment.manage', { kind: 'appointment', appointmentId: 'appointment_1', specialistId: 'sp_spec' }],
      [ACTORS.specialist, 'appointment.manage', { kind: 'appointment', appointmentId: 'apt_1', specialistId: 'sp_other' }],
      [ACTORS.specialist, 'tus.manage', { kind: 'tus_group', groupId: 'tus', leaderSpecialistIds: ['sp_other'] }],
      [ACTORS.specialist, 'chat.direct', { kind: 'conversation', conversationId: 'con', participantStaffIds: ['stf_other'] }],
      [ACTORS.specialist, 'client.operational.read', { ...activeAssignment, clientId: '' }],
      [ACTORS.specialist, 'client.operational.read', { ...activeAssignment, assignment: { ...activeAssignment.assignment, status: 'inactive' } }],
      [{ ...ACTORS.specialist, specialistId: null }, 'appointment.manage', { kind: 'appointment', appointmentId: 'apt_1', specialistId: 'sp_spec' }],
      [ACTORS.owner, 'not.a.capability', centre],
      [ACTORS.owner, 'staff.manage', { kind: 'wrong' }],
    ]
    for (const [actor, capability, resource] of cases) expect(authorize(actor, capability, resource, { nowMs: NOW_MS })).toBe(false)
  })

  it('rejects empty, whitespace, missing, and unbound identifiers for every role', () => {
    const malformed = [
      [ACTORS.owner, 'centre.manage', { kind: 'centre', centreId: ' ' }],
      [ACTORS.coordinator, 'chat.general', { kind: 'centre' }],
      [ACTORS.specialist, 'chat.direct', { kind: 'conversation', conversationId: '', participantStaffIds: ['stf_spec'] }],
      [ACTORS.specialist, 'chat.direct', { kind: 'conversation', conversationId: ' ', participantStaffIds: [] }],
      [ACTORS.specialist, 'tus.manage', { kind: 'tus_group', groupId: 'tus', leaderSpecialistIds: [] }],
      [ACTORS.specialist, 'tus.manage', { kind: 'tus_group', groupId: 'tus', leaderSpecialistIds: [' '] }],
      [ACTORS.specialist, 'appointment.manage', { kind: 'appointment', appointmentId: ' ', specialistId: 'sp_spec' }],
      [{ id: 'stf_spec', role: 'specialist', specialistId: ' ' }, 'appointment.manage', { kind: 'appointment', appointmentId: 'apt', specialistId: 'sp_spec' }],
      [{ id: ' ', role: 'owner', specialistId: null }, 'staff.manage', centre],
    ]
    for (const [actor, capability, resource] of malformed) expect(authorize(actor, capability, resource, { nowMs: NOW_MS })).toBe(false)
  })

  it('treats malformed specialists as entirely unauthenticated policy inputs', () => {
    for (const specialistId of [null, '', ' ']) {
      const actor = { id: 'stf_bad_spec', role: 'specialist', specialistId }
      expect(capabilitiesForActor(actor)).toEqual([])
      expect(authorize(actor, 'chat.general', centre, { nowMs: NOW_MS })).toBe(false)
      expect(authorize(actor, 'chat.direct', { kind: 'conversation', conversationId: 'con_1', participantStaffIds: ['stf_bad_spec'] }, { nowMs: NOW_MS })).toBe(false)
    }
    for (const actor of [ACTORS.owner, ACTORS.coordinator]) expect(authorize(actor, 'tus.manage', { kind: 'tus_group', groupId: 'tus_1', leaderSpecialistIds: [] }, { nowMs: NOW_MS })).toBe(false)
    expect(authorize(ACTORS.owner, 'staff.manage', centre, { nowMs: -1 })).toBe(false)
  })

  it.each([
    [ACTORS.owner, 'centre.manage', centre, true],
    [ACTORS.coordinator, 'centre.manage', centre, false],
    [ACTORS.coordinator, 'finance.centre.read', centre, true],
    [ACTORS.specialist, 'finance.centre.read', centre, false],
    [ACTORS.specialist, 'appointment.manage', { kind: 'appointment', appointmentId: 'apt_1', specialistId: 'sp_spec' }, true],
    [ACTORS.specialist, 'appointment.manage', { kind: 'appointment', appointmentId: 'apt_1', specialistId: 'sp_other' }, false],
    [ACTORS.specialist, 'tus.manage', { kind: 'tus_group', groupId: 'tus_1', leaderSpecialistIds: ['sp_spec'] }, true],
    [ACTORS.specialist, 'chat.direct', { kind: 'conversation', conversationId: 'con_1', participantStaffIds: ['stf_spec'] }, true],
    [ACTORS.specialist, 'chat.direct', { kind: 'conversation', conversationId: 'con_1', participantStaffIds: ['stf_other'] }, false],
  ])('%s %s respects record-bound facts', (actor, capability, resource, allowed) => {
    expect(authorize(actor, capability, resource, { nowMs: NOW_MS })).toBe(allowed)
  })

  it('lets an owner read clinical data only through an exact active assignment or break-glass', () => {
    const breakGlass = { kind: 'break_glass', ownerStaffId: 'stf_owner', clientId: 'cl_1', startsAt: NOW_MS - 1, expiresAt: NOW_MS + 1, revokedAt: null }
    const clinicalTarget = { kind: 'client', clientId: 'cl_1', breakGlass }
    expect(authorize(ACTORS.owner, 'clinical.read', clinicalTarget, { nowMs: NOW_MS })).toBe(true)
    for (const fact of [
      { ...breakGlass, ownerStaffId: 'stf_other' },
      { ...breakGlass, startsAt: NOW_MS + 1 }, { ...breakGlass, expiresAt: NOW_MS }, { ...breakGlass, revokedAt: NOW_MS - 1 },
    ]) expect(authorize(ACTORS.owner, 'clinical.read', { ...clinicalTarget, breakGlass: fact }, { nowMs: NOW_MS })).toBe(false)
    expect(authorize(ACTORS.owner, 'clinical.read', { ...clinicalTarget, clientId: 'cli_other' }, { nowMs: NOW_MS })).toBe(false)
    expect(authorize(ACTORS.coordinator, 'clinical.read', clinicalTarget, { nowMs: NOW_MS })).toBe(false)
  })
})
