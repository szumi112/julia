import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { initials } from './format.js'
import { useApp } from './store.jsx'
import { useMagnetic, motionOK } from './anim.js'

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
    const idx = options.findIndex((o) => o.value === value)
    const btn = wrap.querySelectorAll('.seg__opt')[idx]
    if (btn) setThumb({ left: btn.offsetLeft, width: btn.offsetWidth })
  }, [value, options])

  return (
    <div className="seg" role="group" aria-label={ariaLabel} ref={wrapRef}>
      {thumb && <span className="seg__thumb" style={{ left: thumb.left, width: thumb.width }} />}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`seg__opt ${o.value === value ? 'is-on' : ''}`}
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
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
  let child = children
  let labelFor
  if (
    isValidElement(children) &&
    typeof children.type === 'string' &&
    ['input', 'select', 'textarea'].includes(children.type)
  ) {
    labelFor = children.props.id || autoId
    child = cloneElement(children, { id: labelFor })
  }
  return (
    <div className={`field ${error ? 'has-error' : ''} ${span2 ? 'span2' : ''} ${className}`}>
      {label && <label className="field__label" htmlFor={labelFor}>{label}</label>}
      {child}
      {hint && !error && <span className="field__hint">{hint}</span>}
      {error && (
        <span className="field__error">
          <Icon name="alert" size={13} /> {error}
        </span>
      )}
    </div>
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

export function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button"
      className={`toggle ${on ? 'is-on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  )
}

export function Avatar({ name, color = '#a4596b', size = 38 }) {
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
export function Popover({ trigger, children, align = 'left', open, setOpen }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  useEffect(() => {
    if (!open || !motionOK()) return
    const el = ref.current?.querySelector('.popover')
    if (el) window.gsap.fromTo(el, { autoAlpha: 0, y: -6, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: 'power3.out' })
  }, [open])

  return (
    <span className="pop-wrap" ref={ref}>
      {trigger}
      {open && <div className={`popover ${align === 'right' ? 'popover--right' : ''}`}>{children}</div>}
    </span>
  )
}

export function PopItem({ on, children, ...rest }) {
  return (
    <button type="button" className={`popover__item ${on ? 'is-on' : ''}`} {...rest}>
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
// (shows on hover and focus, Escape dismisses by blurring).
export function InfoTip({ text }) {
  const id = useId()
  return (
    <button
      type="button"
      className="tip"
      aria-label="Wyjaśnienie"
      aria-describedby={id}
      onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur() }}
    >
      <Icon name="help" size={14} />
      <span className="tip__bubble" role="tooltip" id={id}>{text}</span>
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

function ToastItem({ toast }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!motionOK() || !ref.current) return
    window.gsap.fromTo(
      ref.current,
      { autoAlpha: 0, y: 18, scale: 0.94 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: 'back.out(1.6)' }
    )
  }, [])
  return (
    <div className="toast" ref={ref} role="status">
      <Icon name={toast.icon} size={16} />
      {toast.msg}
    </div>
  )
}

export function ToastHost() {
  const { toasts } = useApp()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
