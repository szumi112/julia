import { STATUS_LABELS } from './format.js'

const ACTIVITY_ACTIONS = Object.freeze({
  'appointment.created': { kind: 'appointment', summary: 'Dodano sesję' },
  'appointment.updated': { kind: 'appointment', summary: 'Zmieniono sesję' },
  'appointment.cancelled': { kind: 'appointment', summary: 'Odwołano sesję' },
  'appointment.restored': { kind: 'appointment', summary: 'Przywrócono sesję' },
  'client.created': { kind: 'client', summary: 'Dodano klienta' },
  'client.updated': { kind: 'client', summary: 'Zmieniono dane klienta' },
  'client.assignment.changed': { kind: 'client', summary: 'Zmieniono specjalistkę klienta' },
  'client.archived': { kind: 'client', summary: 'Przeniesiono klienta do archiwum' },
  'payment.recorded': { kind: 'payment', summary: 'Zapisano wpłatę' },
  'payment.corrected': { kind: 'payment', summary: 'Poprawiono wpłatę' },
  'finance.entry.created': { kind: 'finance', summary: 'Dodano wpis finansowy' },
  'finance.entry.adjusted': { kind: 'finance', summary: 'Poprawiono wpis finansowy' },
  'finance.entry.voided': { kind: 'finance', summary: 'Unieważniono wpis finansowy' },
  'staff.invited': { kind: 'team', summary: 'Zaproszono osobę do zespołu' },
  'staff.deactivated': { kind: 'team', summary: 'Wyłączono dostęp do panelu' },
  'staff.role.updated': { kind: 'team', summary: 'Zmieniono rolę w zespole' },
  'staff.capabilities.updated': { kind: 'team', summary: 'Zmieniono uprawnienia' },
  'specialist.account.linked': { kind: 'team', summary: 'Połączono konto specjalistki' },
  'specialist.profile.created': { kind: 'team', summary: 'Dodano specjalistkę' },
  'specialist.profile.updated': { kind: 'team', summary: 'Zmieniono profil specjalistki' },
  'specialist.absence.created': { kind: 'team', summary: 'Dodano nieobecność specjalistki' },
  'specialist.absence.cancelled': { kind: 'team', summary: 'Odwołano nieobecność specjalistki' },
  'activity.group.created': { kind: 'group', summary: 'Dodano grupę zajęć' },
  'activity.group.updated': { kind: 'group', summary: 'Zmieniono grupę zajęć' },
  'activity.participant.created': { kind: 'group', summary: 'Dodano uczestnika zajęć' },
  'activity.participant.updated': { kind: 'group', summary: 'Zmieniono uczestnika zajęć' },
  'activity.membership.created': { kind: 'group', summary: 'Zapisano uczestnika do grupy' },
  'activity.membership.updated': { kind: 'group', summary: 'Zmieniono udział w grupie' },
  'activity.class.created': { kind: 'group', summary: 'Dodano zajęcia grupowe' },
  'activity.class.updated': { kind: 'group', summary: 'Zmieniono zajęcia grupowe' },
  'activity.attendance.set': { kind: 'group', summary: 'Zapisano obecność na zajęciach' },
  'activity.charge.created': { kind: 'group', summary: 'Dodano opłatę za zajęcia' },
})

export const ACTIVITY_KINDS = Object.freeze([
  { value: 'finance', label: 'Finanse' },
  { value: 'client', label: 'Klienci' },
  { value: 'appointment', label: 'Sesje' },
  { value: 'payment', label: 'Wpłaty' },
  { value: 'group', label: 'Zajęcia grupowe' },
  { value: 'team', label: 'Zespół' },
].map((item) => Object.freeze(item)))

export const ACTIVITY_ACTION_NAMES = Object.freeze(Object.keys(ACTIVITY_ACTIONS))

export const activityForAction = (action) => ACTIVITY_ACTIONS[action] ?? null

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const STATUS = STATUS_LABELS
const FIELDS = Object.freeze(['time', 'specialist', 'status', 'amount'])
const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
const validValue = (field, value) => value === null || (
  (field === 'time' && validInstant(value))
  || (field === 'specialist' && typeof value === 'string' && SPECIALIST_ID.test(value))
  || (field === 'status' && typeof value === 'string' && Object.hasOwn(STATUS, value))
  || (field === 'amount' && Number.isSafeInteger(value) && value >= 0)
)

export function captureActivityChanges(value) {
  if (!Array.isArray(value) || value.length > FIELDS.length) return null
  const seen = new Set()
  const captured = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.getPrototypeOf(item) !== Object.prototype
      || Reflect.ownKeys(item).length !== 3
      || !['field', 'before', 'after'].every((key) => Object.hasOwn(item, key))
      || !FIELDS.includes(item.field) || seen.has(item.field)
      || !validValue(item.field, item.before) || !validValue(item.field, item.after)
      || item.before === item.after) return null
    seen.add(item.field)
    captured.push(Object.freeze({ field: item.field, before: item.before, after: item.after }))
  }
  if (captured.some((item, index) => index > 0
    && FIELDS.indexOf(captured[index - 1].field) >= FIELDS.indexOf(item.field))) return null
  return Object.freeze(captured)
}

export function appointmentActivityChanges(before, after) {
  const changes = []
  for (const [field, key] of [
    ['time', 'startsAt'],
    ['specialist', 'specialistId'],
    ['status', 'status'],
    ['amount', 'expectedAmountGrosze'],
  ]) {
    const previous = before?.[key] ?? null
    const next = after?.[key] ?? null
    if (previous !== next) changes.push({ field, before: previous, after: next })
  }
  const captured = captureActivityChanges(changes)
  if (!captured) throw new Error('ACTIVITY_DETAILS_INVALID')
  return captured
}

export function amountActivityChanges(before, after) {
  const changes = before === after ? [] : [{ field: 'amount', before, after }]
  const captured = captureActivityChanges(changes)
  if (!captured) throw new Error('ACTIVITY_DETAILS_INVALID')
  return captured
}

const money = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const time = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
})
const valueLabel = (field, value, specialists) => {
  if (value === null) return 'Brak'
  if (field === 'time') return time.format(new Date(value))
  if (field === 'specialist') return specialists.get(value) ?? 'Nieznana specjalistka'
  if (field === 'status') return STATUS[value]
  return `${money.format(value / 100)} zł`
}

export function formatActivityChanges(changes, specialists = new Map()) {
  const captured = captureActivityChanges(changes)
  if (!captured || !(specialists instanceof Map)) throw new Error('ACTIVITY_DETAILS_INVALID')
  return captured.map(({ field, before, after }) => Object.freeze({
    field: ({ time: 'Termin', specialist: 'Specjalistka', status: 'Status', amount: 'Kwota' })[field],
    before: valueLabel(field, before, specialists),
    after: valueLabel(field, after, specialists),
  }))
}

const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const AUDIT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export const isActivityEventId = (value) => typeof value === 'string' && AUDIT_ID.test(value)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const CURSOR = /^v1\.[1-9]\d*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/
const QUERY_KEYS = ['actor', 'client', 'kind', 'from', 'to', 'limit', 'cursor']
const ITEM_KEYS = ['id', 'occurredAt', 'kind', 'actorName', 'clientName', 'summary', 'details']
const DETAIL_KEYS = ['field', 'before', 'after']
const FILTER_KEYS = ['actors', 'clients']
const LABEL_FIELDS = ['Termin', 'Specjalistka', 'Status', 'Kwota']
const kinds = new Set(ACTIVITY_KINDS.map((item) => item.value))
const exact = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const label = (value) => typeof value === 'string' && value.length > 0
  && value.length <= 200 && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value)
const civilDate = (value) => {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}
const invalid = (field) => { throw new TypeError(`VALIDATION_FAILED/${field}`) }

export function captureActivityHistoryQuery(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => !QUERY_KEYS.includes(key))) invalid('query')
  const captured = Object.fromEntries(QUERY_KEYS.map((key) => [key, value[key] === ''
    || value[key] === undefined ? null : value[key]]))
  captured.limit ??= 20
  if ((captured.actor !== null && (typeof captured.actor !== 'string'
      || !STAFF_ID.test(captured.actor)))
    || (captured.client !== null && (typeof captured.client !== 'string'
      || !CLIENT_ID.test(captured.client)))
    || (captured.kind !== null && !kinds.has(captured.kind))
    || (captured.from !== null && !civilDate(captured.from))
    || (captured.to !== null && !civilDate(captured.to))
    || (captured.from !== null && captured.to !== null && captured.from > captured.to)
    || !Number.isSafeInteger(captured.limit) || captured.limit < 1 || captured.limit > 100
    || (captured.cursor !== null && (typeof captured.cursor !== 'string'
      || captured.cursor.length > 1024 || !CURSOR.test(captured.cursor)))) invalid('query')
  return Object.freeze(captured)
}

const validOptions = (items, idPattern) => Array.isArray(items) && items.length <= 1000
  && items.every((option) => exact(option, ['id', 'label'])
    && typeof option.id === 'string' && idPattern.test(option.id) && label(option.label))
  && new Set(items.map((option) => option.id)).size === items.length

export function captureActivityHistoryPayload(value) {
  if (!exact(value, ['items', 'nextCursor', 'filters'])
    || !Array.isArray(value.items) || value.items.length > 100
    || !exact(value.filters, FILTER_KEYS)
    || !validOptions(value.filters.actors, STAFF_ID)
    || !validOptions(value.filters.clients, CLIENT_ID)
    || (value.nextCursor !== null && (typeof value.nextCursor !== 'string'
      || value.nextCursor.length > 1024 || !CURSOR.test(value.nextCursor)))) invalid('activity')
  for (const item of value.items) {
    if (!exact(item, ITEM_KEYS) || !isActivityEventId(item.id)
      || !validInstant(item.occurredAt) || !kinds.has(item.kind)
      || !label(item.actorName) || (item.clientName !== null && !label(item.clientName))
      || !Object.values(ACTIVITY_ACTIONS).some((action) => (
        action.kind === item.kind && action.summary === item.summary
      )) || !Array.isArray(item.details) || item.details.length > 4) invalid('activity')
    for (const detail of item.details) {
      if (!exact(detail, DETAIL_KEYS) || !LABEL_FIELDS.includes(detail.field)
        || !label(detail.before) || !label(detail.after)) invalid('activity')
    }
  }
  return value
}
