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

// Reflect view-owned UI state (month pickers, filters, pages) in the URL so a
// scoped view can be shared, bookmarked, or restored from history. Writes use
// replaceState only — filter tweaks must not flood the history stack. The
// write is deferred one frame: child effects run before the shell's hash
// writer, and writing immediately would overwrite the *previous* route's
// history entry instead of merging params into the freshly pushed one.
export function useRouteParamsSync(routeName, params) {
  const key = JSON.stringify(params)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const hash = routeHref(routeName, JSON.parse(key))
      if (window.location.hash !== hash) {
        window.history.replaceState(window.history.state, '', hash)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [routeName, key])
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
