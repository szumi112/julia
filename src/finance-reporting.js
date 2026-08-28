const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
export const FINANCE_WINDOW_MIN_MONTH = '2000-06'
const isMonth = (value) => typeof value === 'string' && MONTH.test(value)
  && Number(value.slice(0, 4)) >= 2000
const LEDGER_ID = /^fin_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const KINDS = new Set(['expense', 'income'])
const STATES = new Set(['active', 'void'])
const PROGRAMS = new Set([null, 'english', 'tus'])

const invalid = () => { throw new TypeError('FINANCE_REPORT_INVALID') }

const WARSAW_MONTH = new Intl.DateTimeFormat('en', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit',
})

export function warsawMonthKey(value = new Date()) {
  const parts = Object.fromEntries(WARSAW_MONTH.formatToParts(value)
    .filter(({ type }) => type === 'year' || type === 'month')
    .map(({ type, value: part }) => [type, part]))
  const result = `${parts.year}-${parts.month}`
  if (!isMonth(result)) invalid()
  return result
}

const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const integer = (value) => Number.isSafeInteger(value) && value >= 0

const freezeMap = (entries) => Object.freeze(Object.fromEntries(entries))

const zeroKpis = () => ({
  revenueGrosze: 0,
  collectedGrosze: 0,
  outstandingGrosze: 0,
  expensesGrosze: 0,
  incomeGrosze: 0,
})

const safeAdd = (left, right) => {
  const value = left + right
  if (!Number.isSafeInteger(value)) invalid()
  return value
}

const safeSubtract = (left, right) => {
  const value = left - right
  if (!Number.isSafeInteger(value)) invalid()
  return value
}

const addKpis = (target, entry) => {
  target.revenueGrosze = safeAdd(target.revenueGrosze, entry.revenueGrosze)
  target.collectedGrosze = safeAdd(target.collectedGrosze, entry.collectedGrosze)
  target.outstandingGrosze = safeAdd(
    target.outstandingGrosze,
    safeSubtract(entry.receivableGrosze, entry.collectedGrosze),
  )
  target.expensesGrosze = safeAdd(target.expensesGrosze, entry.expenseGrosze)
  target.incomeGrosze = safeSubtract(target.revenueGrosze, target.expensesGrosze)
}

const acceptedLedgerEntry = (value) => {
  if (!plain(value) || typeof value.id !== 'string' || !LEDGER_ID.test(value.id)
    || !STATES.has(value.state) || !KINDS.has(value.kind)
    || !(value.accountingMonth === null
      || isMonth(value.accountingMonth))
    || !integer(value.revenueGrosze) || !integer(value.receivableGrosze)
    || !integer(value.collectedGrosze) || !integer(value.expenseGrosze)
    || value.collectedGrosze > value.receivableGrosze
    || (value.kind === 'income' && value.expenseGrosze !== 0)
    || (value.kind === 'expense' && (value.revenueGrosze !== 0
      || value.receivableGrosze !== 0 || value.collectedGrosze !== 0))
    || !(value.specialistId === null
      || (typeof value.specialistId === 'string' && SPECIALIST_ID.test(value.specialistId)))
    || !(value.serviceId === null
      || (typeof value.serviceId === 'string' && value.serviceId.length >= 1
        && value.serviceId.length <= 128))
    || !PROGRAMS.has(value.program)
    || typeof value.paymentMethod !== 'string' || value.paymentMethod.length < 1
    || typeof value.invoiceStatus !== 'string' || value.invoiceStatus.length < 1) invalid()
  return Object.freeze({ ...value })
}

const acceptedLink = (value, kind) => {
  if (!plain(value) || typeof value.id !== 'string' || value.id.length < 1
    || value.id.length > 128 || typeof value.ledgerId !== 'string'
    || !LEDGER_ID.test(value.ledgerId)
    || (kind === 'activity' && (!(value.program === 'english' || value.program === 'tus')
      || !Number.isSafeInteger(value.count) || value.count < 0))
    || (kind === 'occurrence' && !['day', 'month', 'unknown'].includes(value.periodPrecision))
    || (kind === 'occurrence' && typeof value.hasTime !== 'boolean')) invalid()
  return Object.freeze({
    id: value.id,
    ledgerId: value.ledgerId,
    ...(typeof value.program === 'string' ? { program: value.program } : {}),
    ...(Number.isSafeInteger(value.count) && value.count >= 0 ? { count: value.count } : {}),
    ...(typeof value.periodPrecision === 'string'
      ? { periodPrecision: value.periodPrecision } : {}),
    ...(typeof value.hasTime === 'boolean' ? { hasTime: value.hasTime } : {}),
  })
}

const acceptedPaymentEvent = (value) => {
  if (!plain(value) || typeof value.id !== 'string' || value.id.length < 1
    || value.id.length > 128 || typeof value.ledgerId !== 'string'
    || !LEDGER_ID.test(value.ledgerId) || !integer(value.amountGrosze)
    || value.amountGrosze < 1 || typeof value.method !== 'string'
    || value.method.length < 1 || value.method.length > 32) invalid()
  return Object.freeze({ ...value })
}

const nextMonth = (month) => {
  const year = Number(month.slice(0, 4))
  const value = Number(month.slice(5, 7))
  return value === 12
    ? `${String(year + 1).padStart(4, '0')}-01`
    : `${String(year).padStart(4, '0')}-${String(value + 1).padStart(2, '0')}`
}

export function financeMonthView(input) {
  if (!plain(input) || !isMonth(input.currentMonth) || !isMonth(input.selectedMonth)
    || !Number.isSafeInteger(input.selectedRowCount) || input.selectedRowCount < 0
    || !(input.requestedMonth === null || input.requestedMonth === undefined
      || typeof input.requestedMonth === 'string')
    || !(input.savedMonth === null || input.savedMonth === undefined
      || typeof input.savedMonth === 'string')
    || !(input.latestPopulatedMonth === null || isMonth(input.latestPopulatedMonth))) invalid()
  const safeMonth = (value) => isMonth(value)
    && value >= FINANCE_WINDOW_MIN_MONTH && value <= input.currentMonth
  const hasRequestedMonth = input.requestedMonth !== null && input.requestedMonth !== undefined
  const initialMonth = hasRequestedMonth
    ? safeMonth(input.requestedMonth) ? input.requestedMonth : input.currentMonth
    : safeMonth(input.savedMonth) ? input.savedMonth : input.currentMonth
  const emptyCopy = input.selectedRowCount === 0
    ? input.selectedMonth === input.currentMonth
      ? 'Brak danych w bieżącym miesiącu'
      : 'Brak danych w wybranym miesiącu'
    : null
  const latestPopulatedMonth = input.selectedRowCount === 0
    && input.selectedMonth === input.currentMonth
    && input.latestPopulatedMonth !== input.currentMonth
      ? input.latestPopulatedMonth
      : null
  return Object.freeze({ initialMonth, emptyCopy, latestPopulatedMonth })
}

const increment = (map, key, amount) => map.set(key, safeAdd(map.get(key) ?? 0, amount))

const sortedMoneyMap = (map) => freezeMap([...map.entries()].sort(([left], [right]) => (
  left < right ? -1 : left > right ? 1 : 0
)))

const kpisFor = (entries) => {
  const result = zeroKpis()
  for (const entry of entries) addKpis(result, entry)
  return Object.freeze(result)
}

export function createFinanceReadModel(input) {
  if (!plain(input) || !Array.isArray(input.ledgerEntries)
    || !Array.isArray(input.paymentEvents)
    || !Array.isArray(input.occurrenceLinks) || !Array.isArray(input.activityLinks)
    || !isMonth(input.selectedMonth)
    || !Array.isArray(input.trendMonths) || input.trendMonths.length !== 6
    || input.trendMonths.some((month, index) => !isMonth(month)
      || (index > 0 && month !== nextMonth(input.trendMonths[index - 1])))
    || input.trendMonths.at(-1) !== input.selectedMonth
    || !(input.specialistId === null
      || (typeof input.specialistId === 'string' && SPECIALIST_ID.test(input.specialistId)))) invalid()

  const entries = input.ledgerEntries.map(acceptedLedgerEntry)
  const byId = new Map()
  for (const entry of entries) {
    if (byId.has(entry.id)) invalid()
    byId.set(entry.id, entry)
  }

  const contexts = new Map(entries.map(({ id }) => [id, []]))
  const occurrenceLinks = input.occurrenceLinks.map((value) => acceptedLink(value, 'occurrence'))
  const activityLinks = input.activityLinks.map((value) => acceptedLink(value, 'activity'))
  for (const link of [...occurrenceLinks, ...activityLinks]) {
    if (!byId.has(link.ledgerId)) invalid()
    contexts.get(link.ledgerId).push(link)
  }

  const paymentEvents = input.paymentEvents.map(acceptedPaymentEvent)
  const paymentIds = new Set()
  const paymentEventsByLedgerId = new Map()
  for (const event of paymentEvents) {
    if (paymentIds.has(event.id) || !byId.has(event.ledgerId)) invalid()
    paymentIds.add(event.id)
    const values = paymentEventsByLedgerId.get(event.ledgerId) ?? []
    values.push(event)
    paymentEventsByLedgerId.set(event.ledgerId, values)
  }
  for (const entry of entries) {
    const values = paymentEventsByLedgerId.get(entry.id) ?? []
    let total = 0
    for (const value of values) total = safeAdd(total, value.amountGrosze)
    if (total !== entry.collectedGrosze) invalid()
  }

  const scoped = entries.filter((entry) => input.specialistId === null
    || entry.specialistId === input.specialistId)
  const active = scoped.filter(({ state }) => state === 'active')
  const voidEntries = scoped.filter(({ state }) => state === 'void')
  const unknownPeriod = active.filter(({ accountingMonth }) => accountingMonth === null)
  const selected = active.filter(({ accountingMonth }) => accountingMonth === input.selectedMonth)

  const trend = input.trendMonths.map((month) => Object.freeze({
    month,
    ...kpisFor(active.filter(({ accountingMonth }) => accountingMonth === month)),
  }))
  const populatedMonths = active
    .filter(({ accountingMonth }) => accountingMonth !== null)
    .map(({ accountingMonth }) => accountingMonth)
    .sort()

  const specialist = new Map()
  const service = new Map()
  const payment = new Map()
  const invoice = new Map()
  const programRevenue = new Map([['english', 0], ['tus', 0]])
  const programCounts = new Map([['english', 0], ['tus', 0]])
  for (const entry of selected) {
    if (entry.kind !== 'income') continue
    increment(specialist, entry.specialistId ?? 'Nie ustalono', entry.revenueGrosze)
    increment(service, entry.serviceId ?? 'Nie ustalono', entry.revenueGrosze)
    for (const event of paymentEventsByLedgerId.get(entry.id) ?? []) {
      increment(payment, event.method, event.amountGrosze)
    }
    const invoiceValue = invoice.get(entry.invoiceStatus) ?? { count: 0, revenueGrosze: 0 }
    invoice.set(entry.invoiceStatus, {
      count: invoiceValue.count + 1,
      revenueGrosze: safeAdd(invoiceValue.revenueGrosze, entry.revenueGrosze),
    })
    if (entry.program !== null) increment(programRevenue, entry.program, entry.revenueGrosze)
  }
  payment.set('outstanding', kpisFor(selected).outstandingGrosze)
  for (const link of activityLinks) {
    const entry = byId.get(link.ledgerId)
    if (entry.state === 'active' && entry.accountingMonth === input.selectedMonth
      && (input.specialistId === null || entry.specialistId === input.specialistId)
      && PROGRAMS.has(link.program) && link.program !== null) {
      increment(programCounts, link.program, link.count ?? 0)
    }
  }

  return Object.freeze({
    selectedMonth: input.selectedMonth,
    latestPopulatedMonth: populatedMonths.at(-1) ?? null,
    kpis: kpisFor(selected),
    rows: Object.freeze([...selected]),
    trend: Object.freeze(trend),
    contextsByLedgerId: freezeMap([...contexts.entries()].filter(([id]) => (
      input.specialistId === null || byId.get(id).specialistId === input.specialistId
    )).map(([id, values]) => (
      [id, Object.freeze(values)]
    ))),
    unknownPeriod: Object.freeze(unknownPeriod),
    voidEntries: Object.freeze(voidEntries),
    splits: Object.freeze({
      specialist: sortedMoneyMap(specialist),
      service: sortedMoneyMap(service),
      payment: sortedMoneyMap(payment),
      invoice: freezeMap([...invoice.entries()].sort(([left], [right]) => (
        left < right ? -1 : left > right ? 1 : 0
      )).map(([key, value]) => [key, Object.freeze(value)])),
      program: freezeMap(['english', 'tus'].map((key) => [key, Object.freeze({
        count: programCounts.get(key),
        revenueGrosze: programRevenue.get(key),
      })])),
    }),
  })
}
