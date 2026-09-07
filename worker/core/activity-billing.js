import { validateFinanceEntryInput } from '../../src/finance-records.js'
import { FINANCE_SCOPE, createFinanceContext, loadFinanceContext } from './finance.js'
import { decryptActivityIdentity, loadActivityDataKey } from './activity-crypto.js'
import { auditEventStatement } from '../audit/events.js'
import { createIdempotencyStatement, createUnitOfWork, inspectIdempotency } from '../db/unit-of-work.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { authorize } from '../identity/policy.js'
import { resolveCurrentAuthorityActor } from '../identity/staff.js'
import { partsInWarsaw } from '../operations/clock.js'
import { encryptForScope } from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'

const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const BODY_KEYS = ['participantId', 'groupId', 'membershipId', 'responsibleSpecialistId',
  'accountingMonth', 'amountGrosze', 'lessonCount', 'paidAmountGrosze', 'paymentMethod',
  'settlementStatus', 'invoiceStatus']
const fail = (code) => { throw new Error(code) }
const invalid = () => fail('VALIDATION_FAILED/body')
const exact = (value, keys) => {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).length !== keys.length) invalid()
    return Object.fromEntries(keys.map((key) => {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
      return [key, descriptor.value]
    }))
  } catch { invalid() }
}
const validId = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{0,${prefix === 'sp' ? 124 : 123}}$`).test(value)
const currentAuthority = async (db, actor) => {
  let current
  try {
    current = await resolveCurrentAuthorityActor(db, { id: actor.id, role: actor.role,
      specialist_id: actor.specialistId, version: actor.version })
  } catch { fail('NOT_FOUND') }
  if (current.authorityRevision !== actor.authorityRevision
    || JSON.stringify(current.capabilities) !== JSON.stringify(actor.capabilities)) fail('NOT_FOUND')
}

const loadFacts = (db, body) => db.prepare(`
  SELECT participant.id AS participant_id,participant.program_id,participant.identity_envelope,
    participant.version AS participant_version,program.code,program.label AS program_label,
    program.version AS program_version,specialist.version AS specialist_version,
    activity_group.version AS group_version,activity_group.label_envelope,
    membership.version AS membership_version,membership.membership_kind,
    membership.starts_on,membership.ends_on,membership.observed_month
  FROM activity_participants AS participant
  JOIN activity_programs AS program ON program.id=participant.program_id AND program.status='active'
  JOIN specialists AS specialist ON specialist.id=? AND specialist.status='active'
  LEFT JOIN activity_groups AS activity_group ON activity_group.id=?
    AND activity_group.program_id=program.id AND activity_group.status='active'
  LEFT JOIN activity_memberships AS membership ON membership.id=?
    AND membership.participant_id=participant.id AND membership.program_id=program.id
    AND membership.group_id=activity_group.id AND membership.status='active'
  WHERE participant.id=? AND participant.status='active'
    AND (? IS NULL OR (activity_group.id IS NOT NULL AND membership.id IS NOT NULL))
`).bind(body.responsibleSpecialistId, body.groupId, body.membershipId,
  body.participantId, body.groupId).first()

const covered = (facts, month, grouped) => !grouped || (facts.membership_kind === 'interval'
  ? facts.starts_on.slice(0, 7) <= month && (facts.ends_on === null || facts.ends_on.slice(0, 7) >= month)
  : facts.observed_month === month)
const duplicate = (db, body) => db.prepare(`SELECT id FROM activity_charges
  WHERE participant_id=? AND group_id IS ? AND accounting_month=? AND status='active' LIMIT 1`)
  .bind(body.participantId, body.groupId, body.accountingMonth).first()
const snapshotFields = ['participant_version', 'program_version', 'specialist_version',
  'group_version', 'membership_version']

// A new charge represents the entire month's bill, including English lesson
// count. Existing day-precision imported bills also occupy that monthly slot.
// Correct amounts by voiding the old charge and creating its replacement;
// settlement/invoice changes use the linked finance entry's adjustment workflow.
export const createActivityCharge = (input) => createActivityChargeAttempt(input, true)

async function createActivityChargeAttempt(input, retryKeyCreation) {
  const command = exact(input, ['db', 'actor', 'keyring', 'nowMs', 'correlationId',
    'idFactory', 'body', 'idempotencyKey'])
  const actor = captureAuthorityActor(command.actor)
  if (!actor || !authorize(actor, 'finance.centre.manage', CENTRE, { nowMs: command.nowMs })) fail('NOT_FOUND')
  if (!Number.isSafeInteger(command.nowMs) || command.nowMs < 0
    || typeof command.idempotencyKey !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/.test(command.idempotencyKey)) invalid()
  const body = exact(command.body, BODY_KEYS)
  if (!validId(body.participantId, 'acp') || !validId(body.responsibleSpecialistId, 'sp')
    || !(body.groupId === null || validId(body.groupId, 'agr'))
    || !(body.membershipId === null || validId(body.membershipId, 'amb'))
    || (body.groupId === null) !== (body.membershipId === null)
    || typeof body.accountingMonth !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.accountingMonth)
    || body.accountingMonth < '2000-06' || body.accountingMonth > partsInWarsaw(command.nowMs).month) invalid()
  const { db, keyring } = command
  const now = new Date(command.nowMs).toISOString()
  await currentAuthority(db, actor)
  const context = await createFinanceContext(db, keyring, command.idFactory, now)
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  let digest
  try { digest = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) }
  finally { bytes.fill(0) }
  const idem = { actorId: actor.id, operation: 'activity.charge.create',
    idempotencyKey: command.idempotencyKey, expectedScope: FINANCE_SCOPE, requestDigest: digest }
  const replay = await inspectIdempotency(db, context, idem)
  if (replay) { await currentAuthority(db, actor); return replay }
  const facts = await loadFacts(db, body)
  if (!facts) fail('NOT_FOUND')
  if ((facts.code === 'tus' && body.groupId === null)
    || (facts.code === 'english' && body.groupId !== null)
    || !covered(facts, body.accountingMonth, body.groupId !== null)) invalid()
  const participantKey = await loadActivityDataKey(db, facts.identity_envelope)
  const counterparty = await decryptActivityIdentity(keyring, participantKey, {
    kind: 'participant', id: body.participantId, programId: facts.program_id,
    envelope: facts.identity_envelope,
  })
  const groupLabel = body.groupId === null ? null : await decryptActivityIdentity(keyring,
    await loadActivityDataKey(db, facts.label_envelope), {
      kind: 'group', id: body.groupId, programId: facts.program_id, envelope: facts.label_envelope,
    })
  const sourceLabel = groupLabel ? `${facts.program_label} — ${groupLabel}` : facts.program_label
  validateFinanceEntryInput({ kind: 'income', recordType: facts.code,
    accountingMonth: body.accountingMonth, occurredOn: null, amountGrosze: body.amountGrosze,
    paidAmountGrosze: body.paidAmountGrosze, paymentMethod: body.paymentMethod,
    settlementStatus: body.settlementStatus, invoiceStatus: body.invoiceStatus,
    counterparty, sourceLabel, invoiceNote: '', specialistId: body.responsibleSpecialistId,
    lessonCount: body.lessonCount, source: null })
  if (await duplicate(db, body)) fail('ACTIVITY_CHARGE_EXISTS')
  const id = (prefix) => {
    const value = `${prefix}_${command.idFactory()}`
    if (!validId(value, prefix)) fail('INTERNAL_ERROR')
    return value
  }
  const chargeId = id('ach'), entryId = id('fin'), auditId = id('aud')
  const details = JSON.stringify(await encryptForScope(keyring, context.dataKey, {
    expectedScope: FINANCE_SCOPE, recordId: entryId, field: 'details',
    plaintext: JSON.stringify({ schema: 'finance_entry_details.v1', counterparty,
      sourceLabel, invoiceNote: '', lessonCount: body.lessonCount }),
  }))
  const response = { status: 201, body: { data: { chargeId, entryId, version: 1 } } }
  const unit = createUnitOfWork(db, { mode: 'mutation', actorId: actor.id,
    correlationId: command.correlationId })
  if (context.statement) unit.domain(context.statement)
  unit.domain(db.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
     specialist_id,appointment_id,counterparty_lookup,details_envelope,source_row_envelope,
     version,created_by_staff_id,created_at,updated_at)
    VALUES (?,NULL,NULL,'income',?,?,NULL,?,?,?,?,?,?,NULL,NULL,?,NULL,1,?,?,?)`).bind(
    entryId, facts.code, body.accountingMonth, body.amountGrosze, body.paidAmountGrosze,
    body.paymentMethod, body.settlementStatus, body.invoiceStatus, body.responsibleSpecialistId,
    details, actor.id, now, now))
  unit.domain(db.prepare(`INSERT INTO activity_charges
    (id,participant_id,program_id,group_id,membership_id,period_precision,occurred_on,
     accounting_month,lesson_count,responsible_specialist_id,finance_entry_id,status,version,created_at,updated_at)
    VALUES (?,?,?,?,?,'month',NULL,?,?,?,?,'active',1,?,?)`).bind(
    chargeId, body.participantId, facts.program_id, body.groupId, body.membershipId,
    body.accountingMonth, body.lessonCount, body.responsibleSpecialistId, entryId, now, now))
  unit.audit(auditEventStatement(db, { id: auditId, occurredAt: now, actorStaffId: actor.id,
    action: 'activity.charge.created', entityType: 'activity_charge', entityId: chargeId,
    result: 'success', correlationId: command.correlationId,
    metadata: { chargeVersion: 1, entryVersion: 1 }, reasonEnvelope: null }))
  unit.idempotency(await createIdempotencyStatement(db, context, { ...idem,
    resourceType: 'activity_charge', resourceId: chargeId, response, createdAt: now,
    expiresAt: new Date(command.nowMs + 7 * 86_400_000).toISOString() }))
  unit.guard(db.prepare(`INSERT INTO core_directory_invariant_failures (failure_kind)
    SELECT 'activity_charge_postcondition' WHERE NOT (
      EXISTS (SELECT 1 FROM activity_charges WHERE id=? AND finance_entry_id=? AND version=1)
      AND (SELECT COUNT(*) FROM activity_charges WHERE participant_id=? AND group_id IS ?
        AND accounting_month=? AND status='active')=1
      AND EXISTS (SELECT 1 FROM finance_entries WHERE id=? AND version=1)
      AND EXISTS (SELECT 1 FROM activity_participants WHERE id=? AND version=? AND status='active')
      AND EXISTS (SELECT 1 FROM activity_programs WHERE id=? AND version=? AND status='active')
      AND EXISTS (SELECT 1 FROM specialists WHERE id=? AND version=? AND status='active')
      AND (? IS NULL OR (EXISTS (SELECT 1 FROM activity_groups WHERE id=? AND version=? AND status='active')
        AND EXISTS (SELECT 1 FROM activity_memberships WHERE id=? AND version=? AND status='active')))
      AND EXISTS (SELECT 1 FROM staff_users AS staff JOIN staff_authorities AS authority ON authority.staff_id=staff.id
        WHERE staff.id=? AND staff.role=? AND staff.specialist_id IS ? AND staff.version=?
          AND staff.status='active' AND authority.revision=?)
      AND EXISTS (SELECT 1 FROM audit_events WHERE id=? AND entity_id=? AND action='activity.charge.created')
    )`).bind(chargeId, entryId, body.participantId, body.groupId, body.accountingMonth,
    entryId, body.participantId, facts.participant_version, facts.program_id, facts.program_version,
    body.responsibleSpecialistId, facts.specialist_version, body.groupId, body.groupId, facts.group_version,
    body.membershipId, facts.membership_version, actor.id, actor.role, actor.specialistId,
    actor.version, actor.authorityRevision, auditId, chargeId))
  try { await unit.commit() } catch (error) {
    await currentAuthority(db, actor)
    const currentContext = await loadFinanceContext(db, keyring)
    const racedReplay = await inspectIdempotency(db, currentContext, idem)
    if (racedReplay) return racedReplay
    if (await duplicate(db, body)) fail('ACTIVITY_CHARGE_EXISTS')
    const current = await loadFacts(db, body)
    if (!current || snapshotFields.some((field) => current[field] !== facts[field])) fail('VERSION_CONFLICT')
    if (retryKeyCreation && context.statement
      && currentContext.dataKey.id !== context.dataKey.id) {
      return createActivityChargeAttempt(input, false)
    }
    throw error
  }
  await currentAuthority(db, actor)
  return response
}
