import { isAppointmentId, isClientId, isSpecialistId } from '../../src/core-records.js'

const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ROLES = new Set(['owner', 'coordinator', 'specialist'])
const notFound = () => { throw new Error('NOT_FOUND') }
const cryptoFailure = () => { throw new Error('CRYPTO_FAILURE') }

export const CENTRE_RESOURCE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
export const SPECIALIST_DIRECTORY_RESOURCE = Object.freeze({
  kind: 'specialist_directory', centreId: 'centre_1',
})

const captureFields = (value, keys, { exact = false } = {}) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (exact && (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key)))) return null
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null
      captured[key] = descriptor.value
    }
    return captured
  } catch {
    return null
  }
}

const captureActor = (value) => {
  const actor = captureFields(value, ['id', 'role', 'specialistId'])
  if (!actor || !STAFF_ID.test(actor.id) || !ROLES.has(actor.role)
    || (actor.specialistId !== null && !isSpecialistId(actor.specialistId))
    || (actor.role === 'specialist' && !isSpecialistId(actor.specialistId))) return null
  return Object.freeze(actor)
}

const exactRow = (value, keys) => {
  const row = captureFields(value, keys, { exact: true })
  if (!row) cryptoFailure()
  return row
}

const first = async (db, sql, bindings) => {
  try {
    if (db === null || typeof db !== 'object') cryptoFailure()
    const prepare = db.prepare
    if (typeof prepare !== 'function') cryptoFailure()
    return await Reflect.apply(prepare, db, [sql]).bind(...bindings).first()
  } catch {
    cryptoFailure()
  }
}

const requireFactRow = (row) => {
  if (row === null || row === undefined) notFound()
  return row
}

const frozenAssignment = (clientId, specialistId) => Object.freeze({
  kind: 'client_assignment', clientId, specialistId, status: 'active',
})

export async function loadClientResourceFact(db, value, clientId) {
  const actor = captureActor(value)
  if (!actor || !isClientId(clientId)) notFound()
  const specialistScope = actor.role === 'specialist'
  const sql = specialistScope
    ? `SELECT c.id AS client_id,
              ca.client_id AS assignment_client_id,
              ca.specialist_id AS assignment_specialist_id
       FROM clients c
       JOIN client_assignments ca
         ON ca.client_id=c.id AND ca.ends_at IS NULL
       JOIN specialists s
         ON s.id=ca.specialist_id AND s.status='active'
       WHERE c.id=? AND c.status IN ('active','paused')
         AND ca.specialist_id=? AND s.staff_user_id=?`
    : `SELECT c.id AS client_id,
              CASE WHEN s.id IS NULL THEN NULL ELSE ca.client_id END AS assignment_client_id,
              CASE WHEN s.id IS NULL THEN NULL ELSE ca.specialist_id END AS assignment_specialist_id
       FROM clients c
       LEFT JOIN client_assignments ca
         ON ca.client_id=c.id AND ca.ends_at IS NULL
       LEFT JOIN specialists s
         ON s.id=ca.specialist_id AND s.status='active'
       WHERE c.id=? AND c.status IN ('active','paused')`
  const bindings = specialistScope
    ? [clientId, actor.specialistId, actor.id]
    : [clientId]
  const row = exactRow(requireFactRow(await first(db, sql, bindings)), [
    'client_id', 'assignment_client_id', 'assignment_specialist_id',
  ])
  if (row.client_id !== clientId || !isClientId(row.client_id)) cryptoFailure()
  const empty = row.assignment_client_id === null && row.assignment_specialist_id === null
  const active = row.assignment_client_id === clientId
    && isSpecialistId(row.assignment_specialist_id)
  if (!empty && !active) cryptoFailure()
  if (specialistScope && (!active || row.assignment_specialist_id !== actor.specialistId)) {
    cryptoFailure()
  }
  return Object.freeze({
    kind: 'client', clientId,
    assignment: active ? frozenAssignment(clientId, row.assignment_specialist_id) : null,
  })
}

export async function loadClientHistoryResourceFact(db, value, input) {
  const actor = captureActor(value)
  const ids = captureFields(input, ['clientId', 'appointmentId'], { exact: true })
  if (!actor || !ids || !isClientId(ids.clientId) || !isAppointmentId(ids.appointmentId)) {
    notFound()
  }
  const specialistScope = actor.role === 'specialist'
  const sql = specialistScope
    ? `SELECT c.id AS client_id, a.id AS appointment_id, a.specialist_id AS specialist_id
       FROM clients c
       JOIN appointments a ON a.client_id=c.id
       JOIN specialists s
         ON s.id=a.specialist_id AND s.status='active'
       WHERE c.id=? AND c.status='archived' AND a.id=?
         AND a.specialist_id=? AND s.staff_user_id=?`
    : `SELECT c.id AS client_id, a.id AS appointment_id, a.specialist_id AS specialist_id
       FROM clients c
       JOIN appointments a ON a.client_id=c.id
       WHERE c.id=? AND c.status='archived' AND a.id=?`
  const bindings = specialistScope
    ? [ids.clientId, ids.appointmentId, actor.specialistId, actor.id]
    : [ids.clientId, ids.appointmentId]
  const row = exactRow(requireFactRow(await first(db, sql, bindings)), [
    'client_id', 'appointment_id', 'specialist_id',
  ])
  if (row.client_id !== ids.clientId || row.appointment_id !== ids.appointmentId
    || !isSpecialistId(row.specialist_id)
    || (specialistScope && row.specialist_id !== actor.specialistId)) cryptoFailure()
  return Object.freeze({
    kind: 'client_history', clientId: row.client_id,
    appointmentId: row.appointment_id, specialistId: row.specialist_id,
  })
}

export async function loadAppointmentResourceFact(db, value, appointmentId) {
  const actor = captureActor(value)
  if (!actor || !isAppointmentId(appointmentId)) notFound()
  const specialistScope = actor.role === 'specialist'
  const sql = specialistScope
    ? `SELECT a.id AS appointment_id, a.specialist_id AS specialist_id
       FROM appointments a
       JOIN specialists s
         ON s.id=a.specialist_id AND s.status='active'
       WHERE a.id=? AND a.specialist_id=? AND s.staff_user_id=?`
    : `SELECT a.id AS appointment_id, a.specialist_id AS specialist_id
       FROM appointments a
       WHERE a.id=?`
  const bindings = specialistScope
    ? [appointmentId, actor.specialistId, actor.id]
    : [appointmentId]
  const row = exactRow(requireFactRow(await first(db, sql, bindings)), [
    'appointment_id', 'specialist_id',
  ])
  if (row.appointment_id !== appointmentId || !isSpecialistId(row.specialist_id)
    || (specialistScope && row.specialist_id !== actor.specialistId)) cryptoFailure()
  return Object.freeze({
    kind: 'appointment', appointmentId: row.appointment_id, specialistId: row.specialist_id,
  })
}
