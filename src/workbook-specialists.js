const collator = new Intl.Collator('pl-PL', { sensitivity: 'base', usage: 'sort' })

const canonicalName = (value) => {
  if (typeof value !== 'string') return null
  const name = value.trim().normalize('NFC')
  if (!name || new TextEncoder().encode(name).byteLength > 120) return null
  return name
}

export function specialistProfilesFromWorkbook(rows) {
  if (!Array.isArray(rows)) throw new TypeError('WORKBOOK_SPECIALISTS_INVALID')
  const names = new Set()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new TypeError('WORKBOOK_SPECIALISTS_INVALID')
    }
    const name = canonicalName(row.specialistName)
    if (name) names.add(name)
  }
  return Object.freeze([...names]
    .sort((left, right) => collator.compare(left, right) || left.localeCompare(right))
    .map((displayName) => Object.freeze({ displayName, standardRateGrosze: 18000 })))
}
