import { describe, expect, it } from 'vitest'
import {
  CENTRE_RESOURCE,
  SPECIALIST_DIRECTORY_RESOURCE,
  ACTIVITY_CENTRE_RESOURCE,
  loadActivityGroupResourceFact,
  loadActivityParticipantResourceFact,
  loadAppointmentResourceFact,
  loadClientHistoryResourceFact,
  loadClientResourceFact,
} from '../../worker/core/resources.js'
import { authorityActor } from './fixtures.js'

const owner = authorityActor({
  id: 'stf_owner', role: 'owner', specialistId: 'sp_owner',
})
const coordinator = authorityActor({ id: 'stf_coord', role: 'coordinator' })
const specialist = authorityActor({
  id: 'stf_spec', role: 'specialist', specialistId: 'sp_spec',
})
const CURRENT_DAY = '2027-03-01'
const CURRENT_MS = Date.parse('2027-03-01T08:00:00.000Z')

const fakeDb = (...rows) => {
  const calls = []
  return {
    calls,
    prepare(sql) {
      const call = { sql, bindings: null }
      calls.push(call)
      return {
        bind(...bindings) {
          call.bindings = bindings
          return { first: async () => rows.shift() }
        },
      }
    },
  }
}

describe('core authorization resource facts', () => {
  it('publishes exact frozen centre and active-directory facts', () => {
    expect(CENTRE_RESOURCE).toEqual({ kind: 'centre', centreId: 'centre_1' })
    expect(SPECIALIST_DIRECTORY_RESOURCE).toEqual({ kind: 'specialist_directory', centreId: 'centre_1' })
    expect(Object.isFrozen(CENTRE_RESOURCE)).toBe(true)
    expect(Object.isFrozen(SPECIALIST_DIRECTORY_RESOURCE)).toBe(true)
    expect(ACTIVITY_CENTRE_RESOURCE).toEqual({
      kind: 'activity_centre', centreId: 'centre_1',
    })
    expect(Object.isFrozen(ACTIVITY_CENTRE_RESOURCE)).toBe(true)
  })

  it('loads activity group/participant facts with specialist proof in the SQL predicate', async () => {
    const groupDb = fakeDb({
      group_id: 'agr_sowy', leader_specialist_ids_json: '["sp_spec"]',
    })
    await expect(loadActivityGroupResourceFact(
      groupDb, specialist, 'agr_sowy', CURRENT_MS,
    ))
      .resolves.toEqual({
        kind: 'activity_group', groupId: 'agr_sowy',
        leaderSpecialistIds: ['sp_spec'],
      })
    expect(groupDb.calls[0].sql).toContain('leader.specialist_id=?')
    expect(groupDb.calls[0].sql).toContain('leader.starts_on<=clock.day')
    expect(groupDb.calls[0].sql).toContain("coalesce(leader.ends_on,'9999-12-31')>=clock.day")
    expect(groupDb.calls[0].bindings).toEqual(['agr_sowy', CURRENT_DAY, 'sp_spec'])

    const participantDb = fakeDb({
      participant_id: 'acp_ola', leader_specialist_ids_json: '[]',
      responsible_specialist_id: 'sp_spec',
    })
    await expect(loadActivityParticipantResourceFact(
      participantDb, specialist, 'acp_ola', CURRENT_MS,
    )).resolves.toEqual({
      kind: 'activity_record', activityId: 'acp_ola',
      leaderSpecialistIds: [], responsibleSpecialistId: 'sp_spec',
    })
    expect(participantDb.calls[0].sql).toContain('charge.responsible_specialist_id=?')
    expect(participantDb.calls[0].sql).toContain("membership.membership_kind='interval'")
    expect(participantDb.calls[0].bindings).toEqual([
      'acp_ola', CURRENT_DAY, 'sp_spec', 'sp_spec', 'sp_spec',
    ])
  })

  it('derives centre activity facts from the same current-day interval semantics', async () => {
    const groupDb = fakeDb({
      group_id: 'agr_sowy', leader_specialist_ids_json: '["sp_spec"]',
    })
    await loadActivityGroupResourceFact(groupDb, owner, 'agr_sowy', CURRENT_MS)
    expect(groupDb.calls[0].sql).toContain('leader.starts_on<=clock.day')
    expect(groupDb.calls[0].sql).toContain(
      "coalesce(leader.ends_on,'9999-12-31')>=clock.day",
    )
    expect(groupDb.calls[0].sql).not.toContain('leader.ends_on IS NULL')
    expect(groupDb.calls[0].bindings).toEqual([CURRENT_DAY, 'agr_sowy'])

    const participantDb = fakeDb({
      participant_id: 'acp_ola', leader_specialist_ids_json: '["sp_spec"]',
      responsible_specialist_id: null,
    })
    await loadActivityParticipantResourceFact(
      participantDb, coordinator, 'acp_ola', CURRENT_MS,
    )
    expect(participantDb.calls[0].sql).toContain("membership.membership_kind='interval'")
    expect(participantDb.calls[0].sql).toContain('membership.starts_on<=clock.day')
    expect(participantDb.calls[0].sql).toContain('leader.starts_on<=clock.day')
    expect(participantDb.calls[0].sql).not.toContain('leader.ends_on IS NULL')
    expect(participantDb.calls[0].bindings).toEqual([CURRENT_DAY, 'acp_ola'])
  })

  it('binds a valid explicit group-scope day for specialist and centre scope', async () => {
    const specialistDb = fakeDb({
      group_id: 'agr_sowy', leader_specialist_ids_json: '["sp_spec"]',
    })
    await expect(loadActivityGroupResourceFact(
      specialistDb, specialist, 'agr_sowy', CURRENT_MS, '2027-02-15',
    )).resolves.toEqual({
      kind: 'activity_group', groupId: 'agr_sowy',
      leaderSpecialistIds: ['sp_spec'],
    })
    expect(specialistDb.calls[0].bindings).toEqual([
      'agr_sowy', '2027-02-15', 'sp_spec',
    ])

    const centreDb = fakeDb({
      group_id: 'agr_sowy', leader_specialist_ids_json: '[]',
    })
    await loadActivityGroupResourceFact(
      centreDb, coordinator, 'agr_sowy', CURRENT_MS, '2027-02-15',
    )
    expect(centreDb.calls[0].bindings).toEqual(['2027-02-15', 'agr_sowy'])
  })

  it('rejects an impossible explicit group-scope day before querying', async () => {
    const invalidDb = fakeDb()
    await expect(loadActivityGroupResourceFact(
      invalidDb, specialist, 'agr_sowy', CURRENT_MS, '2027-02-30',
    )).rejects.toThrow(/^NOT_FOUND$/)
    expect(invalidDb.calls).toHaveLength(0)
  })

  it('conceals malformed and out-of-scope activity IDs before or within one query', async () => {
    for (const [loader, id] of [
      [loadActivityGroupResourceFact, 'tus_group'],
      [loadActivityParticipantResourceFact, 'participant_ola'],
    ]) {
      const db = fakeDb()
      await expect(loader(db, specialist, id, CURRENT_MS)).rejects.toThrow(/^NOT_FOUND$/)
      expect(db.calls).toHaveLength(0)
    }
    const db = fakeDb(null)
    await expect(loadActivityGroupResourceFact(db, specialist, 'agr_other', CURRENT_MS))
      .rejects.toThrow(/^NOT_FOUND$/)
    expect(db.calls).toHaveLength(1)
    const forged = fakeDb()
    await expect(loadActivityGroupResourceFact(
      forged, specialist, 'agr_other', '2020-01-01',
    )).rejects.toThrow(/^NOT_FOUND$/)
    expect(forged.calls).toHaveLength(0)
  })

  it('loads an exact frozen client fact for centre scope in one scoped query', async () => {
    const db = fakeDb({
      client_id: 'cl_one',
      assignment_client_id: 'cl_one',
      assignment_specialist_id: 'sp_active',
    })
    const fact = await loadClientResourceFact(db, coordinator, 'cl_one')
    expect(fact).toEqual({
      kind: 'client',
      clientId: 'cl_one',
      assignment: {
        kind: 'client_assignment', clientId: 'cl_one', specialistId: 'sp_active', status: 'active',
      },
    })
    expect(Object.isFrozen(fact)).toBe(true)
    expect(Object.isFrozen(fact.assignment)).toBe(true)
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql).toContain("c.status IN ('active','paused')")
    expect(db.calls[0].sql).toContain("s.status='active'")
    expect(db.calls[0].bindings).toEqual(['cl_one'])
  })

  it('binds specialist client scope to their retained active profile before policy', async () => {
    const db = fakeDb({
      client_id: 'cl_one', assignment_client_id: 'cl_one', assignment_specialist_id: 'sp_spec',
    })
    await expect(loadClientResourceFact(db, specialist, 'cl_one')).resolves.toEqual({
      kind: 'client',
      clientId: 'cl_one',
      assignment: {
        kind: 'client_assignment', clientId: 'cl_one', specialistId: 'sp_spec', status: 'active',
      },
    })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].sql).toContain("s.status='active'")
    expect(db.calls[0].sql).toContain('s.staff_user_id=?')
    expect(db.calls[0].sql).toContain('ca.specialist_id=?')
    expect(db.calls[0].bindings).toEqual(['cl_one', 'sp_spec', 'stf_spec'])
  })

  it('collapses absent, inactive, archived-out-of-scope, and guessed clients to NOT_FOUND', async () => {
    for (const clientId of ['cl_absent', 'cl_inactive', 'cl_archived', 'other']) {
      const db = fakeDb(null)
      await expect(loadClientResourceFact(db, specialist, clientId)).rejects.toThrow(/^NOT_FOUND$/)
      expect(db.calls.length).toBe(clientId === 'other' ? 0 : 1)
    }
  })

  it('loads archived identity history only through an exact returned appointment', async () => {
    for (const actor of [owner, coordinator, specialist]) {
      const db = fakeDb({ client_id: 'cl_old', appointment_id: 'apt_old', specialist_id: 'sp_spec' })
      const fact = await loadClientHistoryResourceFact(db, actor, {
        clientId: 'cl_old', appointmentId: 'apt_old',
      })
      expect(fact).toEqual({
        kind: 'client_history', clientId: 'cl_old', appointmentId: 'apt_old', specialistId: 'sp_spec',
      })
      expect(Object.isFrozen(fact)).toBe(true)
      expect(db.calls[0].sql).toContain("c.status='archived'")
      expect(db.calls[0].sql).toContain('a.client_id=c.id')
      if (actor.role === 'specialist') {
        expect(db.calls[0].sql).toContain('s.staff_user_id=?')
        expect(db.calls[0].bindings).toEqual(['cl_old', 'apt_old', 'sp_spec', 'stf_spec'])
      } else {
        expect(db.calls[0].bindings).toEqual(['cl_old', 'apt_old'])
      }
    }
  })

  it('loads centre appointments or only a specialist own active ledger', async () => {
    const adminDb = fakeDb({ appointment_id: 'apt_one', specialist_id: 'sp_other' })
    await expect(loadAppointmentResourceFact(adminDb, owner, 'apt_one')).resolves.toEqual({
      kind: 'appointment', appointmentId: 'apt_one', specialistId: 'sp_other',
    })
    expect(adminDb.calls[0].bindings).toEqual(['apt_one'])

    const ownDb = fakeDb({ appointment_id: 'apt_one', specialist_id: 'sp_spec' })
    await expect(loadAppointmentResourceFact(ownDb, specialist, 'apt_one')).resolves.toEqual({
      kind: 'appointment', appointmentId: 'apt_one', specialistId: 'sp_spec',
    })
    expect(ownDb.calls[0].sql).toContain("s.status='active'")
    expect(ownDb.calls[0].sql).toContain('s.staff_user_id=?')
    expect(ownDb.calls[0].bindings).toEqual(['apt_one', 'sp_spec', 'stf_spec'])
  })

  it('fails closed on malformed, extra, or hostile authoritative rows without fallback reads', async () => {
    const hostile = {}
    Object.defineProperty(hostile, 'client_id', {
      enumerable: true,
      get() { throw new Error('private-client-detail') },
    })
    for (const row of [
      { client_id: 'cl_one', assignment_client_id: null, assignment_specialist_id: null, extra: true },
      { client_id: 'cl_other', assignment_client_id: null, assignment_specialist_id: null },
      hostile,
    ]) {
      const db = fakeDb(row)
      await expect(loadClientResourceFact(db, owner, 'cl_one')).rejects.toThrow(/^CRYPTO_FAILURE$/)
      expect(db.calls).toHaveLength(1)
    }
  })

  it('captures hostile actor and compound identifiers as fixed NOT_FOUND without SQL', async () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error('private-actor-detail') } })
    const db = fakeDb()
    await expect(loadAppointmentResourceFact(db, hostile, 'apt_one')).rejects.toThrow(/^NOT_FOUND$/)
    await expect(loadClientHistoryResourceFact(db, specialist, new Proxy({}, {
      ownKeys() { throw new Error('private-input-detail') },
    }))).rejects.toThrow(/^NOT_FOUND$/)
    expect(db.calls).toHaveLength(0)
  })

  it('rejects cross-typed and oversized actor identifiers before SQL', async () => {
    for (const actor of [
      { id: 'stf_stripped', role: 'owner', specialistId: null },
      { id: `stf_${'a'.repeat(125)}`, role: 'owner', specialistId: null },
      { id: 'sp_actor', role: 'owner', specialistId: null },
      { id: 'stf_owner', role: 'owner', specialistId: 'stf_profile' },
    ]) {
      const db = fakeDb()
      await expect(loadAppointmentResourceFact(db, actor, 'apt_one')).rejects.toThrow(/^NOT_FOUND$/)
      expect(db.calls).toHaveLength(0)
    }

    const boundaryDb = fakeDb({ appointment_id: 'apt_one', specialist_id: 'sp_other' })
    await expect(loadAppointmentResourceFact(boundaryDb, authorityActor({
      id: `stf_${'a'.repeat(124)}`, role: 'owner', specialistId: `sp_${'a'.repeat(125)}`,
    }), 'apt_one')).resolves.toEqual({
      kind: 'appointment', appointmentId: 'apt_one', specialistId: 'sp_other',
    })
    expect(boundaryDb.calls).toHaveLength(1)
  })

  it('captures db.prepare once with its receiver and contains hostile database access', async () => {
    let reads = 0
    let calls = 0
    const db = {}
    Object.defineProperty(db, 'prepare', {
      get() {
        reads += 1
        if (reads > 1) throw new Error('prepare-reread-secret')
        return function prepare(sql) {
          expect(this).toBe(db)
          calls += 1
          return {
            bind: (...bindings) => ({
              first: async () => {
                expect(sql).toContain('FROM appointments a')
                expect(bindings).toEqual(['apt_one'])
                return { appointment_id: 'apt_one', specialist_id: 'sp_other' }
              },
            }),
          }
        }
      },
    })
    await expect(loadAppointmentResourceFact(db, owner, 'apt_one')).resolves.toEqual({
      kind: 'appointment', appointmentId: 'apt_one', specialistId: 'sp_other',
    })
    expect(reads).toBe(1)
    expect(calls).toBe(1)

    const throwing = {}
    Object.defineProperty(throwing, 'prepare', {
      get() { throw new Error('prepare-getter-secret') },
    })
    const target = {}
    const revoked = Proxy.revocable(target, {})
    revoked.revoke()
    for (const hostile of [throwing, revoked.proxy]) {
      await expect(loadAppointmentResourceFact(hostile, owner, 'apt_one'))
        .rejects.toThrow(/^CRYPTO_FAILURE$/)
    }
  })
})
