import { describe, expect, it } from 'vitest'
import { ACTORS, NOW_MS } from './fixtures.js'
import { CAPABILITIES, authorize, capabilitiesForActor } from '../../worker/identity/policy.js'

const activeAssignment = { kind: 'client', clientId: 'cli_1', assignment: { kind: 'client_assignment', clientId: 'cli_1', specialistId: 'sp_spec', status: 'active' } }
const centre = { kind: 'centre', centreId: 'ctr_1' }

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
      'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general', 'client.operational.read',
      'finance.centre.read', 'operations.health.read', 'payment.manage', 'tus.manage',
    ])
    expect(capabilitiesForActor(ACTORS.specialist)).toEqual([
      'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general', 'client.operational.read',
      'clinical.read', 'payment.manage', 'tus.manage',
    ])
    expect(capabilitiesForActor({ id: 'stf_unknown', role: 'unknown', specialistId: null })).toEqual([])
  })

  it.each([
    ['centre.manage', centre, true, false, false],
    ['staff.manage', centre, true, false, false],
    ['client.operational.read', activeAssignment, true, true, true],
    ['appointment.manage', { kind: 'appointment', appointmentId: 'apt', specialistId: 'sp_spec' }, true, true, true],
    ['appointment.charge.read', { kind: 'appointment', appointmentId: 'apt', specialistId: 'sp_spec' }, true, true, true],
    ['payment.manage', { kind: 'appointment', appointmentId: 'apt', specialistId: 'sp_spec' }, true, true, true],
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

  it('fails closed for malformed resource facts and independently wrong fact ids', () => {
    const cases = [
      [ACTORS.specialist, 'appointment.manage', { kind: 'appointment', appointmentId: 'apt', specialistId: 'sp_other' }],
      [ACTORS.specialist, 'tus.manage', { kind: 'tus_group', groupId: 'tus', leaderSpecialistIds: ['sp_other'] }],
      [ACTORS.specialist, 'chat.direct', { kind: 'conversation', conversationId: 'con', participantStaffIds: ['stf_other'] }],
      [ACTORS.specialist, 'client.operational.read', { ...activeAssignment, clientId: '' }],
      [ACTORS.specialist, 'client.operational.read', { ...activeAssignment, assignment: { ...activeAssignment.assignment, status: 'inactive' } }],
      [{ ...ACTORS.specialist, specialistId: null }, 'appointment.manage', { kind: 'appointment', appointmentId: 'apt', specialistId: 'sp_spec' }],
      [ACTORS.owner, 'not.a.capability', centre],
      [ACTORS.owner, 'staff.manage', { kind: 'wrong' }],
    ]
    for (const [actor, capability, resource] of cases) expect(authorize(actor, capability, resource, { nowMs: NOW_MS })).toBe(false)
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
    const breakGlass = { kind: 'break_glass', ownerStaffId: 'stf_owner', clientId: 'cli_1', startsAt: NOW_MS - 1, expiresAt: NOW_MS + 1, revokedAt: null }
    const clinicalTarget = { kind: 'client', clientId: 'cli_1', breakGlass }
    expect(authorize(ACTORS.owner, 'clinical.read', clinicalTarget, { nowMs: NOW_MS })).toBe(true)
    for (const fact of [
      { ...breakGlass, ownerStaffId: 'stf_other' },
      { ...breakGlass, startsAt: NOW_MS + 1 }, { ...breakGlass, expiresAt: NOW_MS }, { ...breakGlass, revokedAt: NOW_MS - 1 },
    ]) expect(authorize(ACTORS.owner, 'clinical.read', { ...clinicalTarget, breakGlass: fact }, { nowMs: NOW_MS })).toBe(false)
    expect(authorize(ACTORS.owner, 'clinical.read', { ...clinicalTarget, clientId: 'cli_other' }, { nowMs: NOW_MS })).toBe(false)
    expect(authorize(ACTORS.coordinator, 'clinical.read', clinicalTarget, { nowMs: NOW_MS })).toBe(false)
  })
})
