// Hand-drawn line icon set — 24px grid, 1.7 stroke, round caps.

const PATHS = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="3.5" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8.2" r="3.4" />
      <path d="M3.2 19.5c.5-3.4 2.9-5.2 5.8-5.2s5.3 1.8 5.8 5.2" />
      <circle cx="17" cy="9.4" r="2.6" />
      <path d="M16.6 14.6c2.4.3 4 1.7 4.4 4.2" />
    </>
  ),
  clients: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.8" />
      <circle cx="9" cy="10.4" r="2.1" />
      <path d="M5.8 15.9c.7-1.5 1.9-2.2 3.2-2.2s2.5.7 3.2 2.2" />
      <path d="M14.8 9.3h3.5M14.8 13h2.4" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.8" />
      <path d="M3.5 10h17M8.2 3v4M15.8 3v4" />
      <circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  payments: (
    <>
      <path d="M3.5 9c0-1.5 1.2-2.7 2.7-2.7h11.6c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7V9z" />
      <path d="M16.5 6.3V5.2c0-1.2-1.1-2-2.2-1.7L5 5.8" />
      <path d="M20.5 11.2h-3.6a2 2 0 100 4h3.6" />
    </>
  ),
  reports: (
    <>
      <path d="M4.5 20.5v-7M10 20.5V8.5M15.5 20.5v-9.5M21 20.5V5" />
      <path d="M3 20.5h18" opacity="0" />
    </>
  ),
  settings: (
    <>
      <path d="M3.5 7.7h9.1M17.5 7.7h3M3.5 16.3h3M11.5 16.3h9" />
      <circle cx="15.2" cy="7.7" r="2.3" />
      <circle cx="9" cy="16.3" r="2.3" />
    </>
  ),
  logout: (
    <>
      <path d="M14.5 8.2V6.4c0-1.3-1-2.4-2.4-2.4H6.4C5 4 4 5.1 4 6.4v11.2C4 18.9 5 20 6.4 20h5.7c1.3 0 2.4-1.1 2.4-2.4v-1.8" />
      <path d="M9.5 12h10.5M17 9l3 3-3 3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20.5 20.5" />
    </>
  ),
  chevL: <path d="M14.5 6l-6 6 6 6" />,
  chevR: <path d="M9.5 6l6 6-6 6" />,
  chevD: <path d="M6 9.5l6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2.2" />
    </>
  ),
  phone: (
    <path d="M5.5 4h3l1.5 4-2 1.5a11.5 11.5 0 005.5 5.5l1.5-2 4 1.5v3c0 1-.8 1.9-1.9 1.8C10.4 18.7 5.3 13.6 4.7 6.4 4.6 5.1 4.5 4 5.5 4z" />
  ),
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.6" />
      <path d="M3.5 7.5l7.4 5.4c.65.47 1.55.47 2.2 0l7.4-5.4" />
    </>
  ),
  edit: (
    <>
      <path d="M14.5 5.5l4 4L8 20H4v-4L14.5 5.5z" />
      <path d="M12.5 7.5l4 4" />
    </>
  ),
  print: (
    <>
      <path d="M7 8V3.5h10V8" />
      <rect x="3.5" y="8" width="17" height="8.5" rx="2" />
      <path d="M7 14h10v6.5H7z" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11M7.5 11l4.5 4.5L16.5 11" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.2 8.3A8 8 0 105.7 17" />
      <path d="M19.2 4.7v3.6h-3.6" />
    </>
  ),
  arrowL: <path d="M19 12H5M11 6l-6 6 6 6" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="8.7" />
      <path d="M12 7.6v5.2" />
      <circle cx="12" cy="16.2" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.4" r="3.6" />
      <path d="M5 20c.7-3.7 3.4-5.7 7-5.7s6.3 2 7 5.7" />
    </>
  ),
  room: (
    <>
      <path d="M4 20.5V5.4c0-1 .7-1.8 1.7-2L14 2v18.5" />
      <path d="M14 6.5l4.4 1.2c.9.2 1.6 1 1.6 2v10.8" />
      <path d="M2.5 20.5h19" />
      <circle cx="11.3" cy="11.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  sparkle: (
    <path d="M12 3.5c.7 4.2 2.4 5.9 6.5 6.5-4.1.6-5.8 2.3-6.5 6.5-.7-4.2-2.4-5.9-6.5-6.5 4.1-.6 5.8-2.3 6.5-6.5zM18.5 15c.35 2 1.2 2.85 3 3.2-1.8.35-2.65 1.2-3 3.2-.35-2-1.2-2.85-3-3.2 1.8-.35 2.65-1.2 3-3.2z" />
  ),
  wave: <path d="M3 12c2.5 0 2.5-3.5 5-3.5S10.5 12 13 12s2.5-3.5 5-3.5 2.5 3.5 5 3.5" />,
  help: (
    <>
      <circle cx="12" cy="12" r="8.7" />
      <path d="M9.6 9.6c.1-1.4 1.2-2.4 2.5-2.4 1.4 0 2.5 1 2.5 2.3 0 1.8-2.2 2-2.4 3.7" />
      <circle cx="12.1" cy="16.3" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.3 7V5.4c0-.8.6-1.4 1.4-1.4h2.6c.8 0 1.4.6 1.4 1.4V7" />
      <path d="M6.3 7l.8 11.4c.1 1 .9 1.8 1.9 1.8h6c1 0 1.8-.8 1.9-1.8L17.7 7" />
      <path d="M10 10.8v4.6M14 10.8v4.6" />
    </>
  ),
  pin: (
    <>
      <path d="M9.2 3.8h5.6l-.5 5.4 2.8 2.8.4 1.6H6.5l.4-1.6 2.8-2.8-.5-5.4z" />
      <path d="M12 13.6v6.6" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h12.5M4 17h16" />,
  filter: <path d="M4 6h16M7.5 12h9M10.5 18h3" />,
  group: (
    <>
      <circle cx="12" cy="7.4" r="2.9" />
      <circle cx="5.9" cy="9.8" r="2.3" />
      <circle cx="18.1" cy="9.8" r="2.3" />
      <path d="M8.3 19.8c.5-2.9 1.9-4.4 3.7-4.4s3.2 1.5 3.7 4.4" />
      <path d="M2.8 18.6c.4-2.4 1.6-3.7 3.4-3.7" />
      <path d="M21.2 18.6c-.4-2.4-1.6-3.7-3.4-3.7" />
    </>
  ),
}

export function Icon({ name, size = 20, strokeWidth = 1.7, className, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {PATHS[name] || null}
    </svg>
  )
}

// The Bear with me mark: two arches and a dot, in the four brand hues.
// Fixed hex rather than tokens — a logotype keeps its colours on any surface,
// including the dark sidebar and the login card.
export function BearMark({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <g fill="none" strokeLinecap="round">
        <path d="M11 39V23a8.5 8.5 0 0 1 17 0v16" stroke="#e88aac" strokeWidth="6" />
        <path d="M19.5 39V27.5a4.6 4.6 0 0 1 9.2 0" stroke="#ed9936" strokeWidth="5.4" />
        <path d="M33.5 17.5 39 38" stroke="#ed5a39" strokeWidth="6" />
      </g>
      <circle cx="31.5" cy="34.5" r="3.2" fill="#b2d9ea" />
    </svg>
  )
}
