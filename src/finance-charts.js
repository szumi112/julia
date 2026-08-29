// Chart read-models for the protected finance window. Pure and JSX-free so
// node --test can import them (AGENTS.md: domain logic stays pure).

const PAYMENT_MIX = Object.freeze({
  blik: Object.freeze({ label: 'BLIK', tone: 'pink' }),
  card: Object.freeze({ label: 'Karta', tone: 'coral' }),
  cash: Object.freeze({ label: 'Gotówka', tone: 'sage' }),
  monthly: Object.freeze({ label: 'Miesięcznie', tone: 'amber' }),
  other: Object.freeze({ label: 'Inna', tone: 'ink-faint' }),
  transfer: Object.freeze({ label: 'Przelew', tone: 'sky-deep' }),
  unknown: Object.freeze({ label: 'Nie ustalono', tone: 'line-strong' }),
})

export const SERVICE_RANK_LIMIT = 5

const assertSplit = (split, name) => {
  if (split === null || typeof split !== 'object' || Array.isArray(split)) {
    throw new TypeError(`${name} must be a plain object`)
  }
}

const assertAmount = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} amounts must be non-negative safe integers`)
  }
}

const byValueThenLabel = (left, right) => (
  right.value - left.value || left.label.localeCompare(right.label, 'pl')
)

// Donut parts for the collected money of the selected month: one part per
// payment method with a positive amount, largest first. The synthetic
// 'outstanding' bucket is the settlement bar's story, not the donut's.
export function paymentMixParts(paymentSplit) {
  assertSplit(paymentSplit, 'paymentSplit')
  const parts = []
  for (const [method, value] of Object.entries(paymentSplit)) {
    if (method === 'outstanding') continue
    const mix = PAYMENT_MIX[method]
    if (mix === undefined) throw new TypeError(`unknown payment method: ${method}`)
    assertAmount(value, 'paymentSplit')
    if (value > 0) {
      parts.push(Object.freeze({ id: method, label: mix.label, tone: mix.tone, value }))
    }
  }
  return Object.freeze(parts.sort(byValueThenLabel))
}

// Ranked revenue rows for the selected month: the top services plus one
// explicit 'Pozostałe' bucket, so the list never exceeds limit + 1 rows.
export function serviceRevenueRanks(serviceSplit, labelFor, limit = SERVICE_RANK_LIMIT) {
  assertSplit(serviceSplit, 'serviceSplit')
  if (typeof labelFor !== 'function') throw new TypeError('labelFor must be a function')
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a positive integer')
  }
  const ranked = []
  for (const [id, value] of Object.entries(serviceSplit)) {
    assertAmount(value, 'serviceSplit')
    if (value > 0) ranked.push({ id, label: String(labelFor(id)), value })
  }
  ranked.sort(byValueThenLabel)
  if (ranked.length <= limit) {
    return Object.freeze(ranked.map((row) => Object.freeze(row)))
  }
  const rest = ranked.slice(limit)
  return Object.freeze([
    ...ranked.slice(0, limit).map((row) => Object.freeze(row)),
    Object.freeze({
      id: 'rest',
      label: 'Pozostałe',
      value: rest.reduce((total, row) => total + row.value, 0),
    }),
  ])
}
