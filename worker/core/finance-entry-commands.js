import { validateFinanceEntryInput } from '../../src/finance-records.js'
import { FINANCE_SCOPE, createFinanceContext, loadFinanceContext } from './finance.js'
import { createIdempotencyStatement, createUnitOfWork, inspectIdempotency } from '../db/unit-of-work.js'
import { auditEventStatement } from '../audit/events.js'
import { authorize } from '../identity/policy.js'
import { captureAuthorityActor } from '../identity/authority-actor.js'
import { resolveCurrentAuthorityActor } from '../identity/staff.js'
import { encryptForScope, decryptForScope } from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'
import { partsInWarsaw } from '../operations/clock.js'

const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const fail = (code) => { throw new Error(code) }
const invalid = () => fail('VALIDATION_FAILED/body')
const exact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid()
  const captured = {}
  for (const key of keys) {
    if (!descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')) invalid()
    captured[key] = descriptors[key].value
  }
  return captured
}
const currentAuthority = async (db, actor) => {
  const current = await resolveCurrentAuthorityActor(db, {
    id: actor.id, role: actor.role, specialist_id: actor.specialistId, version: actor.version,
  })
  if (current.authorityRevision !== actor.authorityRevision
    || JSON.stringify(current.capabilities) !== JSON.stringify(actor.capabilities)) fail('NOT_FOUND')
}
const capture = async (input, adjustment) => {
  const command = exact(input, ['db', 'actor', 'keyring', 'nowMs', 'correlationId',
    'idFactory', 'body', 'idempotencyKey', ...(adjustment ? ['entryId'] : [])])
  const actor = captureAuthorityActor(command.actor)
  if (!actor || !authorize(actor, 'finance.centre.manage', CENTRE, { nowMs: command.nowMs })) fail('NOT_FOUND')
  if (!Number.isSafeInteger(command.nowMs) || command.nowMs < 0
    || !/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/.test(command.idempotencyKey ?? '')
    || (adjustment && !/^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(command.entryId ?? ''))) invalid()
  await currentAuthority(command.db, actor)
  return { ...command, actor, now: new Date(command.nowMs).toISOString() }
}
const seal = (context, recordId, field, value) => encryptForScope(context.keyring, context.dataKey, {
  expectedScope: FINANCE_SCOPE, recordId, field, plaintext: JSON.stringify(value),
}).then(JSON.stringify)
const identifier = (command, prefix) => {
  const id = `${prefix}_${command.idFactory()}`
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail('INTERNAL_ERROR')
  return id
}
const idemFor = async (command, operation, body) => ({ actorId: command.actor.id, operation,
  idempotencyKey: command.idempotencyKey, expectedScope: FINANCE_SCOPE,
  requestDigest: encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify([command.entryId ?? null, body]))))) })
const responseFor = (status, entryId, version) => ({ status, body: { data: { entryId, version } } })

async function commit(command, context, idem, entryId, version, statements, action, adjustmentId = null, specialist = null) {
  const { db, actor, now } = command
  const response = responseFor(version === 1 ? 201 : 200, entryId, version)
  const auditId = identifier(command, 'aud')
  const unit = createUnitOfWork(db, { mode: 'mutation', actorId: actor.id,
    correlationId: command.correlationId })
  if (context.statement) unit.domain(context.statement)
  for (const statement of statements) unit.domain(statement)
  unit.audit(auditEventStatement(db, { id: auditId, occurredAt: now,
    actorStaffId: actor.id, action, entityType: 'finance_entry', entityId: entryId,
    result: 'success', correlationId: command.correlationId,
    metadata: { entryVersion: version }, reasonEnvelope: null }))
  unit.idempotency(await createIdempotencyStatement(db, context, {
    ...idem, resourceType: 'finance_entry', resourceId: entryId, response,
    createdAt: now, expiresAt: new Date(command.nowMs + 7 * 86400000).toISOString(),
  }))
  // The guard is inside the same D1 batch as the data, audit and replay. A stale
  // entity or changed authority rolls the entire command back.
  unit.guard(db.prepare(`INSERT INTO core_directory_invariant_failures (failure_kind)
    SELECT 'finance_entry_postcondition' WHERE NOT (
      EXISTS (SELECT 1 FROM finance_entries WHERE id=? AND version=? AND updated_at=?)
      AND EXISTS (SELECT 1 FROM staff_users AS staff
        JOIN staff_authorities AS authority ON authority.staff_id=staff.id
        WHERE staff.id=? AND staff.status='active' AND staff.role=?
          AND staff.specialist_id IS ? AND staff.version=? AND authority.revision=?)
      AND EXISTS (SELECT 1 FROM audit_events WHERE id=? AND entity_id=? AND action=?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM finance_adjustments WHERE id=?))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM specialists WHERE id=? AND version=? AND status='active'))
      AND NOT EXISTS (SELECT 1 FROM finance_entries AS entry
        JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
        WHERE entry.id=? AND batch.status!='committed')
    )`).bind(entryId, version, now, actor.id, actor.role, actor.specialistId,
    actor.version, actor.authorityRevision, auditId, entryId, action, adjustmentId, adjustmentId,
    specialist?.id ?? null, specialist?.id ?? null, specialist?.version ?? null, entryId))
  try { await unit.commit() } catch (error) {
    await currentAuthority(db, actor)
    const replayContext = await loadFinanceContext(db, command.keyring)
    const replay = await inspectIdempotency(db, replayContext, idem)
    if (replay) return replay
    const row = await db.prepare('SELECT version FROM finance_entries WHERE id=?').bind(entryId).first()
    if (row && row.version !== version - 1) fail('VERSION_CONFLICT')
    throw error
  }
  return response
}

export async function createFinanceEntry(input) {
  const command = await capture(input, false)
  const body = validateFinanceEntryInput(command.body)
  // Activity charges have their own participant/group authority; ordinary entry
  // creation may not manufacture a disconnected TUS/English receivable.
  if (body.source !== null || !['income', 'expense'].includes(body.recordType)
    || !body.accountingMonth || body.accountingMonth < '2000-06'
    || body.accountingMonth > partsInWarsaw(command.nowMs).month) invalid()
  const { db, keyring, actor, now } = command
  const context = await createFinanceContext(db, keyring, command.idFactory, now)
  const idem = await idemFor(command, 'finance.entry.create', body)
  const replay = await inspectIdempotency(db, context, idem)
  if (replay) return replay
  const specialist = body.specialistId ? await db.prepare("SELECT id,version FROM specialists WHERE id=? AND status='active'")
    .bind(body.specialistId).first() : null
  if (body.specialistId && !specialist) fail('NOT_FOUND')
  const entryId = identifier(command, 'fin')
  const details = await seal(context, entryId, 'details', {
    schema: 'finance_entry_details.v1', counterparty: body.counterparty,
    sourceLabel: body.sourceLabel, invoiceNote: body.invoiceNote, lessonCount: body.lessonCount,
  })
  const statement = db.prepare(`INSERT INTO finance_entries
    (id,batch_id,source_key,kind,record_type,accounting_month,occurred_on,
     amount_grosze,paid_amount_grosze,payment_method,settlement_status,invoice_status,
     specialist_id,appointment_id,counterparty_lookup,details_envelope,source_row_envelope,
     version,created_by_staff_id,created_at,updated_at)
    VALUES (?,NULL,NULL,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,NULL,1,?,?,?)`).bind(
    entryId, body.kind, body.recordType, body.accountingMonth, body.occurredOn,
    body.amountGrosze, body.paidAmountGrosze, body.paymentMethod, body.settlementStatus,
    body.invoiceStatus, body.specialistId, details, actor.id, now, now)
  return commit(command, context, idem, entryId, 1, [statement], 'finance.entry.created', null, specialist)
}

export async function adjustFinanceEntry(input) {
  const command = await capture(input, true)
  const body = exact(command.body, ['expectedVersion', 'reason', 'accountingMonth',
    'paidAmountGrosze', 'paymentMethod', 'settlementStatus', 'invoiceStatus'])
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
    || typeof body.reason !== 'string' || body.reason !== body.reason.trim()
    || body.reason.length < 3 || body.reason.length > 500
    || /[\u0000-\u001f\u007f]/.test(body.reason)) invalid()
  const { db, keyring, entryId, now } = command
  const context = await loadFinanceContext(db, keyring)
  const idem = await idemFor(command, 'finance.entry.adjust', body)
  const replay = await inspectIdempotency(db, context, idem)
  if (replay) return replay
  const row = await db.prepare(`SELECT entry.* FROM finance_entries AS entry
    LEFT JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
    WHERE entry.id=? AND (entry.batch_id IS NULL OR batch.status='committed')
      AND NOT EXISTS (SELECT 1 FROM finance_entry_voids WHERE finance_entry_id=entry.id)
      AND NOT EXISTS (SELECT 1 FROM finance_manual_voids WHERE finance_entry_id=entry.id)`)
    .bind(entryId).first()
  if (!row) fail('NOT_FOUND')
  if (row.version !== body.expectedVersion) fail('VERSION_CONFLICT')
  if (row.appointment_id !== null) fail('FINANCE_ENTRY_DEPENDENCY_CONFLICT')
  validateFinanceEntryInput({ kind: row.kind, recordType: row.record_type,
    accountingMonth: body.accountingMonth, occurredOn: row.occurred_on,
    amountGrosze: row.amount_grosze, paidAmountGrosze: body.paidAmountGrosze,
    paymentMethod: body.paymentMethod, settlementStatus: body.settlementStatus,
    invoiceStatus: body.invoiceStatus, specialistId: row.specialist_id,
    counterparty: '', sourceLabel: 'Adjustment', invoiceNote: '',
    lessonCount: row.record_type === 'english' ? 0 : null, source: null })
  // Month allocation is for otherwise unassigned expenses, not changing an
  // imported visit/activity's chronology behind its linked operational record.
  if (body.accountingMonth !== row.accounting_month && row.kind !== 'expense') fail('FINANCE_ENTRY_DEPENDENCY_CONFLICT')
  if (body.accountingMonth !== row.accounting_month && body.accountingMonth !== null
    && (body.accountingMonth < '2000-06' || body.accountingMonth > partsInWarsaw(command.nowMs).month)) invalid()
  const before = { accountingMonth: row.accounting_month, paidAmountGrosze: row.paid_amount_grosze,
    paymentMethod: row.payment_method, settlementStatus: row.settlement_status, invoiceStatus: row.invoice_status }
  const after = Object.fromEntries(Object.keys(before).map((key) => [key, body[key]]))
  const adjustmentId = identifier(command, 'fadj')
  const [reason, beforeEnvelope, afterEnvelope] = await Promise.all([
    seal(context, adjustmentId, 'reason', body.reason),
    seal(context, adjustmentId, 'before', before), seal(context, adjustmentId, 'after', after),
  ])
  return commit(command, context, idem, entryId, row.version + 1, [
    db.prepare(`UPDATE finance_entries SET accounting_month=?,paid_amount_grosze=?,
      payment_method=?,settlement_status=?,invoice_status=?,version=version+1,updated_at=?
      WHERE id=? AND version=?
        AND NOT EXISTS (SELECT 1 FROM finance_entry_voids WHERE finance_entry_id=?)
        AND NOT EXISTS (SELECT 1 FROM finance_manual_voids WHERE finance_entry_id=?)`)
      .bind(body.accountingMonth, body.paidAmountGrosze, body.paymentMethod,
        body.settlementStatus, body.invoiceStatus, now, entryId, row.version, entryId, entryId),
    db.prepare(`INSERT INTO finance_adjustments
      (id,finance_entry_id,reason_envelope,before_envelope,after_envelope,recorded_by_staff_id,created_at)
      SELECT ?,?,?,?,?,?,? WHERE changes()=1`).bind(adjustmentId, entryId, reason, beforeEnvelope,
      afterEnvelope, command.actor.id, now),
  ], 'finance.entry.adjusted', adjustmentId)
}

export async function loadFinanceEntry(input) {
  const { db, keyring, nowMs, entryId, actor: suppliedActor } = exact(input,
    ['db', 'keyring', 'nowMs', 'entryId', 'actor'])
  const actor = captureAuthorityActor(suppliedActor)
  if (!actor || !authorize(actor, 'finance.centre.manage', CENTRE, { nowMs })) fail('NOT_FOUND')
  if (!/^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(entryId ?? '')) invalid()
  await currentAuthority(db, actor)
  const row = await db.prepare(`SELECT entry.* FROM finance_entries AS entry
    LEFT JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
    WHERE entry.id=? AND (entry.batch_id IS NULL OR batch.status='committed')
      AND NOT EXISTS (SELECT 1 FROM finance_entry_voids WHERE finance_entry_id=entry.id)
      AND NOT EXISTS (SELECT 1 FROM finance_manual_voids WHERE finance_entry_id=entry.id)`)
    .bind(entryId).first()
  if (!row) fail('NOT_FOUND')
  const context = await loadFinanceContext(db, keyring)
  const open = async (recordId, field, serialized) => JSON.parse(await decryptForScope(
    keyring, context.dataKey, { expectedScope: FINANCE_SCOPE, recordId, field,
      envelope: JSON.parse(serialized) }))
  const details = await open(entryId, 'details', row.details_envelope)
  const history = (await db.prepare(`SELECT * FROM finance_adjustments
    WHERE finance_entry_id=? AND workbook_import_id IS NULL
    ORDER BY created_at DESC,id DESC LIMIT 51`).bind(entryId).all()).results
  const adjustments = await Promise.all(history.slice(0, 50).map(async (adjustment) => ({
    id: adjustment.id, createdAt: adjustment.created_at,
    reason: await open(adjustment.id, 'reason', adjustment.reason_envelope),
    before: await open(adjustment.id, 'before', adjustment.before_envelope),
    after: await open(adjustment.id, 'after', adjustment.after_envelope),
  })))
  await currentAuthority(db, actor)
  const current = await db.prepare(`SELECT version FROM finance_entries WHERE id=?
    AND NOT EXISTS (SELECT 1 FROM finance_entry_voids WHERE finance_entry_id=?)
    AND NOT EXISTS (SELECT 1 FROM finance_manual_voids WHERE finance_entry_id=?)`)
    .bind(entryId, entryId, entryId).first()
  if (!current || current.version !== row.version) fail('VERSION_CONFLICT')
  return { status: 200, body: { data: { entry: {
    id: row.id, version: row.version, kind: row.kind, recordType: row.record_type,
    accountingMonth: row.accounting_month, occurredOn: row.occurred_on,
    amountGrosze: row.amount_grosze, paidAmountGrosze: row.paid_amount_grosze,
    paymentMethod: row.payment_method, settlementStatus: row.settlement_status,
    invoiceStatus: row.invoice_status, appointmentId: row.appointment_id,
    counterparty: details.counterparty, sourceLabel: details.sourceLabel,
  }, adjustments, historyTruncated: history.length > 50 } } }
}
