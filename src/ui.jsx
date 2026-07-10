import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { initials, fmtNumber } from './format.js'
import { useToasts } from './store.jsx'
import { useMagnetic, useCountUp, motionOK } from './anim.js'

export function Button({ children, icon, variant = 'primary', size, magnetic, className = '', ...rest }) {
  const magRef = useMagnetic(0.22)
  const cls = [
    'btn',
    `btn--${variant}`,
    size ? `btn--${size}` : '',
    className,
  ].join(' ')
  return (
    <button type="button" ref={magnetic ? magRef : undefined} className={cls} {...rest}>
      {icon && <Icon name={icon} size={17} />}
      {children && <span>{children}</span>}
    </button>
  )
}

export function IconBtn({ name, label, size = 19, className = '', ...rest }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      <Icon name={name} size={size} />
    </button>
  )
}

export function Pill({ tone = 'ink', children, dot, onClick, className = '', ...rest }) {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`pill pill--${tone} ${onClick ? 'pill--btn' : ''} ${className}`}
      onClick={onClick}
      {...rest}
    >
      {dot && <span className="dot" />}
      {children}
    </Tag>
  )
}

export function Chip({ on, children, swatch, ...rest }) {
  return (
    <button type="button" className={`chip ${on ? 'is-on' : ''}`} aria-pressed={!!on} {...rest}>
      {swatch && <span className="swatch" style={{ background: swatch }} />}
      {children}
    </button>
  )
}

export function Segmented({ options, value, onChange, ariaLabel }) {
  const wrapRef = useRef(null)
  const [thumb, setThumb] = useState(null)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const measure = () => {
      const idx = options.findIndex((o) => o.value === value)
      const btn = wrap.querySelectorAll('.seg__opt')[idx]
      // track top/height too — on phones the options can wrap to a second row
      if (btn) setThumb({ left: btn.offsetLeft, width: btn.offsetWidth, top: btn.offsetTop, height: btn.offsetHeight })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [value, options])

  // radio-style keyboard model: one tab stop, arrows move the selection
  const move = (dir) => {
    const idx = options.findIndex((o) => o.value === value)
    const next = (idx + dir + options.length) % options.length
    onChange(options[next].value)
    requestAnimationFrame(() => wrapRef.current?.querySelectorAll('.seg__opt')[next]?.focus())
  }

  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel} ref={wrapRef}>
      {thumb && <span className="seg__thumb" style={{ left: thumb.left, width: thumb.width, top: thumb.top, height: thumb.height }} />}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className={`seg__opt ${o.value === value ? 'is-on' : ''}`}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
          }}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
        >
          {o.icon && <Icon name={o.icon} size={15} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, error, hint, children, className = '', span2 }) {
  const autoId = useId()
  const descId = useId()
  let child = children
  let labelFor
  if (
    isValidElement(children) &&
    typeof children.type === 'string' &&
    ['input', 'select', 'textarea'].includes(children.type)
  ) {
    labelFor = children.props.id || autoId
    child = cloneElement(children, {
      id: labelFor,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': error ? descId : hint ? descId : undefined,
    })
  }
  return (
    <div className={`field ${error ? 'has-error' : ''} ${span2 ? 'span2' : ''} ${className}`}>
      {label && <label className="field__label" htmlFor={labelFor}>{label}</label>}
      {child}
      {hint && !error && <span className="field__hint" id={descId}>{hint}</span>}
      {error && (
        <span className="field__error" id={descId}>
          <Icon name="alert" size={13} /> {error}
        </span>
      )}
    </div>
  )
}

// one entry in a figures line — a quiet, optionally linked number that
// replaces equal-weight KPI cards (dashboard, finances, reports)
export function Figure({ label, value, fmt = fmtNumber, suffix, sub, gold, onClick }) {
  const ref = useCountUp(value, fmt)
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`figures__item ${gold ? 'figures__item--gold' : ''}`}
      onClick={onClick}
      data-reveal
    >
      <span className="figures__label">{label}</span>
      <span className="figures__value">
        <span ref={ref}>0</span>
        {suffix && <small>{suffix}</small>}
      </span>
      {sub && <span className="figures__sub">{sub}</span>}
    </Tag>
  )
}

export function Check({ checked, onChange, children }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="check__box">
        <Icon name="check" size={12} strokeWidth={2.6} />
      </span>
      {children}
    </label>
  )
}

export function Toggle({ on, onChange, label, disabled }) {
  return (
    <button
      type="button"
      className={`toggle ${on ? 'is-on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  )
}

export function Avatar({ name, color = '#964d5f', size = 38 }) {
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: `linear-gradient(135deg, ${color}, ${color}cc)`,
      }}
    >
      {initials(name)}
    </span>
  )
}

// Lightweight popover (status pickers, menus). Closes on outside click / Esc.
// Positioned with fixed viewport coordinates so it escapes scroll containers
// (.table-scroll) and flips/clamps instead of clipping at viewport edges.
export function Popover({ trigger, children, align = 'left', ariaLabel, open, setOpen }) {
  const ref = useRef(null)
  const popRef = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const wrap = ref.current
    const pop = popRef.current
    if (!wrap || !pop) return
    const r = wrap.getBoundingClientRect()
    const margin = 8
    let left = align === 'right' ? r.right - pop.offsetWidth : r.left
    left = Math.max(margin, Math.min(left, window.innerWidth - pop.offsetWidth - margin))
    let top = r.bottom + 7
    if (top + pop.offsetHeight > window.innerHeight - margin) top = r.top - pop.offsetHeight - 7
    top = Math.max(margin, top)
    setPos({ left, top })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        // menu contract: Escape hands focus back to the trigger
        ref.current?.querySelector('button, [tabindex]')?.focus()
      }
      // expected menu keyboard model: arrows walk the items
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(popRef.current?.querySelectorAll('.popover__item') || [])]
        if (!items.length) return
        e.preventDefault()
        const idx = items.indexOf(document.activeElement)
        const next = e.key === 'ArrowDown'
          ? items[Math.min(idx + 1, items.length - 1)] || items[0]
          : idx <= 0 ? items[items.length - 1] : items[idx - 1]
        next.focus()
      }
    }
    // fixed coordinates go stale the moment anything scrolls or resizes
    const onMove = () => setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open, setOpen])

  useEffect(() => {
    if (!open || !motionOK()) return
    const el = popRef.current
    if (el) window.gsap.fromTo(el, { autoAlpha: 0, y: -6, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: 'power3.out' })
  }, [open])

  const wiredTrigger = isValidElement(trigger)
    ? cloneElement(trigger, { 'aria-expanded': !!open, 'aria-haspopup': 'menu' })
    : trigger

  return (
    <span className="pop-wrap" ref={ref}>
      {wiredTrigger}
      {open && (
        <div
          className="popover"
          role="menu"
          aria-label={ariaLabel}
          ref={popRef}
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: 'hidden' }}
        >
          {children}
        </div>
      )}
    </span>
  )
}

export function PopItem({ on, role = 'menuitemradio', pressed, children, ...rest }) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitemradio' ? !!on : undefined}
      aria-pressed={pressed ? !!on : undefined}
      className={`popover__item ${on ? 'is-on' : ''}`}
      {...rest}
    >
      {children}
    </button>
  )
}

// Friendly empty state — icon, one line, optional hint + primary action.
export function EmptyState({ icon = 'sparkle', title, hint, action, compact }) {
  return (
    <div className={`empty ${compact ? 'empty--sm' : ''}`}>
      <span className="empty__icon">
        <Icon name={icon} size={compact ? 18 : 22} />
      </span>
      <div className="empty__title">{title}</div>
      {hint && <div className="empty__hint">{hint}</div>}
      {action}
    </div>
  )
}

// Tiny "?" tooltip for less obvious controls. Keyboard- and touch-accessible
// (shows on hover and focus, Escape dismisses by blurring). The bubble is
// centered but nudged back inside the viewport when the trigger sits near
// an edge (stat cards in the phone's 2-up grid).
export function InfoTip({ text }) {
  const id = useId()
  const ref = useRef(null)
  const [shift, setShift] = useState(0)
  const reposition = () => {
    const el = ref.current
    const bubble = el?.querySelector('.tip__bubble')
    if (!el || !bubble) return
    const r = el.getBoundingClientRect()
    const center = r.left + r.width / 2
    const half = bubble.offsetWidth / 2
    const margin = 10
    let dx = 0
    if (center - half < margin) dx = margin - (center - half)
    else if (center + half > window.innerWidth - margin) dx = window.innerWidth - margin - (center + half)
    setShift(Math.round(dx))
  }
  return (
    <button
      type="button"
      className="tip"
      ref={ref}
      aria-label="Wyjaśnienie"
      aria-describedby={id}
      onMouseEnter={reposition}
      onFocus={reposition}
      onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur() }}
    >
      <Icon name="help" size={14} />
      <span className="tip__bubble" role="tooltip" id={id} style={shift ? { marginLeft: shift } : undefined}>
        {text}
      </span>
    </button>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Szukaj…' }) {
  return (
    <div className="search">
      <Icon name="search" size={17} />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={placeholder}
      />
    </div>
  )
}

function ToastItem({ toast, onDismiss }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!motionOK() || !ref.current) return
    window.gsap.fromTo(
      ref.current,
      { autoAlpha: 0, y: 18, scale: 0.94 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: 'back.out(1.6)' }
    )
  }, [])
  useEffect(() => {
    if (!toast.leaving || !motionOK() || !ref.current) return
    window.gsap.to(ref.current, { autoAlpha: 0, y: 12, scale: 0.95, duration: 0.28, ease: 'power2.in' })
  }, [toast.leaving])
  return (
    <div className="toast" ref={ref} onClick={onDismiss} title="Zamknij">
      <Icon name={toast.icon} size={16} />
      {toast.msg}
    </div>
  )
}

export function ToastHost() {
  const { toasts, dismissToast } = useToasts()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  )
}
