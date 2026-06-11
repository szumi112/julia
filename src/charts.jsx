// Hand-rolled SVG data-viz, animated with GSAP.
import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtMoney, fmtMonthName, cap } from './format.js'
import { motionOK } from './anim.js'

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

export function AreaChart({ data, height = 230, valueKey = 'revenue', fmt = fmtMoney }) {
  const wrapRef = useRef(null)
  const lineRef = useRef(null)
  const fillRef = useRef(null)
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
    const len = path.getTotalLength()
    window.gsap.fromTo(
      path,
      { strokeDasharray: len, strokeDashoffset: len },
      { strokeDashoffset: 0, duration: 1.6, ease: 'power3.inOut', delay: 0.15 }
    )
    window.gsap.fromTo(fill, { opacity: 0 }, { opacity: 1, duration: 1.1, delay: 0.7 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, data])

  const onMove = (e) => {
    const rect = wrapRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    let best = 0
    pts.forEach((p, i) => { if (Math.abs(p[0] - x) < Math.abs(pts[best][0] - x)) best = i })
    setHover(best)
  }

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative' }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Wykres przychodów">
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c2808d" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#c2808d" stopOpacity="0.015" />
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
        <path ref={fillRef} d={area} fill="url(#areaFill)" />
        <path
          ref={lineRef}
          d={line}
          fill="none"
          stroke="#a4596b"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        {pts.map((p, i) => (
          <g key={i}>
            <circle
              cx={p[0]}
              cy={p[1]}
              r={hover === i ? 5.5 : i === pts.length - 1 ? 4.5 : 3}
              fill={i === pts.length - 1 ? '#ac8a4e' : '#a4596b'}
              stroke="#fcfaf5"
              strokeWidth="2"
              style={{ transition: 'r .18s' }}
            />
            <text
              x={p[0]}
              y={height - 8}
              textAnchor="middle"
              fontSize="11"
              fontWeight={i === pts.length - 1 ? 700 : 500}
              fill={i === pts.length - 1 ? '#86683a' : '#a08e96'}
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
            stroke="rgba(164,89,107,0.25)"
            strokeWidth="1.2"
          />
        )}
      </svg>
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

export function Sparkline({ values, color = '#a4596b', w = 74, h = 26 }) {
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const pts = values.map((v, i) => [
    2 + ((w - 4) * i) / Math.max(values.length - 1, 1),
    h - 3 - ((h - 6) * (v - min)) / Math.max(max - min, 1),
  ])
  return (
    <svg width={w} height={h} className="stat__spark" aria-hidden="true">
      <path d={smoothPath(pts)} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" opacity="0.55" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.6" fill={color} />
    </svg>
  )
}

export function Donut({ parts, size = 190, thickness = 26, centerTop, centerBottom }) {
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
      { opacity: 0, svgOrigin: `${size / 2} ${size / 2}`, rotation: -14 },
      { opacity: 1, rotation: 0, duration: 1.1, ease: 'power3.out', stagger: 0.1 }
    )
  }, [size, parts.length])

  return (
    <div style={{ position: 'relative', width: size, height: size }} ref={ref}>
      <svg width={size} height={size} role="img" aria-label="Udział przychodów">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#efe6d8" strokeWidth={thickness} />
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
    if (!ref.current) return
    if (!motionOK()) {
      ref.current.style.width = pct + '%'
      return
    }
    window.gsap.fromTo(
      ref.current,
      { width: '0%' },
      { width: pct + '%', duration: 1.2, ease: 'power3.out', delay: 0.2 }
    )
  }, [pct])
  const sum = Math.max(segments.reduce((a, s) => a + s.value, 0), 1)
  return (
    <div className="hbar__fill" ref={ref} style={{ width: 0 }}>
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
