import { useEffect, useState } from 'react'
import { useShell } from './shell-ctx.js'
import { useIsPhone } from './responsive.js'
import { Button } from './ui.jsx'
import { routeHref } from './routing.js'

export function EntityLink({ route, params, href, label, onClick, children, ...rest }) {
  const { navigate } = useShell()

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

export function FilterBar({
  activeCount,
  summary,
  onClear,
  children,
  label = 'Filtry',
}) {
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!isPhone) setOpen(false)
  }, [isPhone])

  const surface = (
    <section className="filter-bar" role="region" aria-label={label}>
      <p className="filter-bar__summary">
        <span>Aktywne filtry · {activeCount}</span>
        <b>{activeCount > 0 ? summary : 'Brak'}</b>
      </p>
      <div className="filter-bar__groups">{children}</div>
      {activeCount > 0 && onClear && (
        <Button variant="ghost" size="sm" onClick={onClear}>Wyczyść filtry</Button>
      )}
    </section>
  )

  if (!isPhone) return surface

  return (
    <div className="filter-disclosure">
      <button
        type="button"
        className="filter-disclosure__trigger"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Filtry{activeCount > 0 ? ` · ${activeCount}` : ''}
      </button>
      {open && surface}
    </div>
  )
}
