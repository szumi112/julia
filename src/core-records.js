// Pure Phase 2 core-record rules. This module deliberately has no UI, storage,
// or environment dependencies so route and repository code share one contract.
import { SERVICE_BY_ID } from './services.js'
import { isBillable } from './format.js'

export const WARSAW_TIME_ZONE = 'Europe/Warsaw'
export const MAX_GROSZE = 1_000_000

const encoder = new TextEncoder()
const ids = {
  opaque: /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/,
  specialist: /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/,
  client: /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/,
  assignment: /^asg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  appointment: /^apt_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  charge: /^chg_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  payment: /^pay_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  correction: /^cor_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  version: /^ver_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
  audit: /^aud_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/,
}
const utcIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const dateIso = /^(\d{4})-(\d{2})-(\d{2})$/
const timeIso = /^(\d{2}):(\d{2})$/
const clientStatuses = new Set(['active', 'paused', 'archived'])
const appointmentStatuses = new Set(['scheduled', 'completed', 'cancelled', 'noshow'])
const editableAppointmentStatuses = new Set(['scheduled', 'completed', 'noshow'])
const methods = new Set(['cash', 'card', 'transfer', 'monthly'])
const durations = new Set([50, 60, 90, 120])

const fail = (field, code = 'VALIDATION_FAILED') => {
  throw new TypeError(`${code}/${field}`)
}

const assertInteger = (value, field, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(field)
  return value
}

export const isExactObject = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export const assertExactObject = (value, keys, field = 'object') => {
  if (!isExactObject(value, keys)) fail(field)
  return value
}

export const isOpaqueId = (value) => typeof value === 'string' && ids.opaque.test(value)
export const isSpecialistId = (value) => typeof value === 'string' && ids.specialist.test(value)
export const isClientId = (value) => typeof value === 'string' && ids.client.test(value)
export const isAssignmentId = (value) => typeof value === 'string' && ids.assignment.test(value)
export const isAppointmentId = (value) => typeof value === 'string' && ids.appointment.test(value)
export const isChargeId = (value) => typeof value === 'string' && ids.charge.test(value)
export const isPaymentId = (value) => typeof value === 'string' && ids.payment.test(value)
export const isCorrectionId = (value) => typeof value === 'string' && ids.correction.test(value)
export const isVersionId = (value) => typeof value === 'string' && ids.version.test(value)
export const isAuditId = (value) => typeof value === 'string' && ids.audit.test(value)

export const assertId = (value, kind, field = `${kind}Id`) => {
  if (typeof value !== 'string' || !ids[kind]?.test(value)) fail(field)
  return value
}

export const assertNfcTrimmed = (value, { field = 'string', minBytes = 1, maxBytes }) => {
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/.test(value) || value !== value.trim() || value !== value.normalize('NFC')) fail(field)
  const bytes = encoder.encode(value).byteLength
  if (bytes < minBytes || bytes > maxBytes) fail(field)
  return value
}

export const assertClientIdentity = (value) => {
  assertExactObject(value, ['name', 'age'])
  const name = assertNfcTrimmed(value.name, { field: 'name', minBytes: 1, maxBytes: 120 })
  const age = value.age === null ? null : assertInteger(value.age, 'age', 1, 26)
  return { name, age }
}

export const assertLocation = (value) => value === null
  ? null
  : assertNfcTrimmed(value, { field: 'location', minBytes: 1, maxBytes: 80 })

export const assertCorrectionReason = (value) =>
  assertNfcTrimmed(value, { field: 'reason', minBytes: 1, maxBytes: 500 })

export const assertServiceSnapshot = (value) => {
  assertExactObject(value, ['serviceId', 'durationMinutes', 'expectedAmountGrosze'])
  if (typeof value.serviceId !== 'string' || !SERVICE_BY_ID[value.serviceId]) fail('serviceId')
  if (!durations.has(value.durationMinutes) || value.durationMinutes !== SERVICE_BY_ID[value.serviceId].duration) fail('durationMinutes')
  assertInteger(value.expectedAmountGrosze, 'expectedAmountGrosze', 1, MAX_GROSZE)
  return { ...value }
}

export const validateClientInput = (value) => {
  assertExactObject(value, ['name', 'age', 'status', 'specialistId'])
  const identity = assertClientIdentity({ name: value.name, age: value.age })
  assertClientStatus(value.status)
  assertId(value.specialistId, 'specialist')
  return { ...identity, status: value.status, specialistId: value.specialistId }
}

export const assertClientStatus = (value, { archivable = false } = {}) => {
  if (!clientStatuses.has(value) || (!archivable && value === 'archived')) fail('status')
  return value
}

export const assertClientStatusTransition = (from, to) => {
  if (!clientStatuses.has(from) || !clientStatuses.has(to)) fail('status')
  if (from === to) fail('status')
  if (from === 'archived') fail('status', 'CLIENT_STATUS_CONFLICT')
  if (to === 'archived') fail('status')
  return to
}

export const assertAppointmentStatus = (value, { cancellation = false } = {}) => {
  if (!appointmentStatuses.has(value) || (value === 'cancelled' && !cancellation)) fail('status')
  return value
}

export const assertAppointmentTransition = (from, to, { cancellation = false } = {}) => {
  if (!appointmentStatuses.has(from) || !appointmentStatuses.has(to)) fail('status')
  if (from === 'cancelled') fail('status')
  if (from === to) fail('status')
  if (to === 'cancelled') {
    if (!cancellation) fail('status')
    return to
  }
  if (cancellation || !editableAppointmentStatuses.has(to)) fail('status')
  return to
}

export const assertAppointmentPaymentTransition = ({ fromStatus, toStatus, previousAmountGrosze, nextAmountGrosze, collectedGrosze, cancellation = false }) => {
  assertInteger(previousAmountGrosze, 'expectedAmountGrosze', 1, MAX_GROSZE)
  assertInteger(nextAmountGrosze, 'expectedAmountGrosze', 1, MAX_GROSZE)
  if (!Number.isSafeInteger(collectedGrosze) || collectedGrosze < 0) fail('amountGrosze')
  if ((!isBillable({ status: toStatus }) || nextAmountGrosze < collectedGrosze) && collectedGrosze !== 0) fail('payment', 'APPOINTMENT_PAYMENT_CONFLICT')
  assertAppointmentTransition(fromStatus, toStatus, { cancellation })
  return toStatus
}

export const isCanonicalUtc = (value) => {
  if (typeof value !== 'string' || !utcIso.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

export const assertCanonicalUtc = (value, field = 'instant') => {
  if (!isCanonicalUtc(value)) fail(field)
  return value
}

const dateParts = (value, field = 'date') => {
  const match = typeof value === 'string' ? dateIso.exec(value) : null
  if (!match) fail(field)
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail(field)
  return { year, month, day }
}

export const assertCivilDate = (value, field = 'date') => {
  dateParts(value, field)
  return value
}

export const assertWallTime = (value, field = 'time') => {
  const match = typeof value === 'string' ? timeIso.exec(value) : null
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) fail(field)
  return value
}

const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: WARSAW_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

const localParts = (instantMs) => {
  const parts = Object.fromEntries(localFormatter.formatToParts(new Date(instantMs))
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value }) => [type, value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

export const warsawDateTimeFromUtc = (instant) => {
  assertCanonicalUtc(instant, 'instant')
  return localParts(new Date(instant).getTime())
}

export const warsawDateFromUtc = (instant) => warsawDateTimeFromUtc(instant).date

// Find the unique UTC instant whose Warsaw wall-clock parts equal the request.
// Enumerating legal IANA offsets keeps nonexistent/ambiguous DST times explicit.
export const warsawDateTimeToUtc = (date, time) => {
  const { year, month, day } = dateParts(date, 'dateTime')
  assertWallTime(time, 'dateTime')
  const [hour, minute] = time.split(':').map(Number)
  const localMs = Date.UTC(year, month - 1, day, hour, minute)
  const candidates = []
  for (let offsetMinutes = -720; offsetMinutes <= 840; offsetMinutes++) {
    const candidate = localMs - offsetMinutes * 60_000
    const parts = localParts(candidate)
    if (parts.date === date && parts.time === time) candidates.push(candidate)
  }
  if (candidates.length !== 1) fail('dateTime')
  return new Date(candidates[0]).toISOString()
}

export const addElapsedMinutes = (startsAt, durationMinutes) => {
  assertCanonicalUtc(startsAt, 'startsAt')
  assertInteger(durationMinutes, 'durationMinutes', 1, 24 * 60)
  return new Date(new Date(startsAt).getTime() + durationMinutes * 60_000).toISOString()
}

export const validateAppointmentInput = (value) => {
  assertExactObject(value, ['clientId', 'specialistId', 'serviceId', 'date', 'time', 'durationMinutes', 'expectedAmountGrosze', 'location', 'status'])
  assertId(value.clientId, 'client')
  assertId(value.specialistId, 'specialist')
  const snapshot = assertServiceSnapshot({
    serviceId: value.serviceId,
    durationMinutes: value.durationMinutes,
    expectedAmountGrosze: value.expectedAmountGrosze,
  })
  const startsAt = warsawDateTimeToUtc(value.date, value.time)
  assertLocation(value.location)
  assertAppointmentStatus(value.status)
  return {
    clientId: value.clientId,
    specialistId: value.specialistId,
    ...snapshot,
    startsAt,
    endsAt: addElapsedMinutes(startsAt, snapshot.durationMinutes),
    location: value.location,
    status: value.status,
    timeZone: WARSAW_TIME_ZONE,
  }
}

const plusCivilDays = (date, days) => {
  const { year, month, day } = dateParts(date)
  const next = new Date(Date.UTC(year, month - 1, day + days))
  return next.toISOString().slice(0, 10)
}

export const validateWarsawDateWindow = (from, to) => {
  const start = dateParts(from, 'from')
  const end = dateParts(to, 'to')
  const span = Math.round((Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000) + 1
  if (span < 1 || span > 93) fail('to')
  return {
    from,
    to,
    startsAt: warsawDateTimeToUtc(from, '00:00'),
    endsAt: warsawDateTimeToUtc(plusCivilDays(to, 1), '00:00'),
    timeZone: WARSAW_TIME_ZONE,
  }
}

export const warsawNoonToUtc = (paidDate) => warsawDateTimeToUtc(assertCivilDate(paidDate, 'paidDate'), '12:00')

export const assertAssignment = (value) => {
  assertExactObject(value, ['id', 'clientId', 'specialistId', 'startsAt', 'endsAt', 'version', 'assignedByStaffId', 'createdAt', 'updatedAt'])
  assertId(value.id, 'assignment')
  assertId(value.clientId, 'client')
  assertId(value.specialistId, 'specialist')
  assertId(value.assignedByStaffId, 'opaque', 'assignedByStaffId')
  assertCanonicalUtc(value.startsAt, 'startsAt')
  if (value.endsAt !== null) {
    assertCanonicalUtc(value.endsAt, 'endsAt')
    if (value.endsAt <= value.startsAt) fail('endsAt')
  }
  assertInteger(value.version, 'version', 1, Number.MAX_SAFE_INTEGER)
  assertCanonicalUtc(value.createdAt, 'createdAt')
  assertCanonicalUtc(value.updatedAt, 'updatedAt')
  return { ...value }
}

export const assertEffectiveAssignment = (assignments, clientId, specialistId, at) => {
  assertId(clientId, 'client')
  assertId(specialistId, 'specialist')
  assertCanonicalUtc(at, 'startsAt')
  if (!Array.isArray(assignments)) fail('assignment')
  const matching = assignments.map(assertAssignment).filter((item) => item.clientId === clientId
    && item.specialistId === specialistId && item.startsAt <= at && (item.endsAt === null || at < item.endsAt))
  if (matching.length !== 1) fail('assignment', 'CLIENT_ASSIGNMENT_CONFLICT')
  return matching[0]
}

export const assertReassignment = ({ assignments, appointments, clientId, newSpecialistId, commandNow }) => {
  assertId(clientId, 'client')
  assertId(newSpecialistId, 'specialist', 'specialistId')
  assertCanonicalUtc(commandNow, 'commandNow')
  if (!Array.isArray(assignments) || !Array.isArray(appointments)) fail('assignment')
  const open = assignments.map(assertAssignment).filter((item) => item.clientId === clientId && item.endsAt === null)
  if (open.length !== 1) fail('assignment', 'CLIENT_ASSIGNMENT_CONFLICT')
  if (open[0].specialistId === newSpecialistId
    || appointments.some((appointment) => appointment.specialistId === open[0].specialistId && appointment.status !== 'cancelled' && appointment.startsAt >= commandNow)) {
    fail('assignment', 'CLIENT_ASSIGNMENT_CONFLICT')
  }
  return { closedAssignmentId: open[0].id, endsAt: commandNow, specialistId: newSpecialistId, startsAt: commandNow }
}

export const canArchiveClient = (appointments, commandNow) => {
  assertCanonicalUtc(commandNow, 'commandNow')
  return !appointments.some((appointment) => appointment.status !== 'cancelled' && appointment.startsAt >= commandNow)
}

export const assertClientArchivable = (appointments, commandNow) => {
  if (!canArchiveClient(appointments, commandNow)) fail('status', 'CLIENT_ARCHIVE_CONFLICT')
}

export const hasSpecialistOverlap = (appointments, candidate, { excludeId = null } = {}) => {
  assertCanonicalUtc(candidate.startsAt, 'startsAt')
  assertCanonicalUtc(candidate.endsAt, 'endsAt')
  if (candidate.endsAt <= candidate.startsAt) fail('endsAt')
  return appointments.some((appointment) => appointment.id !== excludeId
    && appointment.specialistId === candidate.specialistId
    && appointment.status !== 'cancelled'
    && candidate.status !== 'cancelled'
    && appointment.startsAt < candidate.endsAt
    && candidate.startsAt < appointment.endsAt)
}

export const assertPaymentEntry = (value) => {
  assertExactObject(value, ['id', 'appointmentId', 'amountGrosze', 'method', 'receivedAt'])
  assertId(value.id, 'payment')
  assertId(value.appointmentId, 'appointment')
  assertInteger(value.amountGrosze, 'amountGrosze', 1, MAX_GROSZE)
  if (!methods.has(value.method)) fail('method')
  assertCanonicalUtc(value.receivedAt, 'receivedAt')
  return { ...value }
}

export const validatePaymentInput = (value) => {
  assertExactObject(value, ['amountGrosze', 'method', 'receivedAt'])
  assertInteger(value.amountGrosze, 'amountGrosze', 1, MAX_GROSZE)
  if (!methods.has(value.method)) fail('method')
  assertCanonicalUtc(value.receivedAt, 'receivedAt')
  return { ...value }
}

export const validateCorrectionInput = (value) => {
  assertExactObject(value, ['reason', 'replacement'])
  const reason = assertCorrectionReason(value.reason)
  if (value.replacement === null) return { reason, replacement: null }
  return { reason, replacement: validatePaymentInput(value.replacement) }
}

export const assertCorrection = (value) => {
  assertExactObject(value, ['reason', 'reversedEntry', 'replacement'], 'correction')
  const reason = assertCorrectionReason(value.reason)
  const reversedEntry = assertPaymentEntry(value.reversedEntry)
  if (value.replacement === null) return { reason, reversedEntry, replacement: null }
  const replacement = assertPaymentEntry(value.replacement)
  if (replacement.id === reversedEntry.id || replacement.appointmentId !== reversedEntry.appointmentId) fail('replacement')
  return { reason, reversedEntry, replacement }
}

export const paymentAggregate = ({ appointmentId, status, expectedAmountGrosze, paymentEntries, corrections }) => {
  assertId(appointmentId, 'appointment')
  if (!appointmentStatuses.has(status)) fail('status')
  assertInteger(expectedAmountGrosze, 'expectedAmountGrosze', 1, MAX_GROSZE)
  if (!Array.isArray(paymentEntries) || !Array.isArray(corrections)) fail('paymentEntries')
  const entries = paymentEntries.map((entry) => {
    const { id, appointmentId, amountGrosze, method, receivedAt } = entry
    return assertPaymentEntry({ id, appointmentId, amountGrosze, method, receivedAt })
  })
  const idsSeen = new Set()
  for (const entry of entries) {
    if (idsSeen.has(entry.id)) fail('paymentEntries')
    idsSeen.add(entry.id)
  }
  if (entries.some((entry) => entry.appointmentId !== appointmentId)) fail('paymentEntries', 'PAYMENT_CORRECTION_CONFLICT')
  const reversed = new Set()
  const replacements = new Set()
  for (const correction of corrections) {
    assertExactObject(correction, ['id', 'reversedEntryId', 'replacementEntryId', 'createdAt'], 'correction')
    assertId(correction.id, 'correction')
    assertCanonicalUtc(correction.createdAt, 'createdAt')
    const reversedId = assertId(correction.reversedEntryId, 'payment', 'reversedEntryId')
    const replacementId = correction.replacementEntryId === null ? null : assertId(correction.replacementEntryId, 'payment', 'replacementEntryId')
    if (!idsSeen.has(reversedId) || reversed.has(reversedId) || replacementId === reversedId || (replacementId !== null && (!idsSeen.has(replacementId) || replacements.has(replacementId) || reversed.has(replacementId)))) fail('correction', 'PAYMENT_CORRECTION_CONFLICT')
    const original = entries.find((entry) => entry.id === reversedId)
    const replacement = replacementId === null ? null : entries.find((entry) => entry.id === replacementId)
    if (replacement && replacement.appointmentId !== original.appointmentId) fail('correction', 'PAYMENT_CORRECTION_CONFLICT')
    reversed.add(reversedId)
    if (replacementId) replacements.add(replacementId)
  }
  const effective = entries.filter((entry) => !reversed.has(entry.id))
  const collectedGrosze = effective.reduce((total, entry) => total + entry.amountGrosze, 0)
  if (collectedGrosze > expectedAmountGrosze) fail('amountGrosze', 'PAYMENT_AMOUNT_CONFLICT')
  const latest = effective.toSorted((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id)).at(-1) ?? null
  if (!isBillable({ status })) return { status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0, latestMethod: null, latestReceivedAt: null }
  return {
    status: collectedGrosze === 0 ? 'unpaid' : collectedGrosze === expectedAmountGrosze ? 'paid' : 'partial',
    collectedGrosze,
    outstandingGrosze: expectedAmountGrosze - collectedGrosze,
    latestMethod: latest?.method ?? null,
    latestReceivedAt: latest?.receivedAt ?? null,
  }
}

const assertDtoAssignment = (assignment) => {
  if (assignment === null) return null
  assertExactObject(assignment, ['id', 'specialistId', 'startsAt', 'version'], 'client')
  assertId(assignment.id, 'assignment')
  assertId(assignment.specialistId, 'specialist')
  assertCanonicalUtc(assignment.startsAt, 'startsAt')
  assertInteger(assignment.version, 'version', 1, Number.MAX_SAFE_INTEGER)
  return { ...assignment }
}

export const clientDto = (client) => {
  assertExactObject(client, ['id', 'name', 'age', 'status', 'version', 'archivedAt', 'createdAt', 'updatedAt', 'assignment'], 'client')
  assertId(client.id, 'client')
  assertClientIdentity({ name: client.name, age: client.age })
  assertClientStatus(client.status, { archivable: true })
  assertInteger(client.version, 'version', 1, Number.MAX_SAFE_INTEGER)
  assertCanonicalUtc(client.createdAt, 'createdAt')
  assertCanonicalUtc(client.updatedAt, 'updatedAt')
  if ((client.status === 'archived') !== (client.archivedAt !== null)) fail('client')
  if (client.archivedAt !== null) assertCanonicalUtc(client.archivedAt, 'archivedAt')
  const assignment = assertDtoAssignment(client.assignment)
  if (client.status === 'archived' && assignment !== null) fail('client')
  return { ...client, readOnly: client.status === 'archived', assignment }
}

export const specialistDto = (specialist) => {
  assertExactObject(specialist, ['id', 'displayName', 'standardRateGrosze', 'status', 'version', 'staffVersion'], 'specialist')
  assertId(specialist.id, 'specialist')
  assertNfcTrimmed(specialist.displayName, { field: 'displayName', minBytes: 1, maxBytes: 120 })
  assertInteger(specialist.standardRateGrosze, 'standardRateGrosze', 1, MAX_GROSZE)
  if (specialist.status !== 'active') fail('specialist')
  assertInteger(specialist.version, 'version', 1, Number.MAX_SAFE_INTEGER)
  assertInteger(specialist.staffVersion, 'staffVersion', 1, Number.MAX_SAFE_INTEGER)
  return { ...specialist }
}

export const appointmentDto = (appointment) => {
  assertExactObject(appointment, ['id', 'clientId', 'specialistId', 'serviceId', 'startsAt', 'endsAt', 'timeZone', 'location', 'status', 'source', 'version', 'cancelledAt', 'createdAt', 'updatedAt', 'charge', 'paymentEntries', 'corrections'], 'appointment')
  assertId(appointment.id, 'appointment')
  assertId(appointment.clientId, 'client')
  assertId(appointment.specialistId, 'specialist')
  if (!SERVICE_BY_ID[appointment.serviceId]) fail('serviceId')
  assertCanonicalUtc(appointment.startsAt, 'startsAt')
  assertCanonicalUtc(appointment.endsAt, 'endsAt')
  if (appointment.endsAt <= appointment.startsAt || appointment.timeZone !== WARSAW_TIME_ZONE || appointment.source !== 'panel') fail('appointment')
  assertLocation(appointment.location)
  assertAppointmentStatus(appointment.status, { cancellation: true })
  if ((appointment.status === 'cancelled') !== (appointment.cancelledAt !== null)) fail('appointment')
  if (appointment.cancelledAt !== null) assertCanonicalUtc(appointment.cancelledAt, 'cancelledAt')
  assertInteger(appointment.version, 'version', 1, Number.MAX_SAFE_INTEGER)
  assertCanonicalUtc(appointment.createdAt, 'createdAt')
  assertCanonicalUtc(appointment.updatedAt, 'updatedAt')
  assertExactObject(appointment.charge, ['id', 'serviceId', 'expectedAmountGrosze', 'currency', 'version'], 'charge')
  assertId(appointment.charge.id, 'charge')
  if (appointment.charge.serviceId !== appointment.serviceId || appointment.charge.currency !== 'PLN') fail('charge')
  assertInteger(appointment.charge.expectedAmountGrosze, 'expectedAmountGrosze', 1, MAX_GROSZE)
  assertInteger(appointment.charge.version, 'version', 1, Number.MAX_SAFE_INTEGER)
  const payment = paymentAggregate({ appointmentId: appointment.id, status: appointment.status, expectedAmountGrosze: appointment.charge.expectedAmountGrosze, paymentEntries: appointment.paymentEntries, corrections: appointment.corrections })
  const correctionsByEntry = new Map(appointment.corrections.map((correction) => [correction.reversedEntryId, correction]))
  const paymentEntries = appointment.paymentEntries
    .toSorted((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))
    .map((entry) => ({ id: entry.id, amountGrosze: entry.amountGrosze, method: entry.method, receivedAt: entry.receivedAt, correctedAt: correctionsByEntry.get(entry.id)?.createdAt ?? null, replacementEntryId: correctionsByEntry.get(entry.id)?.replacementEntryId ?? null }))
  return { id: appointment.id, clientId: appointment.clientId, specialistId: appointment.specialistId, serviceId: appointment.serviceId, startsAt: appointment.startsAt, endsAt: appointment.endsAt, timeZone: appointment.timeZone, location: appointment.location, status: appointment.status, source: appointment.source, version: appointment.version, cancelledAt: appointment.cancelledAt, createdAt: appointment.createdAt, updatedAt: appointment.updatedAt, charge: { ...appointment.charge }, payment, paymentEntries }
}

export const legacyClientProjection = (client) => ({ ...clientDto(client), email: '', phone: '', notes: [], familyId: null, familyRole: null, psychId: client.assignment?.specialistId ?? null })
export const legacyAppointmentProjection = (appointment) => ({ ...appointment, psychId: appointment.specialistId, date: warsawDateFromUtc(appointment.startsAt), time: warsawDateTimeFromUtc(appointment.startsAt).time, duration: Math.round((new Date(appointment.endsAt) - new Date(appointment.startsAt)) / 60_000), amount: appointment.charge.expectedAmountGrosze / 100, payment: appointment.payment.status, paidAmount: appointment.payment.collectedGrosze / 100, method: appointment.payment.latestMethod, paidDate: appointment.payment.latestReceivedAt === null ? null : warsawDateFromUtc(appointment.payment.latestReceivedAt) })

export const clientCompatibilityDto = legacyClientProjection
export const appointmentCompatibilityDto = legacyAppointmentProjection
export const toClientDto = clientDto
export const toAppointmentDto = appointmentDto

export const safeValidationDetails = (run) => {
  try { run() } catch (error) {
    const field = String(error?.message ?? '').split('/')[1]
    const allowed = new Set(['body', 'name', 'age', 'status', 'specialistId', 'clientId', 'serviceId', 'dateTime', 'durationMinutes', 'expectedAmountGrosze', 'location', 'amountGrosze', 'method', 'receivedAt', 'paidDate', 'reason', 'replacement', 'expectedVersion', 'from', 'to', 'specialists', 'clients', 'appointments', 'paymentEntries'])
    return allowed.has(field) ? { field } : null
  }
  return null
}
