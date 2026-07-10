// Formatting helpers — Polish locale throughout.

const moneyFmt = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'PLN',
  maximumFractionDigits: 0,
})

export const fmtMoney = (n) => moneyFmt.format(Math.round(n || 0))

export const fmtNumber = (n) => new Intl.NumberFormat('pl-PL').format(n)

export const pad2 = (n) => String(n).padStart(2, '0')

export const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

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
// locative case for prose ("w lipcu") — Intl only provides the nominative
const MONTHS_LOC = ['styczniu', 'lutym', 'marcu', 'kwietniu', 'maju', 'czerwcu', 'lipcu', 'sierpniu', 'wrześniu', 'październiku', 'listopadzie', 'grudniu']
export const fmtMonthLocative = (ym) => MONTHS_LOC[Number(ym.slice(5, 7)) - 1]
export const fmtDayMonth = (iso) => dayMonthFmt.format(parseISO(iso))
export const fmtFullDate = (iso) => fullDateFmt.format(parseISO(iso))
export const fmtWeekday = (iso) => weekdayFmt.format(parseISO(iso))
export const fmtShortDate = (iso) => shortDateFmt.format(parseISO(iso))

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
  scheduled: 'pill--rose',
  completed: 'pill--sage',
  cancelled: 'pill--mauve',
  noshow: 'pill--error',
}

export const PAY_LABELS = {
  paid: 'Opłacona',
  unpaid: 'Nieopłacona',
  partial: 'Częściowo',
}

export const PAY_PILL = {
  paid: 'pill--sage',
  unpaid: 'pill--error',
  partial: 'pill--gold',
}

// Billing rules: completed + no-show sessions are billed; cancelled are not.
export const isBillable = (s) => s.status === 'completed' || s.status === 'noshow'

export const collectedOf = (s) => {
  if (!isBillable(s)) return 0
  if (s.payment === 'paid') return s.amount
  if (s.payment === 'partial') return s.paidAmount || 0
  return 0
}

export const outstandingOf = (s) => (isBillable(s) ? s.amount - collectedOf(s) : 0)

export const greeting = (h = new Date().getHours()) =>
  h < 5 ? 'Dobry wieczór' : h < 18 ? 'Dzień dobry' : 'Dobry wieczór'
