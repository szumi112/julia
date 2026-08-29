import {
  effectiveCapabilitiesFor,
  isCapability,
  normalizeCapabilityOverrides,
} from '../../src/capabilities.js'
import { auditEventStatement } from '../audit/events.js'
import {
  createIdempotencyStatement,
  createUnitOfWork,
  inspectIdempotency,
} from '../db/unit-of-work.js'
import { isCorrelationId } from '../logging/safe-log.js'
import { decryptForScope } from '../security/envelope.js'
import { authorize } from './policy.js'

const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/
const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const OPERATION = 'staff.capabilities.update'
const DAY_MS = 24 * 60 * 60 * 1000
const ROLES = new Set(['owner', 'coordinator', 'specialist'])
const STATUSES = new Set(['pending', 'active', 'disabled'])
const DECISIONS = new Set(['allow', 'deny', 'cleared'])

const failure = (code) => { throw new Error(code) }
const validation = (field) => {
  const error = new Error('VALIDATION_FAILED')
  error.details = { field }
  throw error
}
const positive = (value) => Number.isSafeInteger(value) && value > 0
const exactCapabilities = (left, right) => Array.isArray(left)
  && left.length === right.length
  && left.every((value, index) => value === right[index])

const validCryptoContext = (value) => value?.keyring && value?.dataKey && value?.scope

const captureExact = (value, keys, field = 'body') => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) validation(field)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Reflect.ownKeys(descriptors)
    if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      validation(field)
    }
    const captured = {}
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        validation(field)
      }
      captured[key] = descriptor.value
    }
    return Object.freeze(captured)
  } catch (error) {
    if (error?.message === 'VALIDATION_FAILED') throw error
    validation(field)
  }
}

const idFrom = (prefix, factory) => {
  let suffix
  try { suffix = factory() } catch { failure('INTERNAL_ERROR') }
  const id = `${prefix}_${suffix}`
  if (typeof suffix !== 'string' || !ID.test(id)) failure('INTERNAL_ERROR')
  return id
}

const versionConflict = (currentVersion) => {
  const error = new Error('VERSION_CONFLICT')
  error.details = { currentVersion }
  throw error
}

const replacementFor = (input, role) => {
  const captured = captureExact(input, ['expectedAuthorityRevision', 'allow', 'deny'])
  if (!positive(captured.expectedAuthorityRevision)) validation('expectedAuthorityRevision')
  try {
    return Object.freeze({
      expectedAuthorityRevision: captured.expectedAuthorityRevision,
      ...normalizeCapabilityOverrides({
        role,
        allow: captured.allow,
        deny: captured.deny,
      }),
    })
  } catch (error) {
    const field = /\/(allow|deny)$/.exec(error?.message ?? '')?.[1]
    validation(field ?? 'body')
  }
}

async function loadStoredOverrides(db, staffId) {
  const rows = (await db.prepare(
    `SELECT capability,decision,version,changed_by_staff_id,created_at,updated_at
     FROM staff_capability_overrides WHERE staff_id=? ORDER BY capability`,
  ).bind(staffId).all()).results
  if (!Array.isArray(rows)) failure('INTERNAL_ERROR')
  const allow = []
  const deny = []
  for (const row of rows) {
    if (!isCapability(row.capability) || !DECISIONS.has(row.decision)
      || !positive(row.version) || !STAFF_ID.test(row.changed_by_staff_id ?? '')
      || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') {
      failure('INTERNAL_ERROR')
    }
    if (row.decision === 'allow') allow.push(row.capability)
    if (row.decision === 'deny') deny.push(row.capability)
  }
  return Object.freeze({
    allow: Object.freeze(allow),
    deny: Object.freeze(deny),
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
  })
}

async function loadAuthorityStaff(db, staffId) {
  const row = await db.prepare(
    `SELECT staff.id,staff.role,staff.status,staff.specialist_id,staff.version,
            staff.display_name_envelope,authority.revision AS authority_revision
     FROM staff_users AS staff
     LEFT JOIN staff_authorities AS authority ON authority.staff_id=staff.id
     WHERE staff.id=?`,
  ).bind(staffId).first()
  if (!row) return null
  if (!STAFF_ID.test(row.id ?? '') || !ROLES.has(row.role) || !STATUSES.has(row.status)
    || !positive(row.version) || !positive(row.authority_revision)
    || typeof row.display_name_envelope !== 'string'
    || (row.role === 'specialist'
      ? typeof row.specialist_id !== 'string'
      : row.specialist_id !== null && typeof row.specialist_id !== 'string')) {
    failure('INTERNAL_ERROR')
  }
  const overrides = await loadStoredOverrides(db, row.id)
  let capabilities
  try {
    capabilities = effectiveCapabilitiesFor({
      role: row.role,
      allow: overrides.allow,
      deny: overrides.deny,
    })
  } catch {
    failure('INTERNAL_ERROR')
  }
  return Object.freeze({
    row: Object.freeze({ ...row }),
    overrides,
    actor: Object.freeze({
      id: row.id,
      role: row.role,
      specialistId: row.specialist_id ?? null,
      version: row.version,
      authorityRevision: row.authority_revision,
      capabilities,
    }),
  })
}

async function activePermissionsOwner(db, actor, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
    || !authorize(actor, 'permissions.manage', CENTRE, { nowMs })) {
    failure('FORBIDDEN')
  }
  const current = await loadAuthorityStaff(db, actor.id)
  if (!current || current.row.status !== 'active'
    || current.actor.role !== 'owner'
    || current.actor.version !== actor.version
    || current.actor.specialistId !== actor.specialistId
    || current.actor.authorityRevision !== actor.authorityRevision
    || !exactCapabilities(current.actor.capabilities, actor.capabilities)
    || !authorize(current.actor, 'permissions.manage', CENTRE, { nowMs })) {
    failure('FORBIDDEN')
  }
  return current
}

async function displayNameFor(cryptoContext, row) {
  let displayName
  try {
    displayName = await decryptForScope(
      cryptoContext.keyring,
      cryptoContext.dataKey,
      {
        expectedScope: cryptoContext.scope,
        recordId: row.id,
        field: 'display_name',
        envelope: JSON.parse(row.display_name_envelope),
      },
    )
  } catch {
    failure('CRYPTO_FAILURE')
  }
  if (typeof displayName !== 'string' || displayName.length === 0) failure('CRYPTO_FAILURE')
  return displayName
}

async function authorityDto(cryptoContext, current) {
  let normalized
  try {
    normalized = normalizeCapabilityOverrides({
      role: current.row.role,
      allow: current.overrides.allow,
      deny: current.overrides.deny,
    })
  } catch {
    failure('INTERNAL_ERROR')
  }
  if (!exactCapabilities(normalized.allow, current.overrides.allow)
    || !exactCapabilities(normalized.deny, current.overrides.deny)) {
    failure('INTERNAL_ERROR')
  }
  return Object.freeze({
    staffId: current.row.id,
    displayName: await displayNameFor(cryptoContext, current.row),
    role: current.row.role,
    status: current.row.status,
    authorityRevision: current.row.authority_revision,
    allow: normalized.allow,
    deny: normalized.deny,
    effectiveCapabilities: current.actor.capabilities,
  })
}

const responseBodyFor = (authority, normalized, authorityRevision) => Object.freeze({
  data: Object.freeze({
    authority: Object.freeze({
      staffId: authority.staffId,
      displayName: authority.displayName,
      role: authority.role,
      status: authority.status,
      authorityRevision,
      allow: normalized.allow,
      deny: normalized.deny,
      effectiveCapabilities: effectiveCapabilitiesFor({
        role: authority.role,
        allow: normalized.allow,
        deny: normalized.deny,
      }),
    }),
  }),
})

const validateReplayBody = (value, expected) => {
  try {
    const root = captureExact(value, ['data'])
    const data = captureExact(root.data, ['authority'])
    const authority = captureExact(data.authority, [
      'staffId', 'displayName', 'role', 'status', 'authorityRevision',
      'allow', 'deny', 'effectiveCapabilities',
    ])
    const wanted = expected.data.authority
    if (authority.staffId !== wanted.staffId
      || authority.displayName !== wanted.displayName
      || authority.role !== wanted.role
      || authority.status !== wanted.status
      || authority.authorityRevision !== wanted.authorityRevision
      || !exactCapabilities(authority.allow, wanted.allow)
      || !exactCapabilities(authority.deny, wanted.deny)
      || !exactCapabilities(authority.effectiveCapabilities, wanted.effectiveCapabilities)) {
      failure('CRYPTO_FAILURE')
    }
    return expected
  } catch (error) {
    if (error?.message === 'CRYPTO_FAILURE') throw error
    failure('CRYPTO_FAILURE')
  }
}

export async function listCapabilityTargets({ db, cryptoContext, actor, nowMs } = {}) {
  if (!db?.prepare || !validCryptoContext(cryptoContext)) failure('VALIDATION_FAILED')
  await activePermissionsOwner(db, actor, nowMs)
  const rows = (await db.prepare(
    `SELECT staff.id,staff.role,staff.status,staff.specialist_id,staff.version,
            staff.display_name_envelope,authority.revision AS authority_revision
     FROM staff_users AS staff
     LEFT JOIN staff_authorities AS authority ON authority.staff_id=staff.id`,
  ).all()).results
  if (!Array.isArray(rows)) failure('INTERNAL_ERROR')
  const targets = []
  for (const row of rows) {
    if (!STAFF_ID.test(row.id ?? '') || !ROLES.has(row.role) || !STATUSES.has(row.status)
      || !positive(row.version) || !positive(row.authority_revision)
      || typeof row.display_name_envelope !== 'string') failure('INTERNAL_ERROR')
    targets.push(Object.freeze({
      staffId: row.id,
      displayName: await displayNameFor(cryptoContext, row),
      role: row.role,
      status: row.status,
      authorityRevision: row.authority_revision,
    }))
  }
  const collator = new Intl.Collator('pl-PL', { sensitivity: 'base', numeric: true })
  targets.sort((left, right) => (
    collator.compare(left.displayName, right.displayName)
      || left.staffId.localeCompare(right.staffId)
  ))
  return Object.freeze({
    data: Object.freeze({ targets: Object.freeze(targets) }),
  })
}

export async function getCapabilityOverrides({
  db,
  cryptoContext,
  actor,
  staffId,
  nowMs,
} = {}) {
  if (!db?.prepare || !validCryptoContext(cryptoContext)) failure('VALIDATION_FAILED')
  await activePermissionsOwner(db, actor, nowMs)
  if (!STAFF_ID.test(staffId ?? '')) failure('NOT_FOUND')
  const target = await loadAuthorityStaff(db, staffId)
  if (!target) failure('NOT_FOUND')
  return Object.freeze({
    data: Object.freeze({ authority: await authorityDto(cryptoContext, target) }),
  })
}

const preconditionStatement = (db, actor, target) => {
  const rows = target.overrides.rows
  const rowClause = rows.length
    ? rows.map(() => '(capability=? AND decision=? AND version=?)').join(' OR ')
    : '0'
  return db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'capability_override_precondition'
     WHERE NOT (
       EXISTS (SELECT 1 FROM staff_users
         WHERE id=? AND role=? AND status='active' AND specialist_id IS ? AND version=?)
       AND EXISTS (SELECT 1 FROM staff_authorities
         WHERE staff_id=? AND revision=?)
       AND EXISTS (SELECT 1 FROM staff_users
         WHERE id=? AND role=? AND status=? AND specialist_id IS ? AND version=?)
       AND EXISTS (SELECT 1 FROM staff_authorities
         WHERE staff_id=? AND revision=?)
       AND (SELECT count(*) FROM staff_capability_overrides WHERE staff_id=?)=?
       AND NOT EXISTS (
         SELECT 1 FROM staff_capability_overrides
         WHERE staff_id=? AND NOT (${rowClause})
       )
     )`,
  ).bind(
    actor.row.id,
    actor.row.role,
    actor.row.specialist_id,
    actor.row.version,
    actor.row.id,
    actor.row.authority_revision,
    target.row.id,
    target.row.role,
    target.row.status,
    target.row.specialist_id,
    target.row.version,
    target.row.id,
    target.row.authority_revision,
    target.row.id,
    rows.length,
    target.row.id,
    ...rows.flatMap((row) => [row.capability, row.decision, row.version]),
  )
}

const guardStatement = (db, values) => {
  const active = [
    ...values.normalized.allow.map((capability) => [capability, 'allow']),
    ...values.normalized.deny.map((capability) => [capability, 'deny']),
  ].sort(([left], [right]) => left.localeCompare(right))
  const activeClause = active.length
    ? active.map(() => '(capability=? AND decision=?)').join(' OR ')
    : '0'
  const changedClause = values.changed.length
    ? values.changed.map(() => `(
        current.capability=? AND current.decision=? AND current.version=?
        AND current.changed_by_staff_id=? AND current.created_at=? AND current.updated_at=?
        AND EXISTS (SELECT 1 FROM staff_capability_override_history AS history
          WHERE history.id=? AND history.staff_id=current.staff_id
            AND history.capability=current.capability AND history.role_at_change=?
            AND history.decision=current.decision
            AND history.override_version=current.version
            AND history.authority_revision=? AND history.changed_by_staff_id=?
            AND history.reason='owner_update' AND history.changed_at=?)
      )`).join(' OR ')
    : '0'
  return db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'capability_override_postcondition'
     WHERE NOT (
       EXISTS (SELECT 1 FROM staff_authorities
         WHERE staff_id=? AND revision=? AND updated_at=?)
       AND EXISTS (SELECT 1 FROM staff_authorities
         WHERE staff_id=? AND revision=? AND updated_at=?)
       AND (SELECT count(*) FROM staff_capability_overrides
         WHERE staff_id=? AND decision IN ('allow','deny'))=?
       AND NOT EXISTS (
         SELECT 1 FROM staff_capability_overrides
         WHERE staff_id=? AND decision IN ('allow','deny') AND NOT (${activeClause})
       )
       AND (SELECT count(*) FROM staff_capability_override_history
         WHERE staff_id=? AND authority_revision=?)=?
       AND (SELECT count(*) FROM staff_capability_overrides AS current
         WHERE current.staff_id=? AND (${changedClause}))=?
       AND EXISTS (SELECT 1 FROM audit_events
         WHERE id=? AND occurred_at=? AND actor_staff_id=?
           AND action='staff.capabilities.updated' AND entity_type='staff_user'
           AND entity_id=? AND result='success' AND reason_envelope IS NULL
           AND correlation_id=? AND metadata_json=?)
       AND EXISTS (SELECT 1 FROM idempotency_records
         WHERE actor_id=? AND operation=? AND idempotency_key=?
           AND resource_type='staff_authority' AND resource_id=?)
     )`,
  ).bind(
    values.targetId,
    values.targetRevision,
    values.now,
    values.actorId,
    values.actorRevision,
    values.now,
    values.targetId,
    active.length,
    values.targetId,
    ...active.flat(),
    values.targetId,
    values.targetRevision,
    values.changed.length,
    values.targetId,
    ...values.changed.flatMap((change) => [
      change.capability,
      change.decision,
      change.version,
      values.actorId,
      change.createdAt,
      values.now,
      change.historyId,
      values.targetRole,
      values.targetRevision,
      values.actorId,
      values.now,
    ]),
    values.changed.length,
    values.auditId,
    values.now,
    values.actorId,
    values.targetId,
    values.correlationId,
    values.metadataJson,
    values.actorId,
    OPERATION,
    values.idempotencyKey,
    values.targetId,
  )
}

export async function replaceCapabilityOverrides({
  db,
  recoveryDb = db,
  cryptoContext,
  actor,
  staffId,
  input,
  idempotencyKey,
  correlationId,
  nowMs,
  idFactory = () => crypto.randomUUID().replaceAll('-', ''),
} = {}) {
  if (!db?.prepare || !db?.batch || !recoveryDb?.prepare
    || !validCryptoContext(cryptoContext) || typeof idFactory !== 'function'
    || !IDEMPOTENCY_KEY.test(idempotencyKey ?? '') || !isCorrelationId(correlationId)
    || !Number.isSafeInteger(nowMs) || nowMs < 0) validation('body')
  const owner = await activePermissionsOwner(db, actor, nowMs)
  if (!STAFF_ID.test(staffId ?? '')) failure('NOT_FOUND')
  const target = await loadAuthorityStaff(db, staffId)
  if (!target || target.row.status === 'disabled') failure('NOT_FOUND')
  const currentDto = await authorityDto(cryptoContext, target)
  const normalized = replacementFor(input, target.row.role)
  let body
  try {
    body = responseBodyFor(
      currentDto,
      normalized,
      normalized.expectedAuthorityRevision + 1,
    )
  } catch {
    failure('INTERNAL_ERROR')
  }
  const requestDigest = JSON.stringify({
    staffId,
    expectedAuthorityRevision: normalized.expectedAuthorityRevision,
    allow: normalized.allow,
    deny: normalized.deny,
  })
  const idem = Object.freeze({
    actorId: owner.actor.id,
    operation: OPERATION,
    idempotencyKey,
    requestDigest,
    expectedScope: cryptoContext.scope,
  })
  const replay = await inspectIdempotency(db, cryptoContext, idem)
  if (replay) return validateReplayBody(replay.body, body)
  if (target.row.authority_revision !== normalized.expectedAuthorityRevision) {
    versionConflict(target.row.authority_revision)
  }

  const now = new Date(nowMs).toISOString()
  const targetRevision = target.row.authority_revision + 1
  const actorRevision = owner.row.id === target.row.id
    ? targetRevision
    : owner.row.authority_revision + 1
  const desired = new Map([
    ...normalized.allow.map((capability) => [capability, 'allow']),
    ...normalized.deny.map((capability) => [capability, 'deny']),
  ])
  const currentByCapability = new Map(target.overrides.rows.map((row) => [row.capability, row]))
  const changed = []
  for (const capability of new Set([...currentByCapability.keys(), ...desired.keys()])) {
    const current = currentByCapability.get(capability) ?? null
    const decision = desired.get(capability) ?? 'cleared'
    if ((!current && decision === 'cleared') || current?.decision === decision) continue
    changed.push(Object.freeze({
      capability,
      decision,
      version: current ? current.version + 1 : 1,
      createdAt: current?.created_at ?? now,
      historyId: idFrom('cph', idFactory),
      current,
    }))
  }
  changed.sort((left, right) => left.capability.localeCompare(right.capability))
  const auditId = idFrom('aud', idFactory)
  const metadata = Object.freeze({
    actorAuthorityRevision: actorRevision,
    allowCount: normalized.allow.length,
    denyCount: normalized.deny.length,
    targetAuthorityRevision: targetRevision,
  })
  const metadataJson = JSON.stringify(Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)),
  ))
  const uow = createUnitOfWork(db, {
    mode: 'mutation',
    actorId: owner.actor.id,
    correlationId,
  })
  uow.domain(preconditionStatement(db, owner, target))
  if (owner.row.id !== target.row.id) {
    uow.domain(db.prepare(
      `UPDATE staff_authorities SET revision=revision+1,updated_at=?
       WHERE staff_id=? AND revision=?`,
    ).bind(now, owner.row.id, owner.row.authority_revision))
  }
  for (const change of changed) {
    if (change.current) {
      uow.domain(db.prepare(
        `UPDATE staff_capability_overrides
         SET decision=?,version=version+1,changed_by_staff_id=?,updated_at=?
         WHERE staff_id=? AND capability=? AND decision=? AND version=?`,
      ).bind(
        change.decision,
        owner.row.id,
        now,
        target.row.id,
        change.capability,
        change.current.decision,
        change.current.version,
      ))
    } else {
      uow.domain(db.prepare(
        `INSERT INTO staff_capability_overrides
         (staff_id,capability,decision,version,changed_by_staff_id,created_at,updated_at)
         VALUES (?,?,?,1,?,?,?)`,
      ).bind(
        target.row.id,
        change.capability,
        change.decision,
        owner.row.id,
        now,
        now,
      ))
    }
    uow.version(db.prepare(
      `INSERT INTO staff_capability_override_history
       (id,staff_id,capability,role_at_change,decision,override_version,
        authority_revision,changed_by_staff_id,reason,changed_at)
       VALUES (?,?,?,?,?,?,?,?, 'owner_update',?)`,
    ).bind(
      change.historyId,
      target.row.id,
      change.capability,
      target.row.role,
      change.decision,
      change.version,
      targetRevision,
      owner.row.id,
      now,
    ))
  }
  uow.domain(db.prepare(
    `UPDATE staff_authorities SET revision=revision+1,updated_at=?
     WHERE staff_id=? AND revision=?`,
  ).bind(now, target.row.id, target.row.authority_revision))
  uow.audit(auditEventStatement(db, {
    id: auditId,
    occurredAt: now,
    actorStaffId: owner.row.id,
    action: 'staff.capabilities.updated',
    entityType: 'staff_user',
    entityId: target.row.id,
    result: 'success',
    correlationId,
    metadata,
    reasonEnvelope: null,
  }))
  uow.idempotency(await createIdempotencyStatement(db, cryptoContext, {
    ...idem,
    resourceType: 'staff_authority',
    resourceId: target.row.id,
    response: Object.freeze({ status: 200, body }),
    createdAt: now,
    expiresAt: new Date(nowMs + 7 * DAY_MS).toISOString(),
  }))
  uow.guard(guardStatement(db, {
    normalized,
    changed,
    targetId: target.row.id,
    targetRole: target.row.role,
    targetRevision,
    actorId: owner.row.id,
    actorRevision,
    auditId,
    correlationId,
    metadataJson,
    idempotencyKey,
    now,
  }))
  try {
    await uow.commit()
    return body
  } catch (originalError) {
    let recovered
    try {
      recovered = await inspectIdempotency(recoveryDb, cryptoContext, idem)
    } catch (recoveryError) {
      if (['CRYPTO_FAILURE', 'IDEMPOTENCY_CONFLICT'].includes(recoveryError?.message)) {
        throw recoveryError
      }
      throw originalError
    }
    if (recovered) return validateReplayBody(recovered.body, body)
    let revisions
    try {
      revisions = await recoveryDb.prepare(
        `SELECT
           (SELECT revision FROM staff_authorities WHERE staff_id=?) AS target_revision,
           (SELECT revision FROM staff_authorities WHERE staff_id=?) AS actor_revision`,
      ).bind(target.row.id, owner.row.id).first()
    } catch {
      throw originalError
    }
    if (!revisions || !positive(revisions.target_revision)
      || !positive(revisions.actor_revision)) failure('INTERNAL_ERROR')
    if (revisions.target_revision !== target.row.authority_revision
      || revisions.actor_revision !== owner.row.authority_revision) {
      versionConflict(revisions.target_revision)
    }
    throw originalError
  }
}
