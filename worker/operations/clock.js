const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

const invalid = () => {
  throw new TypeError('CLOCK_INVALID')
}

const partNames = ['year', 'month', 'day', 'hour', 'minute']

const validInstant = (instantMs) => {
  if (!Number.isSafeInteger(instantMs) || instantMs < 0) invalid()
  const date = new Date(instantMs)
  if (date.getTime() !== instantMs) invalid()
  return date
}

const canonicalPart = (name, value) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) invalid()
  const number = Number(value)
  if (!Number.isSafeInteger(number)) invalid()
  if (name === 'year' && (value.length !== 4 || number < 0 || number > 9999)) invalid()
  if ((name === 'month' || name === 'day' || name === 'hour' || name === 'minute') && value.length !== 2) invalid()
  if (name === 'month' && (number < 1 || number > 12)) invalid()
  if (name === 'day' && (number < 1 || number > 31)) invalid()
  if (name === 'hour' && (number < 0 || number > 23)) invalid()
  if (name === 'minute' && (number < 0 || number > 59)) invalid()
  return value
}

const stateKeys = [
  'hasLiveBackupForLocalDay',
  'hasLiveMonthlyBackupForLocalMonth',
  'hasStoredMonthlyBackupForLocalMonth',
]

const validState = (state) => {
  try {
    if (state === null || typeof state !== 'object' || Array.isArray(state) || Object.getPrototypeOf(state) !== Object.prototype) invalid()
    const keys = Reflect.ownKeys(state)
    if (keys.length !== stateKeys.length || !stateKeys.every((key) => Object.hasOwn(state, key))) invalid()

    const snapshot = {}
    for (const key of stateKeys) {
      const value = state[key]
      if (typeof value !== 'boolean') invalid()
      snapshot[key] = value
    }
    return snapshot
  } catch {
    invalid()
  }
}

export function partsInWarsaw(instantMs) {
  const date = validInstant(instantMs)
  try {
    const parts = formatter.formatToParts(date)
    const values = {}
    for (const part of parts) {
      const type = part.type
      if (type === 'literal') continue
      if (!partNames.includes(type) || Object.hasOwn(values, type)) invalid()
      values[type] = canonicalPart(type, part.value)
    }
    if (!partNames.every((name) => Object.hasOwn(values, name))) invalid()
    return {
      day: `${values.year}-${values.month}-${values.day}`,
      month: `${values.year}-${values.month}`,
      hour: Number(values.hour),
      minute: Number(values.minute),
    }
  } catch {
    invalid()
  }
}

export function backupDue(instantMs, state) {
  const { day, month, hour, minute } = partsInWarsaw(instantMs)
  const snapshot = validState(state)
  if (hour < 3 || (hour === 3 && minute < 15) || snapshot.hasLiveBackupForLocalDay) return false
  if (snapshot.hasLiveMonthlyBackupForLocalMonth) return false
  return {
    localDay: day,
    localMonth: month,
    retentionClass: snapshot.hasStoredMonthlyBackupForLocalMonth ? 'daily' : 'monthly',
  }
}
