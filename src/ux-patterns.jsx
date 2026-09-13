import { useEffect, useId, useState } from 'react'
import { Icon } from './icons.jsx'
import { useShell } from './shell-ctx.js'
import { useIsPhone } from './responsive.js'
import { Button, EmptyState, IconBtn, Popover } from './ui.jsx'
import { cap, fmtMonthName, fmtMonthYear } from './format.js'
import { periodMonthOptions, periodNavState } from './period-nav.js'
import { routeFromHash, routeHref } from './routing.js'

export function EntityLink({ route, params, href, label, onClick, children, ...rest }) {
  const { appMode, canAccess, navigate } = useShell()

  if (appMode === 'app' && route && canAccess(route) !== true) return null

  return (
    <a
      href={href || routeHref(route, params)}
      aria-label={label}
      onClick={(event) => {
        onClick?.(event)
        if (
          event.defaultPrevented
          || !route
          || event.button !== 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) return
        event.preventDefault()
        navigate(route, params)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}

export function FilterGroup({ label, children }) {
  return (
    <div className="filter-group" role="group" aria-label={label}>
      <span className="filter-group__label">{label}</span>
      <div className="filter-group__controls">{children}</div>
    </div>
  )
}

export function ViewState({
  tone = 'empty', icon, title, hint, action, compact = false, className = '', ariaLabel,
}) {
  const role = tone === 'error' ? 'alert' : tone === 'loading' ? 'status' : undefined
  return (
    <section
      className={`view-state view-state--${tone} ${className}`}
      role={role}
      aria-live={role === 'status' ? 'polite' : undefined}
      aria-label={ariaLabel}
    >
      <EmptyState icon={icon} title={title} hint={hint} action={action} compact={compact} tone={tone} />
    </section>
  )
}

// Reflect view-owned UI state (month pickers, filters, pages) in the URL so a
// scoped view can be shared, bookmarked, or restored from history. Writes use
// replaceState only — filter tweaks must not flood the history stack. The
// write is deferred one frame: child effects run before the shell's hash
// writer, and writing immediately would overwrite the *previous* route's
// history entry instead of merging params into the freshly pushed one.
export function useRouteParamsSync(routeName, params) {
  const key = JSON.stringify(params)
  useEffect(() => {
    const hashAtSchedule = window.location.hash
    const frame = requestAnimationFrame(() => {
      if (window.location.hash !== hashAtSchedule) return
      if (routeFromHash(window.location.hash)?.name !== routeName) return
      const hash = routeHref(routeName, JSON.parse(key))
      if (window.location.hash !== hash) {
        window.history.replaceState(window.history.state, '', hash)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [routeName, key])
}

// The selected month belongs to the route/view state in each screen. This
// component only keeps the picker year while its popover is open.
export function PeriodNav({ month, min, max, current, onChange, label = 'Wybierz miesiąc' }) {
  const [open, setOpen] = useState(false)
  const [pickerYear, setPickerYear] = useState(() => Number(month.slice(0, 4)))
  const { previous, next, previousDisabled, nextDisabled, currentDisabled } = periodNavState({
    month, min, max, current,
  })
  const minYear = min ? Number(min.slice(0, 4)) : null
  const maxYear = max ? Number(max.slice(0, 4)) : null

  useEffect(() => {
    if (open) setPickerYear(Number(month.slice(0, 4)))
  }, [month, open])

  const select = (nextMonth) => {
    if (nextMonth !== month) onChange(nextMonth)
  }

  return (
    <div className="month-nav period-nav" aria-label={label}>
      <IconBtn
        name="chevL"
        label="Poprzedni miesiąc"
        disabled={previousDisabled}
        onClick={() => select(previous)}
      />
      <Popover
        ariaLabel="Wybierz miesiąc"
        contentRole="dialog"
        open={open}
        setOpen={setOpen}
        focusOnOpen
        trigger={(
          <button
            type="button"
            className="month-nav__label period-nav__label"
            aria-haspopup="dialog"
            onClick={() => setOpen((value) => !value)}
          >
            <span>{cap(fmtMonthYear(month))}</span>
            <Icon name="chevD" size={16} />
          </button>
        )}
      >
        <div className="period-picker">
          <div className="period-picker__year">
            <IconBtn
              name="chevL"
              label="Poprzedni rok"
              disabled={minYear !== null && pickerYear <= minYear}
              onClick={() => setPickerYear((year) => year - 1)}
            />
            <span aria-live="polite" aria-atomic="true">Rok {pickerYear}</span>
            <IconBtn
              name="chevR"
              label="Następny rok"
              disabled={maxYear !== null && pickerYear >= maxYear}
              onClick={() => setPickerYear((year) => year + 1)}
            />
          </div>
          <div className="period-picker__months">
            {periodMonthOptions(pickerYear, { min, max }).map((option) => (
              <Button
                key={option.month}
                variant="ghost"
                size="sm"
                className={`popover__item period-picker__month ${option.month === month ? 'is-selected' : ''} ${option.month === current ? 'is-current' : ''}`}
                disabled={option.disabled}
                aria-pressed={option.month === month}
                onClick={() => {
                  select(option.month)
                  setOpen(false)
                }}
              >
                {cap(fmtMonthName(option.month))}
              </Button>
            ))}
          </div>
        </div>
      </Popover>
      <IconBtn
        name="chevR"
        label="Następny miesiąc"
        disabled={nextDisabled}
        onClick={() => select(next)}
      />
      {!currentDisabled && (
        <Button variant="ghost" size="sm" className="period-nav__current" onClick={() => select(current)}>
          Bieżący miesiąc
        </Button>
      )}
      <span className="sr-only" aria-live="polite">Wybrano {fmtMonthYear(month)}</span>
    </div>
  )
}

export function FilterBar({
  activeCount,
  summary,
  onClear,
  children,
  label = 'Filtry',
}) {
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  const surfaceId = useId()

  useEffect(() => {
    if (!isPhone) setOpen(false)
  }, [isPhone])

  const surface = (hidden = false) => (
    <section className="filter-bar" id={surfaceId} role="region" aria-label={label} hidden={hidden}>
      {activeCount > 0 && <p className="filter-bar__summary">
        <span>Aktywne filtry · {activeCount}</span>
        <b>{summary}</b>
      </p>}
      <div className="filter-bar__groups">{children}</div>
      {activeCount > 0 && onClear && (
        <Button variant="ghost" size="sm" onClick={onClear}>Wyczyść filtry</Button>
      )}
    </section>
  )

  if (!isPhone) return surface()

  return (
    <div className="filter-disclosure">
      <button
        type="button"
        className="filter-disclosure__trigger"
        aria-expanded={open}
        aria-controls={surfaceId}
        onClick={() => setOpen((current) => !current)}
      >
        Filtry{activeCount > 0 ? ` · ${activeCount}` : ''}
      </button>
      {surface(!open)}
    </div>
  )
}
