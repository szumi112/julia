const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const ABSENCE_ID = /^abs_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const invalid = (field = 'body') => { throw new TypeError(`VALIDATION_FAILED/${field}`) }

const exact = (value, keys, field = 'body') => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid(field)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length !== keys.length || ownKeys.some((key) => (
    typeof key !== 'string' || !keys.includes(key)
    || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')
  ))) invalid(field)
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])))
}

const civilDate = (value) => {
  if (typeof value !== 'string') return null
  const match = CIVIL_DATE.exec(value)
  if (!match) return null
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const date = new Date(epoch)
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]) ? value : null
}

const instant = (value) => {
  if (typeof value !== 'string' || !INSTANT.test(value)) return false
  try { return new Date(value).toISOString() === value } catch { return false }
}

export const isSpecialistAbsenceId = (value) => typeof value === 'string' && ABSENCE_ID.test(value)

export function captureSpecialistAbsenceInput(value) {
  const captured = exact(value, ['specialistId', 'dateFrom', 'dateTo', 'allDay'])
  if (typeof captured.specialistId !== 'string' || !SPECIALIST_ID.test(captured.specialistId)) {
    invalid('specialistId')
  }
  if (civilDate(captured.dateFrom) === null || civilDate(captured.dateTo) === null) {
    invalid('dateRange')
  }
  if (captured.dateTo < captured.dateFrom) invalid('dateRange')
  if (captured.allDay !== true) invalid('allDay')
  return captured
}

export function captureSpecialistAbsence(value) {
  const captured = exact(value, [
    'id', 'specialistId', 'dateFrom', 'dateTo', 'allDay',
    'version', 'createdAt', 'cancelledAt',
  ])
  if (!isSpecialistAbsenceId(captured.id)
    || typeof captured.specialistId !== 'string' || !SPECIALIST_ID.test(captured.specialistId)
    || captured.allDay !== true || !Number.isSafeInteger(captured.version) || captured.version < 1
    || !instant(captured.createdAt)
    || (captured.cancelledAt !== null && !instant(captured.cancelledAt))) invalid()
  if (civilDate(captured.dateFrom) === null || civilDate(captured.dateTo) === null
    || captured.dateTo < captured.dateFrom) invalid('dateRange')
  return captured
}

export function captureSpecialistAbsenceCancelInput(value) {
  const captured = exact(value, ['expectedVersion'])
  if (!Number.isSafeInteger(captured.expectedVersion) || captured.expectedVersion < 1) {
    invalid('expectedVersion')
  }
  return captured
}

export function captureSpecialistAbsencesPayload(value) {
  const captured = exact(value, ['from', 'to', 'absences'])
  if (civilDate(captured.from) === null || civilDate(captured.to) === null
    || captured.to < captured.from || !Array.isArray(captured.absences)) invalid()
  const absences = Object.freeze(captured.absences.map(captureSpecialistAbsence))
  return Object.freeze({ from: captured.from, to: captured.to, absences })
}
