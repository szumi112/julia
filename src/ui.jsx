import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './icons.jsx'
import { initials, fmtNumber } from './format.js'
import { useToasts } from './store.jsx'
import { useMagnetic, useCountUp, motionOK } from './anim.js'
import { pageCount, pageSlice } from './pagination.js'

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

export function TableScroll({ children, label }) {
  return <div
    className="table-scroll"
    role="region"
    aria-label={label}
    tabIndex={0}
    onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault()
      event.currentTarget.scrollLeft += event.key === 'ArrowRight' ? 96 : -96
    }}
  >{children}</div>
}

export function IconBtn({ name, label, size = 19, className = '', ...rest }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      <Icon name={name} size={size} />
    </button>
  )
}

// Two-step discard for dirty forms: the first close attempt (backdrop, Esc,
// Anuluj, ✕) opens an inline confirm instead of silently dropping entered
// data. `guard` gates the drawer close, `check` answers "is dirty?" for the
// shell's leave guard (browser back / role switch).
export function useDiscardGuard(dirty) {
  const [confirming, setConfirming] = useState(false)
  const guard = useCallback(() => {
    if (!dirty) return true
    setConfirming(true)
    return false
  }, [dirty])
  const check = useCallback(() => dirty, [dirty])
  const hide = useCallback(() => setConfirming(false), [])
  return { confirming, guard, check, hide }
}

export function DiscardConfirm({ onStay, onDiscard }) {
  return (
    <div className="form-warn drawer__discard" role="alert">
      <Icon name="alert" size={16} />
      <span>Masz niezapisane zmiany.</span>
      <span className="drawer__discard-actions">
        <Button size="sm" variant="ghost" onClick={onStay}>Wróć</Button>
        <Button size="sm" variant="soft" onClick={onDiscard}>Odrzuć</Button>
      </span>
    </div>
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
  const thumbRef = useRef(null)
  const prevThumbRef = useRef(null)
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

  // transform-only FLIP: the layout snaps instantly, the thumb glides in from
  // the previous rect via translate/scale
  useLayoutEffect(() => {
    const el = thumbRef.current
    if (!el || !thumb) return
    const prev = prevThumbRef.current
    prevThumbRef.current = thumb
    if (!prev || !motionOK()) return
    const dx = prev.left - thumb.left
    const dy = prev.top - thumb.top
    const sx = thumb.width ? prev.width / thumb.width : 1
    const sy = thumb.height ? prev.height / thumb.height : 1
    if (!dx && !dy && sx === 1 && sy === 1) return
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
    requestAnimationFrame(() => {
      el.style.transition = ''
      el.style.transform = ''
    })
  }, [thumb])

  // radio-style keyboard model: one tab stop, arrows move the selection
  const move = (dir) => {
    const idx = options.findIndex((o) => o.value === value)
    const next = (idx + dir + options.length) % options.length
    onChange(options[next].value)
    requestAnimationFrame(() => wrapRef.current?.querySelectorAll('.seg__opt')[next]?.focus())
  }

  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel} ref={wrapRef}>
      {thumb && <span className="seg__thumb" ref={thumbRef} style={{ left: thumb.left, width: thumb.width, top: thumb.top, height: thumb.height }} />}
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

export function Tabs({ options, value, onChange, ariaLabel, children, className = '' }) {
  const baseId = useId()
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const listRef = useRef(null)
  const move = useCallback((index) => {
    const next = (index + options.length) % options.length
    onChange(options[next].value)
    requestAnimationFrame(() => listRef.current?.querySelectorAll('[role="tab"]')[next]?.focus())
  }, [onChange, options])

  return (
    <div className={`tabs ${className}`}>
      <div className="tabs__list" role="tablist" aria-label={ariaLabel} ref={listRef}>
        {options.map((option, index) => {
          const selected = index === selectedIndex
          return (
            <button
              key={option.value}
              type="button"
              id={`${baseId}-tab-${option.value}`}
              className={`tabs__tab ${selected ? 'is-on' : ''}`}
              role="tab"
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                  event.preventDefault()
                  move(selectedIndex + 1)
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  move(selectedIndex - 1)
                } else if (event.key === 'Home') {
                  event.preventDefault()
                  move(0)
                } else if (event.key === 'End') {
                  event.preventDefault()
                  move(options.length - 1)
                }
              }}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <div
        className="tabs__panel"
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${options[selectedIndex].value}`}
        tabIndex={0}
      >
        {children}
      </div>
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
      {/* a <label> only associates with native controls — compound children
          (Segmented, Check, custom rows) get a plain caption instead */}
      {label && (labelFor
        ? <label className="field__label" htmlFor={labelFor}>{label}</label>
        : <span className="field__label">{label}</span>)}
      {child}
      {hint && !error && <span className="field__hint" id={descId}>{hint}</span>}
      {error && (
        <span className="field__error" id={descId} role="alert">
          <Icon name="alert" size={13} /> {error}
        </span>
      )}
    </div>
  )
}

// one entry in a figures line — a quiet, optionally linked number that
// replaces equal-weight KPI cards (dashboard, finances, reports)
export function Figure({ label, value, fmt = fmtNumber, suffix, sub, attention, onClick }) {
  const ref = useCountUp(value, fmt)
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`figures__item ${attention ? 'figures__item--amber' : ''}`}
      onClick={onClick}
      data-reveal
    >
      <span className="figures__label">{label}</span>
      <span className="figures__value">
        <span ref={ref}>{fmt(value)}</span>
        {suffix && <small>{suffix}</small>}
      </span>
      {sub && <span className="figures__sub">{sub}</span>}
    </Tag>
  )
}

// Stat card — Figure's boxed sibling. Same count-up, but each metric sits in
// its own card so a grid of them reads as a summary you scan rather than a
// hairline-ruled row you read. `sub` carries the number's context.
export function Stat({ label, value, fmt = fmtNumber, sub, tone }) {
  const ref = useCountUp(value, fmt)
  return (
    <div className={`card stat card--lift ${tone ? `stat--${tone}` : ''}`} data-reveal>
      <div className="stat__label">{label}</div>
      <div className="stat__value"><span ref={ref}>{fmt(value)}</span></div>
      {sub && <div className="stat__sub">{sub}</div>}
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

export function Avatar({ name, color = '#b03a1c', size = 38, variant = 'solid' }) {
  const softVariant = variant !== 'solid'
  return (
    <span
      className={`avatar${softVariant ? ` avatar--${variant}` : ''}`}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        ...(softVariant ? {} : { background: `linear-gradient(135deg, ${color}, ${color}cc)` }),
      }}
    >
      {initials(name)}
    </span>
  )
}

// Lightweight popover (status pickers, menus). Closes on outside click / Esc.
// Positioned with fixed viewport coordinates so it escapes scroll containers
// (.table-scroll) and flips/clamps instead of clipping at viewport edges.
export function Popover({ trigger, children, align = 'left', ariaLabel, contentRole = 'menu', open, setOpen }) {
  const ref = useRef(null)
  const popRef = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const wrap = ref.current
    const pop = popRef.current
    if (!wrap || !pop) return
    const reposition = () => {
      const r = wrap.getBoundingClientRect()
      const margin = 8
      let left = align === 'right' ? r.right - pop.offsetWidth : r.left
      left = Math.max(margin, Math.min(left, window.innerWidth - pop.offsetWidth - margin))
      let top = r.bottom + 7
      if (top + pop.offsetHeight > window.innerHeight - margin) top = r.top - pop.offsetHeight - 7
      top = Math.max(margin, top)
      setPos({ left, top })
    }
    reposition()
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(reposition)
      : null
    observer?.observe(pop)
    return () => observer?.disconnect()
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
      if (contentRole === 'menu' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
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
    // Fixed coordinates only go stale when the viewport or an ancestor of the
    // trigger moves. A sibling scrollport (for example main content beneath a
    // topbar popover) does not move the trigger and must not dismiss its menu.
    const onMove = (event) => {
      const scroller = event.target
      if (scroller === document || scroller?.contains?.(ref.current)) setOpen(false)
    }
    const onResize = () => setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    // A trigger may be scrolled into view in the same frame that activates it
    // (keyboard focus and Playwright both do this). Let that opening scroll
    // settle before treating later ancestor movement as a dismissal signal.
    const scrollFrame = requestAnimationFrame(() => window.addEventListener('scroll', onMove, true))
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      cancelAnimationFrame(scrollFrame)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onResize)
    }
  }, [contentRole, open, setOpen])

  useEffect(() => {
    if (!open || !motionOK()) return
    const el = popRef.current
    if (el) window.gsap.fromTo(el, { y: -4, scale: 0.99 }, { y: 0, scale: 1, duration: 0.2, ease: 'power3.out' })
  }, [open])

  const wiredTrigger = isValidElement(trigger)
    ? cloneElement(trigger, {
      'aria-expanded': !!open,
      ...(contentRole === 'menu' ? { 'aria-haspopup': 'menu' } : {}),
    })
    : trigger

  return (
    <span className="pop-wrap" ref={ref}>
      {wiredTrigger}
      {open && (
        <div
          className="popover"
          role={contentRole}
          aria-label={ariaLabel}
          ref={popRef}
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
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

export function SearchInput({ value, onChange, placeholder = 'Szukaj…', inputRef }) {
  return (
    <div className="search">
      <Icon name="search" size={17} />
      <input
        ref={inputRef}
        type="search"
        autoComplete="off"
        spellCheck={false}
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
  const entered = useRef(false)
  const inactive = useRef(false)
  useEffect(() => {
    if (entered.current || !motionOK() || !ref.current) return
    entered.current = true
    window.gsap.fromTo(
      ref.current,
      { y: 10, scale: 0.98 },
      { y: 0, scale: 1, duration: 0.2, ease: 'power3.out' }
    )
  }, [])
  useEffect(() => {
    if (!toast.leaving || !motionOK() || !ref.current) return
    window.gsap.to(ref.current, { y: 8, scale: 0.98, duration: 0.18, ease: 'power2.in' })
  }, [toast.leaving])
  const dismiss = () => {
    if (inactive.current) return
    inactive.current = true
    onDismiss()
  }
  const runAction = () => {
    if (inactive.current || toast.leaving || !toast.action) return
    inactive.current = true
    try {
      toast.action.onClick()
    } finally {
      onDismiss()
    }
  }
  return (
    <div className="toast" ref={ref}>
      <Icon name={toast.icon} size={16} />
      <span className="toast__message">{toast.msg}</span>
      {toast.action && (
        <button type="button" className="toast__action" disabled={toast.leaving} onClick={runAction}>
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast__dismiss"
        disabled={toast.leaving}
        onClick={dismiss}
        title="Zamknij"
        aria-label={`Zamknij: ${toast.msg}`}
      >
        <Icon name="close" size={15} />
      </button>
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

// Pagination fallback for long lists: invisible at one page, classic pager beyond.
// resetKey = the caller's filter signature (never the items array), so data
// edits keep the current page while filter changes jump back to page 1.
export function usePagination(items, { pageSize, resetKey, initialPage = 1 }) {
  const [page, setPage] = useState(() => Math.max(1, Number(initialPage) || 1))
  const previousResetKey = useRef(resetKey)
  useEffect(() => {
    if (Object.is(previousResetKey.current, resetKey)) return
    previousResetKey.current = resetKey
    setPage(1)
  }, [resetKey])
  const pages = pageCount(items.length, pageSize)
  const current = Math.min(page, pages)
  return { pageItems: pageSlice(items, current, pageSize), page: current, pages, setPage }
}

export function Pager({ page, pages, onPage }) {
  if (pages <= 1) return null
  return (
    <nav className="pager" aria-label="Stronicowanie">
      <IconBtn name="chevL" label="Poprzednia strona" disabled={page <= 1} onClick={() => onPage(page - 1)} />
      <span className="pager__label" aria-live="polite">Strona {page} z {pages}</span>
      <IconBtn name="chevR" label="Następna strona" disabled={page >= pages} onClick={() => onPage(page + 1)} />
    </nav>
  )
}
