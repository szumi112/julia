import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Avatar } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { filterSessionClientOptions, sessionClientOptions } from '../workspace.js'

function useActiveOptionIntoView(listRef, activeIndex, open) {
  useEffect(() => {
    if (!open || activeIndex < 0) return
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeIndex, open, listRef])
}

export function SessionClientPicker({ clients, selectedClient = null, value, onChange, error, disabled = false }) {
  const inputId = useId()
  const listId = useId()
  const errorId = useId()
  const listRef = useRef(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const options = useMemo(() => sessionClientOptions(clients), [clients])
  const selected = options.find((client) => client.id === value)
    || (selectedClient?.id === value ? selectedClient : null)
  const results = useMemo(() => filterSessionClientOptions(options, query), [options, query])
  const active = open && results.length > 0 ? Math.min(activeIndex, results.length - 1) : -1

  useEffect(() => {
    if (selected) setQuery(selected.name)
  }, [selected?.id, selected?.name])
  useActiveOptionIntoView(listRef, active, open)

  const choose = (client) => {
    if (!client) return
    onChange(client.id)
    setQuery(client.name)
    setActiveIndex(0)
    setOpen(false)
  }

  return (
    <div className={`field session-client-picker ${error ? 'has-error' : ''}`}>
      <label className="field__label" htmlFor={inputId}>Klient</label>
      <div
        className="member-combo"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }}
      >
        <Icon name="search" size={17} />
        <input
          id={inputId}
          className="input member-combo__input"
          type="search"
          role="combobox"
          name="session-client"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          value={query}
          disabled={disabled}
          placeholder="Szukaj po imieniu lub nazwisku…"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            const nextQuery = event.target.value
            setQuery(nextQuery)
            setActiveIndex(0)
            setOpen(true)
            if (value) onChange('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              setActiveIndex((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter' && active >= 0) {
              event.preventDefault()
              choose(results[active])
            } else if (event.key === 'Escape' && open) {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }
          }}
        />
        {open && !disabled ? (
          <div className="member-combo__menu" ref={listRef} id={listId} role="listbox" aria-label="Wyniki wyszukiwania klientów">
            {results.length > 0 ? results.map((client, index) => (
              <button
                type="button"
                key={client.id}
                id={`${listId}-${index}`}
                className={`member-option ${client.id === value ? 'is-selected' : ''} ${index === active ? 'is-active' : ''}`}
                role="option"
                aria-selected={client.id === value}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(client)}
              >
                <Avatar name={client.name} size={34} />
                <span className="member-option__main">
                  <b>{client.name}</b>
                  <span>{client.age != null ? `${client.age} l.` : 'Osoba dorosła'}</span>
                </span>
              </button>
            )) : (
              <div className="member-combo__empty">
                <Icon name="search" size={18} />
                <span>{options.length === 0 ? 'Brak klientów w Twoim zakresie' : 'Nie znaleziono takiego klienta'}</span>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {error && <span className="field__error" id={errorId} role="alert"><Icon name="alert" size={13} /> {error}</span>}
    </div>
  )
}
