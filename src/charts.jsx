// Hand-rolled SVG data-viz, animated with GSAP.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { fmtMoney, fmtMonthName, cap } from './format.js'
import { motionOK } from './anim.js'

// Chart colors come from the same custom properties the CSS uses; read lazily
// (first render happens after the stylesheet is in place) and memoized.
const tokens = {}
export const tok = (name, fallback) => {
  if (!(name in tokens)) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    tokens[name] = v || fallback
  }
  return tokens[name]
}

// Catmull-Rom → cubic bezier smooth path
const smoothPath = (pts) => {
  if (pts.length < 2) return ''
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`
  }
  return d
}

export function AreaChart({ data, height = 230, valueKey = 'revenue', fmt = fmtMoney, label = 'Wykres przychodów' }) {
  const wrapRef = useRef(null)
  const lineRef = useRef(null)
  const fillRef = useRef(null)
  const gradId = useId().replace(/:/g, '')
  const [hover, setHover] = useState(null)
  const [width, setWidth] = useState(640)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 640))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pad = { l: 14, r: 14, t: 18, b: 30 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b
  const max = Math.max(...data.map((d) => d[valueKey]), 1) * 1.15

  const pts = useMemo(
    () =>
      data.map((d, i) => [
        pad.l + (innerW * i) / Math.max(data.length - 1, 1),
        pad.t + innerH - (innerH * d[valueKey]) / max,
      ]),
    [data, innerW, innerH, max, valueKey]
  )

  const line = smoothPath(pts)
  const area = `${line} L ${pts[pts.length - 1][0]} ${pad.t + innerH} L ${pts[0][0]} ${pad.t + innerH} Z`

  useEffect(() => {
    const path = lineRef.current
    const fill = fillRef.current
    if (!path || !motionOK()) return
    window.gsap.fromTo(
      path,
      { scaleY: 0.96, transformOrigin: 'center center' },
      { scaleY: 1, duration: 0.2, ease: 'power2.out', clearProps: 'transform' }
    )
    window.gsap.fromTo(
      fill,
      { scaleY: 0.98, transformOrigin: 'center bottom' },
      { scaleY: 1, duration: 0.18, ease: 'power2.out', clearProps: 'transform' }
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, data])

  // pointer events cover mouse and touch; arrows cover the keyboard
  const onPoint = (e) => {
    const rect = wrapRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    let best = 0
    pts.forEach((p, i) => { if (Math.abs(p[0] - x) < Math.abs(pts[best][0] - x)) best = i })
    setHover(best)
  }
  const onKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setHover((h) => {
      const cur = h ?? data.length - 1
      return e.key === 'ArrowRight' ? Math.min(cur + 1, data.length - 1) : Math.max(cur - 1, 0)
    })
  }

  const rose = tok('--rose', '#c2808d')
  const roseDeep = tok('--rose-deep', '#964d5f')
  const gold = tok('--gold', '#ac8a4e')
  const goldDeep = tok('--gold-deep', '#7d5f33')
  const faint = tok('--ink-faint', '#7a6871')
  const surface = tok('--surface', '#fcfaf5')

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative' }}
      tabIndex={0}
      aria-label={`${label} — strzałki w lewo i w prawo przeglądają wartości`}
      onPointerMove={onPoint}
      onPointerDown={onPoint}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKey}
      onFocus={() => setHover((h) => h ?? data.length - 1)}
      onBlur={() => setHover(null)}
    >
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={rose} stopOpacity="0.32" />
            <stop offset="100%" stopColor={rose} stopOpacity="0.015" />
          </linearGradient>
        </defs>
        {/* horizontal guides */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={pad.l}
            x2={width - pad.r}
            y1={pad.t + innerH * f}
            y2={pad.t + innerH * f}
            stroke="rgba(58,44,50,0.06)"
            strokeDasharray="3 5"
          />
        ))}
        <path ref={fillRef} d={area} fill={`url(#${gradId})`} />
        <path
          ref={lineRef}
          d={line}
          fill="none"
          stroke={roseDeep}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        {pts.map((p, i) => (
          <g key={i}>
            <circle
              cx={p[0]}
              cy={p[1]}
              r={hover === i ? 5.5 : i === pts.length - 1 ? 4.5 : 3}
              fill={i === pts.length - 1 ? gold : roseDeep}
              stroke={surface}
              strokeWidth="2"
              style={{ transition: 'r .18s' }}
            />
            <text
              x={p[0]}
              y={height - 8}
              textAnchor="middle"
              fontSize="11"
              fontWeight={i === pts.length - 1 ? 700 : 500}
              fill={i === pts.length - 1 ? goldDeep : faint}
            >
              {cap(fmtMonthName(data[i].ym)).slice(0, 3)}
            </text>
          </g>
        ))}
        {hover != null && (
          <line
            x1={pts[hover][0]}
            x2={pts[hover][0]}
            y1={pad.t - 4}
            y2={pad.t + innerH}
            stroke="rgba(150,77,95,0.3)"
            strokeWidth="1.2"
          />
        )}
      </svg>
      {/* the same numbers, readable without a pointer */}
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.ym}>
              <th scope="row">{cap(fmtMonthName(d.ym))}</th>
              <td>{fmt(d[valueKey])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="chart-tip"
        style={
          hover != null
            ? { left: pts[hover][0], top: pts[hover][1], opacity: 1 }
            : { left: 0, top: 0 }
        }
      >
        {hover != null && (
          <>
            <small>{cap(fmtMonthName(data[hover].ym))}</small>
            {fmt(data[hover][valueKey])}
          </>
        )}
      </div>
    </div>
  )
}

export function Donut({ parts, size = 190, thickness = 26, centerTop, centerBottom, fmt = fmtMoney, label = 'Udział przychodów' }) {
  const ref = useRef(null)
  const total = Math.max(parts.reduce((a, p) => a + p.value, 0), 1)
  const r = (size - thickness) / 2
  const C = 2 * Math.PI * r
  let acc = 0

  useEffect(() => {
    if (!motionOK() || !ref.current) return
    const segs = ref.current.querySelectorAll('.donut-seg')
    window.gsap.fromTo(
      segs,
      { svgOrigin: `${size / 2} ${size / 2}`, rotation: -6 },
      { rotation: 0, duration: 0.18, ease: 'power3.out', stagger: { amount: 0.05 } }
    )
  }, [size, parts.length])

  return (
    <div style={{ position: 'relative', width: size, height: size }} ref={ref}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tok('--paper-deep', '#efe6d8')} strokeWidth={thickness} />
        {parts.map((p, i) => {
          const frac = p.value / total
          const dash = `${Math.max(frac * C - 5, 0.01)} ${C}`
          const rot = (acc / total) * 360 - 90
          acc += p.value
          return (
            <circle
              key={i}
              className="donut-seg"
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={p.color}
              strokeWidth={thickness}
              strokeDasharray={dash}
              strokeLinecap="round"
              transform={`rotate(${rot} ${size / 2} ${size / 2})`}
            />
          )
        })}
      </svg>
      {/* per-part values for assistive tech (the legend carries only percentages) */}
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {parts.map((p, i) => (
            <tr key={i}>
              <th scope="row">{p.label}</th>
              <td>{fmt(p.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeContent: 'center',
          textAlign: 'center',
        }}
      >
        <div className="num" style={{ fontSize: 26, fontWeight: 470 }}>{centerTop}</div>
        <div className="faint" style={{ fontSize: 11.5, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 650 }}>
          {centerBottom}
        </div>
      </div>
    </div>
  )
}

// Animated horizontal bar fill (single or stacked segments)
export function BarFill({ segments, totalMax }) {
  const ref = useRef(null)
  const pct = Math.min(
    (segments.reduce((a, s) => a + s.value, 0) / Math.max(totalMax, 1)) * 100,
    100
  )
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Data lands immediately; a slight compositor-only scale adds polish.
    if (!motionOK()) return
    window.gsap.fromTo(
      el,
      { scaleX: 0.96, transformOrigin: 'left center' },
      { scaleX: 1, duration: 0.18, ease: 'power3.out', clearProps: 'transform' }
    )
  }, [pct])
  const sum = Math.max(segments.reduce((a, s) => a + s.value, 0), 1)
  return (
    <div className="hbar__fill" ref={ref} style={{ width: `${pct}%` }}>
      {segments.map((s, i) => (
        <span
          key={i}
          className="hbar__seg"
          style={{
            width: `${(s.value / sum) * 100}%`,
            background: s.color,
            borderRadius: i === 0 ? '8px 0 0 8px' : i === segments.length - 1 ? '0 8px 8px 0' : 0,
          }}
          title={s.label}
        />
      ))}
    </div>
  )
}
