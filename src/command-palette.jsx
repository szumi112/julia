// Global search (Ctrl+K) — jump to clients, specialists and views.
// Keyboard-first: arrows to move, Enter to open, Escape to close.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from './store.jsx'
import { useShell } from './shell-ctx.js'
import { motionOK } from './anim.js'
import { Icon } from './icons.jsx'
import { Avatar, EmptyState } from './ui.jsx'
import { searchNorm as norm, plural } from './format.js'
import { clientsForRole } from './workspace.js'

const VIEW_ITEMS = [
  { view: 'dashboard', label: 'Dziś', icon: 'dashboard' },
  { view: 'calendar', label: 'Kalendarz', icon: 'calendar' },
  { view: 'clients', label: 'Klienci', icon: 'clients' },
  { view: 'tus', label: 'Zajęcia TUS', icon: 'group' },
  { view: 'team', label: 'Zespół', icon: 'team' },
  { view: 'payments', label: 'Finanse', icon: 'payments' },
  { view: 'ledger', label: 'Rejestr', icon: 'reports' },
  { view: 'reports', label: 'Raporty', icon: 'reports' },
  { view: 'settings', label: 'Ustawienia', icon: 'settings' },
]

export function CommandPalette({ onClose }) {
  const { state } = useApp()
  const { role, canAccess, navigate } = useShell()
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const panelRef = useRef(null)
  const backRef = useRef(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const closing = useRef(false)

  const q = norm(query.trim())

  const results = useMemo(() => {
    const psychOf = (id) => state.psychologists.find((p) => p.id === id)
    const out = []
    if (canAccess('client')) {
      clientsForRole(state, role)
        .filter((c) => !q || norm(c.name + ' ' + c.email).includes(q))
        .slice(0, q ? 6 : 4)
        .forEach((c) =>
          out.push({
            key: `c-${c.id}`,
            group: 'Klienci',
            title: c.name,
            sub: psychOf(c.psychId)?.name || c.email,
            avatar: { name: c.name, color: psychOf(c.psychId)?.color },
            run: () => navigate('client', { id: c.id }),
          })
        )
    }
    state.psychologists
      .filter((p) => canAccess('psych') && (!q || norm(p.name + ' ' + p.spec).includes(q)))
      .slice(0, q ? 5 : 3)
      .forEach((p) =>
        out.push({
          key: `p-${p.id}`,
          group: 'Zespół',
          title: `${p.title} ${p.name}`,
          sub: p.spec,
          avatar: { name: p.name, color: p.color },
          run: () => navigate('psych', { id: p.id }),
        })
      )
    if (q) {
      VIEW_ITEMS.filter((v) => canAccess(v.view) && norm(v.label).includes(q)).forEach((v) =>
        out.push({
          key: `v-${v.view}`,
          group: 'Przejdź do',
          title: v.label,
          icon: v.icon,
          run: () => navigate(v.view),
        })
      )
    }
    return out
  }, [q, role, state.clients, state.psychologists, canAccess, navigate])

  useEffect(() => { setSel(0) }, [q])

  // Operational UI stays visible throughout; motion only reinforces its position.
  useEffect(() => {
    if (!motionOK()) return
    window.gsap.fromTo(
      panelRef.current,
      { y: -8, scale: 0.99 },
      { y: 0, scale: 1, duration: 0.2, ease: 'power3.out' }
    )
  }, [])

  const close = () => {
    if (closing.current) return
    if (!motionOK()) return onClose()
    closing.current = true
    window.gsap.to(panelRef.current, { y: -8, scale: 0.99, duration: 0.18, ease: 'power2.in', onComplete: onClose })
  }
  const closeRef = useRef(close)
  closeRef.current = close

  // capture-phase Escape (works whatever has focus, and never reaches the
  // drawer's document listener underneath) + Tab trap + focus restore.
  // The opener is recorded BEFORE focus moves into the panel — an autoFocus
  // attribute would fire during commit and make the input its own "opener".
  useEffect(() => {
    const opener = document.activeElement
    inputRef.current?.focus()
    const onDocKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key === 'Tab' && panelRef.current) {
        // single selection model: focus never leaves the input, arrows move
        // aria-activedescendant across the options
        const els = [...panelRef.current.querySelectorAll('input')].filter((el) => !el.disabled)
        if (!els.length) return
        const first = els[0]
        const last = els[els.length - 1]
        const inside = panelRef.current.contains(document.activeElement)
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onDocKey, true)
    return () => {
      document.removeEventListener('keydown', onDocKey, true)
      if (opener && typeof opener.focus === 'function') opener.focus()
    }
  }, [])

  const run = (item) => {
    if (!item) return
    item.run()
    close()
  }

  // arrows + Enter work wherever focus sits inside the panel
  const onPanelKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[sel])
    }
  }

  // keep the highlighted row in view
  useEffect(() => {
    const el = listRef.current?.querySelector('.cmd__item.is-sel')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [sel])

  let lastGroup = null

  return (
    <>
      <div className="cmd-back" ref={backRef} onClick={close} />
      <div
        className="cmd"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Szukaj w panelu"
        onKeyDown={onPanelKey}
      >
        <div className="cmd__head">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            type="search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="Szukaj klienta, specjalistki, widoku…"
            aria-label="Szukaj w panelu"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-list"
            aria-activedescendant={results.length ? `cmd-opt-${sel}` : undefined}
            aria-autocomplete="list"
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>Esc</kbd>
        </div>
        <span className="sr-only" aria-live="polite">
          {results.length === 0
            ? 'Brak wyników'
            : `${results.length} ${plural(results.length, 'wynik', 'wyniki', 'wyników')}`}
        </span>
        <div className="cmd__list" id="cmd-list" role="listbox" ref={listRef}>
          {results.length === 0 && (
            <EmptyState
              compact
              icon="search"
              title="Nic nie znaleziono"
              hint="Spróbuj wpisać imię klienta albo nazwisko specjalistki."
            />
          )}
          {results.map((item, i) => {
            const header = item.group !== lastGroup ? <div className="cmd__group" role="presentation">{item.group}</div> : null
            lastGroup = item.group
            return (
              <div key={item.key} role="presentation">
                {header}
                <button
                  type="button"
                  className={`cmd__item ${i === sel ? 'is-sel' : ''}`}
                  role="option"
                  id={`cmd-opt-${i}`}
                  aria-selected={i === sel}
                  tabIndex={-1}
                  onClick={() => run(item)}
                  onMouseMove={() => setSel(i)}
                >
                  {item.avatar ? (
                    <Avatar name={item.avatar.name} color={item.avatar.color} size={34} />
                  ) : (
                    <span className="cmd__icon"><Icon name={item.icon} size={17} /></span>
                  )}
                  <span style={{ minWidth: 0 }}>
                    <b>{item.title}</b>
                    {item.sub && <small>{item.sub}</small>}
                  </span>
                  <span className="cmd__go"><Icon name="chevR" size={15} /></span>
                </button>
              </div>
            )
          })}
        </div>
        <div className="cmd__foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> wybór</span>
          <span><kbd>Enter</kbd> otwórz</span>
          <span><kbd>Esc</kbd> zamknij</span>
        </div>
      </div>
    </>
  )
}
