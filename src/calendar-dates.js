// Pure date labels and day selection for the Grafik view (no JSX, so node --test
// can import it). Years are shown only outside the current year.
import { cap, fmtDayMonth, fmtFullDate, fmtWeekRange, fmtWeekday, monthKey } from './format.js'

// "7 – 13 września", "11 – 17 marca 2024", "29 grudnia 2025 – 4 stycznia 2026"
export function weekRangeLabel(startIso, endIso, currentYear) {
  const current = String(currentYear)
  const startYear = startIso.slice(0, 4)
  const endYear = endIso.slice(0, 4)
  if (startYear === current && endYear === current) return fmtWeekRange(startIso, endIso)
  if (startYear === endYear) return `${fmtWeekRange(startIso, endIso)} ${endYear}`
  return `${fmtFullDate(startIso)} – ${fmtFullDate(endIso)}`
}

// "Czwartek, 14 marca" / "Czwartek, 14 marca 2024"
export function dayHeadingLabel(iso, currentYear) {
  const date = iso.slice(0, 4) === String(currentYear) ? fmtDayMonth(iso) : fmtFullDate(iso)
  return `${cap(fmtWeekday(iso))}, ${date}`
}

export function firstSessionDayInMonth(ym, sessions) {
  return sessions
    .filter((session) => session.date?.startsWith(`${ym}-`))
    .map((session) => session.date)
    .sort()[0] || `${ym}-01`
}

// The day a month switch selects: today in the current month, otherwise the
// first day with sessions, otherwise the 1st.
export function monthSelectionDay(ym, sessions, today) {
  return monthKey(today) === ym ? today : firstSessionDayInMonth(ym, sessions)
}
