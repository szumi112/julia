import { auditEventStatement } from '../audit/events.js'
import { createUnitOfWork } from '../db/unit-of-work.js'
import { isD1IdentityCollision } from '../db/errors.js'
import { decodeBase64Url } from './encoding.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const NAME = /^[a-z][a-z0-9_]{0,63}$/
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const positive = (value) => Number.isSafeInteger(value) && value > 0
const id = (value) => typeof value === 'string' && ID.test(value)
const invalid = () => { throw new Error('DATA_KEY_REWRAP_INVALID') }
const encoded = (value, length) => {
  let bytes
  try {
    bytes = decodeBase64Url(value)
    return bytes.byteLength === length
  } catch {
    return false
  } finally {
    bytes?.fill(0)
  }
}

function validatePatch(patch) {
  const whereKeys = ['id', 'scope_type', 'scope_id', 'purpose', 'dek_version', 'wrapped_key_b64', 'wrap_nonce_b64', 'kek_version']
  const setKeys = ['wrapped_key_b64', 'wrap_nonce_b64', 'kek_version']
  if (!own(patch, ['where', 'set']) || !own(patch.where, whereKeys) || !own(patch.set, setKeys)) invalid()
  const { where, set } = patch
  if (!id(where.id) || !NAME.test(where.scope_type) || !id(where.scope_id) || !NAME.test(where.purpose)
    || !positive(where.dek_version) || !positive(where.kek_version) || !positive(set.kek_version)
    || set.kek_version <= where.kek_version
    || !encoded(where.wrapped_key_b64, 48) || !encoded(where.wrap_nonce_b64, 12)
    || !encoded(set.wrapped_key_b64, 48) || !encoded(set.wrap_nonce_b64, 12)
    || set.wrapped_key_b64 === where.wrapped_key_b64 || set.wrap_nonce_b64 === where.wrap_nonce_b64) invalid()
  return patch
}

const stateMatches = (row, expected) => row && Object.entries(expected).every(([key, value]) => row[key] === value)

export async function applyDataKeyRewrap(db, patchInput, {
  actorStaffId,
  correlationId,
  occurredAt,
  auditId,
} = {}) {
  const patch = validatePatch(patchInput)
  if (!id(actorStaffId) || !id(correlationId) || !id(auditId)) invalid()
  const { where, set } = patch
  const update = db.prepare(
    `UPDATE data_keys
     SET wrapped_key_b64=?,wrap_nonce_b64=?,kek_version=?
     WHERE id=? AND scope_type=? AND scope_id=? AND purpose=? AND dek_version=?
       AND wrapped_key_b64=? AND wrap_nonce_b64=? AND kek_version=?`
  ).bind(
    set.wrapped_key_b64, set.wrap_nonce_b64, set.kek_version,
    where.id, where.scope_type, where.scope_id, where.purpose, where.dek_version,
    where.wrapped_key_b64, where.wrap_nonce_b64, where.kek_version,
  )
  const audit = auditEventStatement(db, {
    id: auditId,
    occurredAt,
    actorStaffId,
    action: 'data_key.rewrapped',
    entityType: 'data_key',
    entityId: where.id,
    result: 'success',
    correlationId,
    metadata: { oldKekVersion: where.kek_version, newKekVersion: set.kek_version },
    reasonEnvelope: null,
  })
  const guard = db.prepare(
    `INSERT INTO audit_events
     (id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,reason_envelope,correlation_id,metadata_json)
     SELECT id,occurred_at,actor_staff_id,action,entity_type,entity_id,result,reason_envelope,correlation_id,metadata_json
     FROM audit_events
     WHERE id=? AND NOT (
       changes()=1
       AND EXISTS (
         SELECT 1 FROM data_keys
         WHERE id=? AND scope_type=? AND scope_id=? AND purpose=? AND dek_version=?
           AND wrapped_key_b64=? AND wrap_nonce_b64=? AND kek_version=?
       )
     )`
  ).bind(
    auditId, where.id, where.scope_type, where.scope_id, where.purpose, where.dek_version,
    set.wrapped_key_b64, set.wrap_nonce_b64, set.kek_version,
  )
  const uow = createUnitOfWork(db, {
    mode: 'mutation',
    actorId: actorStaffId,
    correlationId,
  })
  uow.audit(audit).domain(update).guard(guard)
  try {
    await uow.commit()
  } catch (error) {
    if (!isD1IdentityCollision(error)) throw error
    const current = await db.prepare(
      `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,wrap_nonce_b64,kek_version
       FROM data_keys WHERE id=?`
    ).bind(where.id).first()
    if (!current || !stateMatches(current, where)) throw new Error('VERSION_CONFLICT')
    throw error
  }
}
