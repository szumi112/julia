// Formatting helpers — Polish locale throughout.

const wholeMoneyFmt = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'PLN',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})
const fractionalMoneyFmt = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'PLN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export const fmtMoney = (n) => {
  const numeric = Number(n)
  const value = Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0
  return (Number.isInteger(value) ? wholeMoneyFmt : fractionalMoneyFmt).format(value)
}

export const fmtNumber = (n) => new Intl.NumberFormat('pl-PL').format(n)

export const pad2 = (n) => String(n).padStart(2, '0')

export const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

const canonicalUtcInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const warsawDateTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
})

export const warsawDateTimeFromUtc = (instant) => {
  if (typeof instant !== 'string' || !canonicalUtcInstant.test(instant)) {
    throw new TypeError('Invalid UTC instant')
  }
  const date = new Date(instant)
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== instant) {
    throw new TypeError('Invalid UTC instant')
  }
  const parts = Object.fromEntries(warsawDateTimeFmt.formatToParts(date)
    .filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    second: parts.second,
  }
}

export const parseISO = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export const monthKey = (isoOrDate) => {
  if (typeof isoOrDate === 'string') return isoOrDate.slice(0, 7)
  return `${isoOrDate.getFullYear()}-${pad2(isoOrDate.getMonth() + 1)}`
}

export const monthKeyToDate = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1)
}

export const addMonths = (ym, delta) => {
  const d = monthKeyToDate(ym)
  d.setMonth(d.getMonth() + delta)
  return monthKey(d)
}

const monthLong = new Intl.DateTimeFormat('pl-PL', { month: 'long' })
const monthYearFmt = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric' })
const dayMonthFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long' })
const fullDateFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })
const weekdayFmt = new Intl.DateTimeFormat('pl-PL', { weekday: 'long' })
const shortDateFmt = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short' })

export const fmtMonthName = (ym) => monthLong.format(monthKeyToDate(ym))
export const fmtMonthYear = (ym) => monthYearFmt.format(monthKeyToDate(ym))
export const fmtMonthNameWithYearOutsideCurrent = (ym, currentYear) => {
  const year = Number(ym.slice(0, 4))
  return year === Number(currentYear) ? fmtMonthName(ym) : fmtMonthYear(ym)
}
// locative case for prose ("w lipcu") — Intl only provides the nominative
const MONTHS_LOC = ['styczniu', 'lutym', 'marcu', 'kwietniu', 'maju', 'czerwcu', 'lipcu', 'sierpniu', 'wrześniu', 'październiku', 'listopadzie', 'grudniu']
export const fmtMonthLocative = (ym) => MONTHS_LOC[Number(ym.slice(5, 7)) - 1]
// "we wrześniu 2026" / "w lipcu 2026" - prose phrase with the right preposition
export const inMonthYear = (ym) => {
  const month = fmtMonthLocative(ym)
  return `${month.startsWith('wrz') ? 'we' : 'w'} ${month} ${ym.slice(0, 4)}`
}
export const fmtDayMonth = (iso) => dayMonthFmt.format(parseISO(iso))
export const fmtFullDate = (iso) => fullDateFmt.format(parseISO(iso))
export const fmtWeekday = (iso) => weekdayFmt.format(parseISO(iso))
export const fmtShortDate = (iso) => shortDateFmt.format(parseISO(iso))
// Span label for a week ("20 – 26 lipca"); the month is only repeated on the
// start when the week straddles two of them ("29 czerwca – 5 lipca").
export const fmtWeekRange = (startIso, endIso) => {
  const start = startIso.slice(0, 7) === endIso.slice(0, 7)
    ? Number(startIso.slice(8))
    : fmtDayMonth(startIso)
  return `${start} – ${fmtDayMonth(endIso)}`
}

// Relative-day label in the app's short voice ("dziś" / "wczoraj"), falling
// back to the short date beyond yesterday. Intl.RelativeTimeFormat would give
// the long "dzisiaj", which clashes with the compact labels used everywhere.
export const relDayLabel = (iso) => {
  const today = toISODate(new Date())
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return iso === today ? 'dziś' : iso === toISODate(yesterday) ? 'wczoraj' : fmtShortDate(iso)
}

// Compact countdown ("za 2 h 5 min" / "za 45 min" / "za chwilę")
export const untilLabel = (mins) => {
  if (mins < 1) return 'za chwilę'
  if (mins < 60) return `za ${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `za ${h} h ${m} min` : `za ${h} h`
}

// ISO-8601 week number (1–53) — the dashboard masthead's "issue number"
export const isoWeek = (iso) => {
  const thursday = parseISO(iso)
  thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7))
  const firstThursday = new Date(thursday.getFullYear(), 0, 4)
  firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7))
  return 1 + Math.round((thursday - firstThursday) / 604800000)
}

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

export const timeToMin = (t) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + (m || 0)
}

// Search normalization: lowercase + strip diacritics. 'ł' needs an explicit
// map — it has no NFD decomposition.
export const searchNorm = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

// Polish plural rules: 1 sesja / 2–4 sesje / 5+ sesji
/**
 * Polish age label for a single age (`ageLabel(7, 7)` → „7 lat") or a range
 * (`ageLabel(5, 6)` → „5–6 lat"). Empty string for anything nonsensical, so
 * callers can `||` a fallback. Shared by client records and TUS groups.
 */
export const ageLabel = (ageMin, ageMax) => {
  const min = Number(ageMin)
  const max = Number(ageMax)
  if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max <= 0 || min > max) return ''
  if (min !== max) return `${min}–${max} lat`
  if (min === 1) return '1 rok'
  const lastTwo = min % 100
  const last = min % 10
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)
    ? `${min} lata`
    : `${min} lat`
}

export const plural = (n, one, few, many) => {
  const abs = Math.abs(n)
  if (abs === 1) return one
  const d = abs % 10
  const h = abs % 100
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few
  return many
}

export const sessionsWord = (n) => plural(n, 'sesja', 'sesje', 'sesji')
export const clientsWord = (n) => plural(n, 'klient', 'klientów', 'klientów')
export const workbookEntriesWord = (n) => plural(
  n,
  'wpis z arkusza',
  'wpisy z arkusza',
  'wpisów z arkusza',
)
export const absencesWord = (n) => plural(n, 'nieobecność', 'nieobecności', 'nieobecności')
export const calendarCountLabel = (sessionCount, workbookEntryCount, absenceCount = 0) => [
  `${sessionCount} ${sessionsWord(sessionCount)}`,
  workbookEntryCount > 0 ? `${workbookEntryCount} ${workbookEntriesWord(workbookEntryCount)}` : null,
  absenceCount > 0 ? `${absenceCount} ${absencesWord(absenceCount)}` : null,
].filter(Boolean).join(' · ')

export const initials = (name) =>
  name
    .replace(/\(.*\)/, '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

export const STATUS_LABELS = {
  scheduled: 'Zaplanowana',
  completed: 'Odbyta',
  cancelled: 'Odwołana',
  noshow: 'Nieobecność',
}

export const STATUS_PILL = {
  scheduled: 'pill--ink',
  completed: 'pill--sage',
  cancelled: 'pill--ink',
  noshow: 'pill--pink',
}

export const PAY_LABELS = {
  paid: 'Opłacona',
  unpaid: 'Do zapłaty',
  partial: 'Częściowo opłacona',
}

export const PAY_PILL = {
  paid: 'pill--sage',
  unpaid: 'pill--amber',
  partial: 'pill--amber',
}

export const METHOD_LABELS = {
  cash: 'Gotówka',
  card: 'Karta',
  transfer: 'Przelew',
  monthly: 'Miesięcznie',
}

// index = Date.getDay()
export const WEEKDAY_SHORT = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb']

export const paymentPatchFor = (payment, amount, paidAmount = 0) => {
  const total = Number(amount)
  if (payment === 'paid') return { payment, paidAmount: total }
  if (payment === 'unpaid') return { payment, paidAmount: 0 }
  const current = Number(paidAmount)
  const roundedFallback = Math.round(total / 2 / 10) * 10
  const fallback = roundedFallback > 0 && roundedFallback < total ? roundedFallback : total / 2
  return { payment: 'partial', paidAmount: current > 0 && current < total ? current : fallback }
}

// Billing rules: completed + no-show sessions and paid late cancellations are billed.
export const isBillable = (s) => s.status === 'completed' || s.status === 'noshow'
  || (s.status === 'cancelled' && s.cancellationReason === 'late_paid')

export const paymentDisplayFor = (session, now = new Date()) => {
  if (session.status === 'cancelled' && session.cancellationReason !== 'late_paid'
    && session.payment === 'unpaid') {
    return { kind: 'quiet', label: 'bez opłaty', tone: 'ink' }
  }
  const current = now instanceof Date
    ? warsawDateTimeFromUtc(now.toISOString())
    : { date: now, time: '23:59', second: '59' }
  const sessionTime = session.time || '00:00'
  if (session.status === 'scheduled' && session.payment === 'unpaid'
    && `${session.date}T${sessionTime}:00` > `${current.date}T${current.time}:${current.second}`) return null
  return {
    kind: 'payment',
    label: PAY_LABELS[session.payment],
    tone: session.payment === 'paid' ? 'sage' : 'amber',
  }
}

export const collectedOf = (s) => {
  if (!isBillable(s)) return 0
  if (s.payment === 'paid') return s.amount
  if (s.payment === 'partial') return s.paidAmount || 0
  return 0
}

export const outstandingOf = (s) => (isBillable(s) ? s.amount - collectedOf(s) : 0)

export const billableSummary = (sessions) => {
  const billableSessions = sessions.filter(isBillable)
  const revenue = billableSessions.reduce((total, session) => total + session.amount, 0)
  const collected = billableSessions.reduce((total, session) => total + collectedOf(session), 0)
  return {
    billable: billableSessions.length,
    revenue,
    collected,
    outstanding: revenue - collected,
  }
}

export const greeting = (h = new Date().getHours()) =>
  h < 5 ? 'Dobry wieczór' : h < 18 ? 'Dzień dobry' : 'Dobry wieczór'
