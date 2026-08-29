import { createFinanceReadModel } from '../../src/finance-reporting.js'
import { auditEventStatement } from '../audit/events.js'
import { FINANCE_SCOPE } from './finance.js'
import { createUnitOfWork } from '../db/unit-of-work.js'
import { authorize } from '../identity/policy.js'
import { resolveCurrentAuthorityActor } from '../identity/staff.js'
import { partsInWarsaw } from '../operations/clock.js'
import { encryptForScope } from '../security/envelope.js'
import { encodeBase64Url } from '../security/encoding.js'
import { loadWorkbookSpecialistLabels } from './workbook-specialist-options.js'

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const supportedMonth = (value) => typeof value === 'string' && MONTH.test(value)
  && Number(value.slice(0, 4)) >= 2000
const CENTRE = Object.freeze({ kind: 'centre', centreId: 'centre_1' })
const RESULT_CAP = 1_000
const QUERY_ID_CHUNK = 80
const ENTRY_ID = /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const APPOINTMENT_ID = /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/

const fail = (code) => { throw new Error(code) }
const invalidSelectedMonth = () => fail('VALIDATION_FAILED/selectedMonth')
const invalidFinanceVoid = () => fail('VALIDATION_FAILED/financeVoid')

const requireCurrentAuthority = async (db, actor) => {
  let current
  try {
    current = await resolveCurrentAuthorityActor(db, {
      id: actor.id,
      role: actor.role,
      specialist_id: actor.specialistId,
      version: actor.version,
    })
  } catch { fail('NOT_FOUND') }
  if (current.authorityRevision !== actor.authorityRevision
    || current.capabilities.length !== actor.capabilities.length
    || current.capabilities.some((capability, index) => (
      capability !== actor.capabilities[index]
    ))) fail('NOT_FOUND')
}

const shiftMonth = (month, delta) => {
  const year = Number(month.slice(0, 4))
  const value = Number(month.slice(5, 7)) - 1
  const absolute = (year * 12) + value + delta
  const shiftedYear = Math.floor(absolute / 12)
  const shiftedMonth = ((absolute % 12) + 12) % 12
  return `${String(shiftedYear).padStart(4, '0')}-${String(shiftedMonth + 1).padStart(2, '0')}`
}

const monthWindow = (selectedMonth) => Object.freeze(
  Array.from({ length: 6 }, (_, index) => shiftMonth(selectedMonth, index - 5)),
)

const rows = async (statement, field) => {
  const result = (await statement.all())?.results
  if (!Array.isArray(result)) fail('INTERNAL_ERROR')
  if (result.length > RESULT_CAP) fail('FINANCE_WINDOW_LIMIT')
  return result
}

const localMonth = (instant) => {
  const value = Date.parse(instant)
  if (!Number.isSafeInteger(value)) fail('INTERNAL_ERROR')
  return partsInWarsaw(value).month
}

const dateBounds = (months) => {
  const from = Date.parse(`${months[0]}-01T00:00:00.000Z`) - (2 * 86_400_000)
  const to = Date.parse(`${shiftMonth(months.at(-1), 1)}-01T00:00:00.000Z`)
    + (2 * 86_400_000)
  return Object.freeze({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })
}

export async function syntheticPanelLedgerId(appointmentId) {
  if (typeof appointmentId !== 'string' || !APPOINTMENT_ID.test(appointmentId)) {
    fail('INTERNAL_ERROR')
  }
  const source = new TextEncoder().encode(`bwm:finance:panel-ledger:v1\n${appointmentId}`)
  let hash
  try {
    hash = new Uint8Array(await crypto.subtle.digest('SHA-256', source))
    return `fin_panel_${encodeBase64Url(hash)}`
  } finally {
    source.fill(0)
    hash?.fill(0)
  }
}

const queryImported = (db, fromMonth, toMonth) => rows(db.prepare(
   `SELECT entry.id,entry.accounting_month,entry.occurred_on,entry.kind,
          entry.record_type,entry.amount_grosze,entry.specialist_id,
          entry.appointment_id,entry.invoice_status,entry.version,
          classification.service_id,
          (SELECT source.period_precision
           FROM finance_source_links AS source_link
           JOIN workbook_source_records AS source ON source.id=source_link.source_record_id
           WHERE source_link.finance_entry_id=entry.id LIMIT 1) AS source_period_precision
   FROM finance_entries AS entry
   JOIN finance_reporting_classifications AS classification
     ON classification.finance_entry_id=entry.id
   LEFT JOIN finance_entry_voids AS workbook_void
     ON workbook_void.finance_entry_id=entry.id
   LEFT JOIN finance_manual_voids AS manual_void
     ON manual_void.finance_entry_id=entry.id
   LEFT JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
   WHERE workbook_void.id IS NULL AND manual_void.id IS NULL
     AND (entry.batch_id IS NULL OR batch.status='committed')
     AND (entry.accounting_month BETWEEN ? AND ? OR entry.accounting_month IS NULL)
   ORDER BY entry.accounting_month,entry.id LIMIT ?`,
).bind(fromMonth, toMonth, RESULT_CAP + 1), 'ledgerEntries')

const queryAppointments = (db, bounds) => rows(db.prepare(
  `SELECT appointment.id,appointment.specialist_id,appointment.service_id,
          appointment.starts_at,appointment.version,charge.expected_amount_grosze,
          charge.version AS charge_version
   FROM appointments AS appointment
   JOIN session_charges AS charge ON charge.appointment_id=appointment.id
   WHERE appointment.status IN ('completed','noshow')
     AND appointment.starts_at>=? AND appointment.starts_at<?
     -- Any historical claim is a permanent Panel-synthesis tombstone. Releasing a
     -- claim permits a replacement imported authority; it must not resurrect the
     -- appointment money after an explicit workbook/manual void.
     AND NOT EXISTS (
       SELECT 1 FROM finance_appointment_authority_claims AS claim
       WHERE claim.appointment_id=appointment.id
     )
   ORDER BY appointment.starts_at,appointment.id LIMIT ?`,
).bind(bounds.from, bounds.to, RESULT_CAP + 1), 'appointments')

const placeholders = (values) => values.map(() => '?').join(',')

export function chunkFinanceAuthorityIds(values) {
  if (!Array.isArray(values) || values.length > RESULT_CAP
    || values.some((value) => typeof value !== 'string' || value.length < 1)
    || new Set(values).size !== values.length) {
    if (Array.isArray(values) && values.length > RESULT_CAP) fail('FINANCE_WINDOW_LIMIT')
    fail('INTERNAL_ERROR')
  }
  return Object.freeze(Array.from(
    { length: Math.ceil(values.length / QUERY_ID_CHUNK) },
    (_, index) => Object.freeze(values.slice(
      index * QUERY_ID_CHUNK, (index + 1) * QUERY_ID_CHUNK,
    )),
  ))
}

const queryPayments = async (db, appointmentIds) => {
  if (appointmentIds.length === 0) return []
  const result = []
  for (const ids of chunkFinanceAuthorityIds(appointmentIds)) {
    const chunk = await rows(db.prepare(
      `SELECT payment.id,payment.appointment_id,payment.amount_grosze,payment.method
       FROM payment_entries AS payment
       LEFT JOIN payment_corrections AS correction
         ON correction.reversed_entry_id=payment.id
       WHERE payment.appointment_id IN (${placeholders(ids)})
         AND correction.id IS NULL
       ORDER BY payment.received_at,payment.id LIMIT ?`,
    ).bind(...ids, RESULT_CAP - result.length + 1), 'paymentEvents')
    result.push(...chunk)
    if (result.length > RESULT_CAP) fail('FINANCE_WINDOW_LIMIT')
  }
  return result
}

const queryCollections = async (db, financeIds) => {
  if (financeIds.length === 0) return []
  const result = []
  for (const ids of chunkFinanceAuthorityIds(financeIds)) {
    const chunk = await rows(db.prepare(
      `SELECT event.id,event.finance_entry_id,event.amount_grosze,event.method
       FROM finance_collection_events AS event
       JOIN finance_entries AS entry ON entry.id=event.finance_entry_id
         AND entry.version=event.entry_version
       WHERE event.finance_entry_id IN (${placeholders(ids)})
         AND event.amount_grosze>0
       ORDER BY event.id LIMIT ?`,
    ).bind(...ids, RESULT_CAP - result.length + 1), 'paymentEvents')
    result.push(...chunk)
    if (result.length > RESULT_CAP) fail('FINANCE_WINDOW_LIMIT')
  }
  return result
}

const queryHistoricalLinks = (db, fromMonth, toMonth) => rows(db.prepare(
  `SELECT occurrence.id,link.finance_entry_id,occurrence.period_precision
   FROM historical_service_occurrences AS occurrence
   JOIN finance_source_links AS link ON link.source_record_id=occurrence.source_record_id
   JOIN finance_entries AS entry ON entry.id=link.finance_entry_id
   LEFT JOIN finance_entry_voids AS workbook_void
     ON workbook_void.finance_entry_id=entry.id
   LEFT JOIN finance_manual_voids AS manual_void
     ON manual_void.finance_entry_id=entry.id
   WHERE occurrence.status='recorded' AND workbook_void.id IS NULL AND manual_void.id IS NULL
     AND (entry.accounting_month BETWEEN ? AND ? OR entry.accounting_month IS NULL)
   ORDER BY occurrence.id LIMIT ?`,
).bind(fromMonth, toMonth, RESULT_CAP + 1), 'occurrenceLinks')

const queryActivityLinks = (db, fromMonth, toMonth) => rows(db.prepare(
  `SELECT charge.id,charge.finance_entry_id,program.code,charge.lesson_count
   FROM activity_charges AS charge
   JOIN activity_programs AS program ON program.id=charge.program_id
   JOIN finance_entries AS entry ON entry.id=charge.finance_entry_id
   LEFT JOIN finance_entry_voids AS workbook_void
     ON workbook_void.finance_entry_id=entry.id
   LEFT JOIN finance_manual_voids AS manual_void
     ON manual_void.finance_entry_id=entry.id
   WHERE charge.status='active' AND workbook_void.id IS NULL AND manual_void.id IS NULL
     AND entry.accounting_month BETWEEN ? AND ?
   ORDER BY charge.id LIMIT ?`,
).bind(fromMonth, toMonth, RESULT_CAP + 1), 'activityLinks')

const queryLatestImported = async (db, currentMonth) => {
  const row = await db.prepare(
    `SELECT entry.accounting_month
     FROM finance_entries AS entry
     LEFT JOIN finance_entry_voids AS workbook_void
       ON workbook_void.finance_entry_id=entry.id
     LEFT JOIN finance_manual_voids AS manual_void
       ON manual_void.finance_entry_id=entry.id
     LEFT JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
     WHERE workbook_void.id IS NULL AND manual_void.id IS NULL
       AND (entry.batch_id IS NULL OR batch.status='committed')
       AND entry.accounting_month>='2000-06' AND entry.accounting_month<=?
     ORDER BY entry.accounting_month DESC,entry.id DESC LIMIT 1`,
  ).bind(currentMonth).first()
  return row?.accounting_month ?? null
}

const queryLatestAppointment = async (db, nowMs, currentMonth) => {
  const row = await db.prepare(
    `SELECT appointment.starts_at
     FROM appointments AS appointment
     JOIN session_charges AS charge ON charge.appointment_id=appointment.id
     WHERE appointment.status IN ('completed','noshow') AND appointment.starts_at<=?
       -- Keep released claims in this tombstone check for the same reason as the
       -- bounded appointment query above.
       AND NOT EXISTS (
         SELECT 1 FROM finance_appointment_authority_claims AS claim
         WHERE claim.appointment_id=appointment.id
       )
     ORDER BY appointment.starts_at DESC,appointment.id DESC LIMIT 1`,
  ).bind(new Date(nowMs).toISOString()).first()
  if (!row) return null
  const month = localMonth(row.starts_at)
  return month >= '2000-06' && month <= currentMonth ? month : null
}

const rowDto = (entry) => Object.freeze({
  id: entry.id,
  sourceKind: entry.sourceKind,
  appointmentId: entry.appointmentId,
  accountingMonth: entry.accountingMonth,
  occurredOn: entry.occurredOn,
  kind: entry.kind,
  recordType: entry.recordType,
  revenueGrosze: entry.revenueGrosze,
  receivableGrosze: entry.receivableGrosze,
  collectedGrosze: entry.collectedGrosze,
  expenseGrosze: entry.expenseGrosze,
  specialistId: entry.specialistId,
  serviceId: entry.serviceId,
  program: entry.program,
  paymentMethod: entry.paymentMethod,
  invoiceStatus: entry.invoiceStatus,
  version: entry.version,
})

const reportingRevision = async (db) => {
  const revision = await db.prepare(
    "SELECT revision FROM finance_reporting_state WHERE authority_key='finance'",
  ).first('revision')
  if (!Number.isSafeInteger(revision) || revision < 1) fail('INTERNAL_ERROR')
  return revision
}

export async function loadFinanceWindow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== 5
    || !['db', 'actor', 'keyring', 'nowMs', 'selectedMonth']
      .every((key) => Object.hasOwn(input, key))
    || !input.db?.prepare || !input.keyring
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    fail('INTERNAL_ERROR')
  }
  if (!authorize(input.actor, 'finance.centre.read', CENTRE, { nowMs: input.nowMs })) {
    fail('NOT_FOUND')
  }
  const currentMonth = partsInWarsaw(input.nowMs).month
  if (!supportedMonth(input.selectedMonth)
    || input.selectedMonth < '2000-06'
    || input.selectedMonth > currentMonth) invalidSelectedMonth()
  const months = monthWindow(input.selectedMonth)
  const bounds = dateBounds(months)
  const initialRevision = await reportingRevision(input.db)
  const [importedRows, appointmentRows, historicalRows, activityRows] = await Promise.all([
    queryImported(input.db, months[0], input.selectedMonth),
    queryAppointments(input.db, bounds),
    queryHistoricalLinks(input.db, months[0], input.selectedMonth),
    queryActivityLinks(input.db, months[0], input.selectedMonth),
  ])
  if (importedRows.length + appointmentRows.length > RESULT_CAP) fail('FINANCE_WINDOW_LIMIT')

  const appointments = appointmentRows.filter((row) => months.includes(localMonth(row.starts_at)))
  const appointmentIds = [...new Set([
    ...appointments.map(({ id }) => id),
    ...importedRows.map(({ appointment_id }) => appointment_id).filter(Boolean),
  ])]
  const [paymentRows, collectionRows] = await Promise.all([
    queryPayments(input.db, appointmentIds),
    queryCollections(input.db, importedRows
      .filter(({ kind }) => kind === 'income').map(({ id }) => id)),
  ])
  const paymentByAppointment = new Map()
  for (const row of paymentRows) {
    const values = paymentByAppointment.get(row.appointment_id) ?? []
    values.push(row)
    paymentByAppointment.set(row.appointment_id, values)
  }
  const collectionByFinance = new Map(collectionRows.map((row) => [row.finance_entry_id, row]))
  const imported = importedRows.map((row) => {
    const effective = row.appointment_id
      ? paymentByAppointment.get(row.appointment_id) ?? []
      : collectionByFinance.has(row.id) ? [collectionByFinance.get(row.id)] : []
    const collectedGrosze = effective.reduce((total, value) => total + value.amount_grosze, 0)
    return Object.freeze({
      id: row.id,
      state: 'active',
      sourceKind: 'workbook',
      appointmentId: row.appointment_id,
      accountingMonth: row.accounting_month,
      occurredOn: row.occurred_on,
      kind: row.kind,
      recordType: row.record_type,
      revenueGrosze: row.kind === 'income' ? row.amount_grosze : 0,
      receivableGrosze: row.kind === 'income' ? row.amount_grosze : 0,
      collectedGrosze,
      expenseGrosze: row.kind === 'expense' ? row.amount_grosze : 0,
      specialistId: row.specialist_id,
      serviceId: row.service_id,
      program: ['english', 'tus'].includes(row.record_type) ? row.record_type : null,
      paymentMethod: 'unknown',
      invoiceStatus: row.invoice_status,
      version: row.version,
    })
  })
  const panelIds = await Promise.all(appointments.map(({ id }) => syntheticPanelLedgerId(id)))
  const panel = appointments.map((row, index) => {
    const effective = paymentByAppointment.get(row.id) ?? []
    const collectedGrosze = effective.reduce((total, value) => total + value.amount_grosze, 0)
    return Object.freeze({
      id: panelIds[index],
      state: 'active',
      sourceKind: 'panel',
      appointmentId: row.id,
      accountingMonth: localMonth(row.starts_at),
      occurredOn: partsInWarsaw(Date.parse(row.starts_at)).day,
      kind: 'income',
      recordType: 'income',
      revenueGrosze: row.expected_amount_grosze,
      receivableGrosze: row.expected_amount_grosze,
      collectedGrosze,
      expenseGrosze: 0,
      specialistId: row.specialist_id,
      serviceId: row.service_id,
      program: null,
      paymentMethod: 'unknown',
      invoiceStatus: 'not_required',
      version: Math.max(row.version, row.charge_version),
    })
  })
  const ledgerEntries = [...imported, ...panel]
  const ledgerIdByAppointment = new Map(ledgerEntries
    .filter(({ appointmentId }) => appointmentId !== null)
    .map(({ id, appointmentId }) => [appointmentId, id]))
  const paymentEvents = paymentRows.map((row) => Object.freeze({
    id: row.id,
    ledgerId: ledgerIdByAppointment.get(row.appointment_id),
    amountGrosze: row.amount_grosze,
    method: row.method,
  })).filter(({ ledgerId }) => ledgerId !== undefined)
  for (const row of collectionRows) paymentEvents.push(Object.freeze({
    id: row.id,
    ledgerId: row.finance_entry_id,
    amountGrosze: row.amount_grosze,
    method: row.method,
  }))
  if (paymentEvents.length > RESULT_CAP) fail('FINANCE_WINDOW_LIMIT')
  const visibleIds = new Set(ledgerEntries.map(({ id }) => id))
  const occurrenceLinks = [
    ...panel.map((entry) => Object.freeze({
      id: `occ_${entry.appointmentId.slice(4)}`,
      ledgerId: entry.id,
      periodPrecision: 'day',
      hasTime: true,
    })),
    ...historicalRows.filter((row) => visibleIds.has(row.finance_entry_id)).map((row) => (
      Object.freeze({
        id: row.id,
        ledgerId: row.finance_entry_id,
        periodPrecision: row.period_precision,
        hasTime: false,
      })
    )),
  ]
  const activityLinks = activityRows.filter((row) => visibleIds.has(row.finance_entry_id))
    .map((row) => Object.freeze({
      id: row.id,
      ledgerId: row.finance_entry_id,
      program: row.code,
      count: row.lesson_count ?? 0,
    }))
  const model = createFinanceReadModel({
    ledgerEntries,
    paymentEvents,
    occurrenceLinks,
    activityLinks,
    selectedMonth: input.selectedMonth,
    trendMonths: months,
    specialistId: null,
  })
  const [latestImported, latestAppointment] = await Promise.all([
    queryLatestImported(input.db, currentMonth),
    queryLatestAppointment(input.db, input.nowMs, currentMonth),
  ])
  const latestPopulatedMonth = [latestImported, latestAppointment]
    .filter(Boolean).sort().at(-1) ?? null
  const coverage = { dateOnlyCount: 0, monthOnlyCount: 0, timedCount: 0, unknownCount: 0 }
  const sourcePrecisionById = new Map(importedRows.map((row) => [
    row.id, row.source_period_precision,
  ]))
  for (const entry of model.rows) {
    if (entry.sourceKind === 'panel') coverage.timedCount += 1
    else if (sourcePrecisionById.get(entry.id) === 'unknown') coverage.unknownCount += 1
    else if (sourcePrecisionById.get(entry.id) === 'day' || entry.occurredOn !== null) {
      coverage.dateOnlyCount += 1
    } else if (sourcePrecisionById.get(entry.id) === 'month'
      || entry.accountingMonth !== null) coverage.monthOnlyCount += 1
    else coverage.unknownCount += 1
  }
  const specialistLabels = await loadWorkbookSpecialistLabels({
    db: input.db, keyring: input.keyring,
    ids: model.rows.map(({ specialistId }) => specialistId).filter(Boolean),
  })
  if (await reportingRevision(input.db) !== initialRevision) fail('FINANCE_WINDOW_RETRY')
  await requireCurrentAuthority(input.db, input.actor)
  return Object.freeze({ data: Object.freeze({
    currentMonth,
    selectedMonth: input.selectedMonth,
    fromMonth: months[0],
    toMonth: months.at(-1),
    months,
    latestPopulatedMonth,
    kpis: model.kpis,
    trend: model.trend,
    splits: model.splits,
    specialistLabels,
    rows: Object.freeze(model.rows.map(rowDto)),
    coverage: Object.freeze(coverage),
    unknownPeriodCount: model.unknownPeriod.length,
    complete: true,
  }) })
}

const digest = async (value) => {
  const bytes = new TextEncoder().encode(value)
  let hash
  try {
    hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return encodeBase64Url(hash)
  } finally {
    bytes.fill(0)
    hash?.fill(0)
  }
}

const replayFor = (db, actorId, operation, key) => db.prepare(
  `SELECT request_hash,entity_id,response_version
   FROM finance_reporting_request_replays
   WHERE actor_staff_id=? AND operation=? AND idempotency_key=?`,
).bind(actorId, operation, key).first()

const voidResponse = (entryId, version) => Object.freeze({
  status: 200,
  body: Object.freeze({ data: Object.freeze({ entryId, state: 'void', version }) }),
})

const loadFinanceDataKey = async (db) => {
  const row = await db.prepare(
    `SELECT id,scope_type,scope_id,purpose,dek_version,wrapped_key_b64,
            wrap_nonce_b64,kek_version,created_at,retired_at
     FROM data_keys
     WHERE scope_type=? AND scope_id=? AND purpose=? AND dek_version=1`,
  ).bind(FINANCE_SCOPE.type, FINANCE_SCOPE.id, FINANCE_SCOPE.purpose).first()
  if (!row) fail('CRYPTO_FAILURE')
  return row
}

export async function voidFinanceEntry(input) {
  const keys = [
    'db', 'actor', 'keyring', 'nowMs', 'correlationId', 'idFactory', 'entryId',
    'expectedVersion', 'reason', 'idempotencyKey',
  ]
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length
    || !keys.every((key) => Object.hasOwn(input, key))
    || !input.db?.prepare || !input.db?.batch || !input.keyring
    || typeof input.idFactory !== 'function'
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0
    || typeof input.correlationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.correlationId)
    || typeof input.entryId !== 'string' || !ENTRY_ID.test(input.entryId)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
    || typeof input.reason !== 'string' || input.reason !== input.reason.trim()
    || input.reason !== input.reason.normalize('NFC')
    || input.reason.length < 3 || input.reason.length > 500
    || /[\p{Cc}\p{Cf}]/u.test(input.reason)
    || typeof input.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) invalidFinanceVoid()
  if (!authorize(input.actor, 'finance.centre.manage', CENTRE, { nowMs: input.nowMs })) {
    fail('NOT_FOUND')
  }
  const requestHash = await digest(JSON.stringify([
    input.entryId, input.expectedVersion, input.reason,
  ]))
  const existing = await replayFor(
    input.db, input.actor.id, 'finance.entry.void', input.idempotencyKey,
  )
  if (existing) {
    if (existing.request_hash !== requestHash || existing.entity_id !== input.entryId
      || !Number.isSafeInteger(existing.response_version)) fail('IDEMPOTENCY_CONFLICT')
    await requireCurrentAuthority(input.db, input.actor)
    return voidResponse(existing.entity_id, existing.response_version)
  }
  const entry = await input.db.prepare(
    `SELECT entry.id,entry.version,workbook_void.id AS workbook_void_id,
            manual_void.id AS manual_void_id,entry.batch_id,batch.status AS batch_status
     FROM finance_entries AS entry
     LEFT JOIN finance_entry_voids AS workbook_void ON workbook_void.finance_entry_id=entry.id
     LEFT JOIN finance_manual_voids AS manual_void ON manual_void.finance_entry_id=entry.id
     LEFT JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
     WHERE entry.id=?`,
  ).bind(input.entryId).first()
  if (!entry) fail('NOT_FOUND')
  if (entry.workbook_void_id || entry.manual_void_id) fail('FINANCE_ENTRY_VOIDED')
  if (entry.version !== input.expectedVersion) fail('VERSION_CONFLICT')
  if (entry.batch_id !== null && entry.batch_status !== 'committed') {
    fail('FINANCE_ENTRY_NOT_READY')
  }
  const historicalDependencies = await rows(input.db.prepare(
    `SELECT occurrence.id,occurrence.version
     FROM finance_source_links AS link
     JOIN historical_service_occurrences AS occurrence
       ON occurrence.source_record_id=link.source_record_id
     WHERE link.finance_entry_id=? AND occurrence.status='recorded'
     ORDER BY occurrence.id LIMIT 2`,
  ).bind(input.entryId), 'historicalDependencies')
  const activityDependencies = await rows(input.db.prepare(
    `SELECT charge.id,charge.version FROM activity_charges AS charge
     WHERE charge.finance_entry_id=? AND charge.status='active'
     ORDER BY charge.id LIMIT 2`,
  ).bind(input.entryId), 'activityDependencies')
  if (historicalDependencies.length > 1 || activityDependencies.length > 1) {
    fail('FINANCE_ENTRY_DEPENDENCY_CONFLICT')
  }
  let voidId
  let auditId
  try {
    voidId = `fmv_${input.idFactory()}`
    auditId = `aud_${input.idFactory()}`
  } catch { fail('INTERNAL_ERROR') }
  if (!/^fmv_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(voidId)
    || !/^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(auditId)) fail('INTERNAL_ERROR')
  const createdAt = new Date(input.nowMs).toISOString()
  const dataKey = await loadFinanceDataKey(input.db)
  const reasonEnvelope = JSON.stringify(await encryptForScope(input.keyring, dataKey, {
    expectedScope: FINANCE_SCOPE,
    recordId: voidId,
    field: 'reason',
    plaintext: input.reason,
  }))
  const metadata = { entryVersion: input.expectedVersion }
  const unit = createUnitOfWork(input.db, {
    mode: 'mutation', actorId: input.actor.id, correlationId: input.correlationId,
  })
  for (const dependency of historicalDependencies) unit.domain(input.db.prepare(
    `UPDATE historical_service_occurrences
     SET status='voided',version=version+1,updated_at=?
     WHERE id=? AND status='recorded' AND version=?`,
  ).bind(createdAt, dependency.id, dependency.version))
  for (const dependency of activityDependencies) unit.domain(input.db.prepare(
    `UPDATE activity_charges SET status='inactive',version=version+1,updated_at=?
     WHERE id=? AND status='active' AND version=?`,
  ).bind(createdAt, dependency.id, dependency.version))
  unit.domain(input.db.prepare(
    `INSERT INTO finance_manual_voids
     (id,finance_entry_id,expected_entry_version,reason_envelope,
      voided_by_staff_id,created_at) VALUES (?,?,?,?,?,?)`,
  ).bind(
    voidId, input.entryId, input.expectedVersion, reasonEnvelope, input.actor.id, createdAt,
  ))
  unit.idempotency(input.db.prepare(
    `INSERT INTO finance_reporting_request_replays
     (actor_staff_id,operation,idempotency_key,request_hash,entity_id,
      response_version,created_at) VALUES (?,'finance.entry.void',?,?,?,?,?)`,
  ).bind(
    input.actor.id, input.idempotencyKey, requestHash, input.entryId,
    input.expectedVersion, createdAt,
  ))
  unit.audit(auditEventStatement(input.db, {
    id: auditId, occurredAt: createdAt, actorStaffId: input.actor.id,
    action: 'finance.entry.voided', entityType: 'finance_entry', entityId: input.entryId,
    result: 'success', correlationId: input.correlationId, metadata, reasonEnvelope: null,
  }))
  unit.guard(input.db.prepare(
    `INSERT INTO core_directory_invariant_failures (failure_kind)
     SELECT 'finance_manual_void_postcondition' WHERE NOT (
       EXISTS (SELECT 1 FROM finance_manual_voids WHERE id=? AND finance_entry_id=?)
       AND EXISTS (SELECT 1 FROM finance_reporting_request_replays
         WHERE actor_staff_id=? AND operation='finance.entry.void' AND idempotency_key=?
           AND request_hash=? AND entity_id=? AND response_version=?)
       AND EXISTS (SELECT 1 FROM audit_events WHERE id=?
         AND action='finance.entry.voided' AND entity_id=? AND actor_staff_id=?
         AND correlation_id=? AND metadata_json=?)
       AND EXISTS (SELECT 1 FROM finance_entries AS entry
         LEFT JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
         WHERE entry.id=? AND entry.version=?
           AND (entry.batch_id IS NULL OR batch.status='committed'))
       AND NOT EXISTS (SELECT 1 FROM finance_source_links AS link
         JOIN historical_service_occurrences AS occurrence
           ON occurrence.source_record_id=link.source_record_id
         WHERE link.finance_entry_id=? AND occurrence.status='recorded')
       AND NOT EXISTS (SELECT 1 FROM activity_charges AS charge
         WHERE charge.finance_entry_id=? AND charge.status='active')
       AND EXISTS (SELECT 1 FROM staff_users AS staff
         JOIN staff_authorities AS authority ON authority.staff_id=staff.id
         WHERE staff.id=? AND staff.role=? AND staff.specialist_id IS ?
           AND staff.version=? AND staff.status='active' AND authority.revision=?))`,
  ).bind(
    voidId, input.entryId, input.actor.id, input.idempotencyKey, requestHash,
    input.entryId, input.expectedVersion, auditId, input.entryId, input.actor.id,
    input.correlationId, JSON.stringify(metadata), input.entryId, input.expectedVersion,
    input.entryId, input.entryId,
    input.actor.id, input.actor.role, input.actor.specialistId, input.actor.version,
    input.actor.authorityRevision,
  ))
  try {
    await unit.commit()
  } catch (error) {
    const replay = await replayFor(
      input.db, input.actor.id, 'finance.entry.void', input.idempotencyKey,
    )
    if (replay) {
      if (replay.request_hash !== requestHash || replay.entity_id !== input.entryId) {
        fail('IDEMPOTENCY_CONFLICT')
      }
      await requireCurrentAuthority(input.db, input.actor)
      return voidResponse(replay.entity_id, replay.response_version)
    }
    const raced = await input.db.prepare(
      `SELECT entry.version,workbook_void.id AS workbook_void_id,
              manual_void.id AS manual_void_id,staff.id AS actor_id,
              authority.revision AS authority_revision,entry.batch_id,
              batch.status AS batch_status
       FROM finance_entries AS entry
       LEFT JOIN finance_entry_voids AS workbook_void ON workbook_void.finance_entry_id=entry.id
       LEFT JOIN finance_manual_voids AS manual_void ON manual_void.finance_entry_id=entry.id
       LEFT JOIN staff_users AS staff ON staff.id=? AND staff.role=?
         AND staff.specialist_id IS ? AND staff.version=? AND staff.status='active'
       LEFT JOIN staff_authorities AS authority ON authority.staff_id=staff.id
       LEFT JOIN finance_import_batches AS batch ON batch.id=entry.batch_id
       WHERE entry.id=?`,
    ).bind(
      input.actor.id, input.actor.role, input.actor.specialistId, input.actor.version,
      input.entryId,
    ).first()
    if (!raced?.actor_id || raced.authority_revision !== input.actor.authorityRevision) {
      fail('NOT_FOUND')
    }
    if (raced.workbook_void_id || raced.manual_void_id) fail('FINANCE_ENTRY_VOIDED')
    if (raced.version !== input.expectedVersion) fail('VERSION_CONFLICT')
    if (raced.batch_id !== null && raced.batch_status !== 'committed') {
      fail('FINANCE_ENTRY_NOT_READY')
    }
    const activeDependency = await input.db.prepare(
      `SELECT EXISTS (
         SELECT 1 FROM finance_source_links AS link
         JOIN historical_service_occurrences AS occurrence
           ON occurrence.source_record_id=link.source_record_id
         WHERE link.finance_entry_id=? AND occurrence.status='recorded'
       ) OR EXISTS (
         SELECT 1 FROM activity_charges
         WHERE finance_entry_id=? AND status='active'
       ) AS active_dependency`,
    ).bind(input.entryId, input.entryId).first('active_dependency')
    if (activeDependency === 1) fail('FINANCE_ENTRY_DEPENDENCY_CONFLICT')
    throw error
  }
  await requireCurrentAuthority(input.db, input.actor)
  return voidResponse(input.entryId, input.expectedVersion)
}
