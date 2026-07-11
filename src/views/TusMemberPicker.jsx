import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Avatar, Button, Check, Field, IconBtn } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { searchNorm } from '../format.js'
import { filterTusMemberOptions, tusMemberOptions } from '../tus.js'

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const polishNameOrder = new Intl.Collator('pl', { sensitivity: 'base' })

function useActiveOptionIntoView(listRef, activeIndex, open) {
  useEffect(() => {
    if (!open || activeIndex < 0) return
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeIndex, open, listRef])
}

const optionMeta = (option) => {
  if (option.groupName) return `Obecnie: ${option.groupName}`
  if (option.source === 'client') return 'Karta klienta · jeszcze bez TUS'
  if (option.source === 'new') return 'Nowa osoba'
  return 'Bez grupy'
}

function MemberOption({ option, selected, disabled, active, id, onToggle }) {
  return (
    <button
      type="button"
      id={id}
      className={`member-option ${selected ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''} ${active ? 'is-active' : ''}`}
      role="option"
      aria-selected={selected}
      disabled={disabled}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onToggle(option.key)}
    >
      <Avatar name={option.name} size={34} />
      <span className="member-option__main">
        <b>{option.name}</b>
        <span>
          {option.age != null ? `${option.age} l. · ` : ''}
          {option.parentName ? `Rodzic: ${option.parentName}` : 'Brak danych rodzica'}
        </span>
        <small>{disabled ? `Już w: ${option.groupName} · niedostępne do wyboru` : optionMeta(option)}</small>
      </span>
      <span className="member-option__mark" aria-hidden="true">
        {selected ? <Icon name="check" size={14} /> : <Icon name="plus" size={14} />}
      </span>
    </button>
  )
}

export function TusMemberPicker({
  clients,
  kids,
  groups,
  selectedKeys,
  newChildren,
  onToggle,
  onRemove,
  onStartCreate,
  targetGroupId,
}) {
  const listId = useId()
  const listRef = useRef(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys])
  const clientsById = useMemo(() => new Map(clients.map((client) => [client.id, client])), [clients])

  const options = useMemo(() => {
    const existing = tusMemberOptions(clients, kids, groups)
    const drafts = newChildren.map((draft) => {
      const parent = clientsById.get(draft.parentClientId)
      return {
        key: draft.key,
        kidId: null,
        clientId: null,
        name: draft.childName,
        age: Number(draft.age),
        parentName: parent?.name || draft.parentName,
        parentPhone: parent?.phone || draft.parentPhone || '',
        groupId: null,
        groupName: '',
        source: 'new',
      }
    })
    return [...existing, ...drafts].sort(
      (a, b) => polishNameOrder.compare(a.name, b.name) || a.key.localeCompare(b.key)
    )
  }, [clients, kids, groups, newChildren, clientsById])

  const results = useMemo(() => filterTusMemberOptions(options, query), [options, query])
  const selectedOptions = useMemo(() => options.filter((option) => selected.has(option.key)), [options, selected])
  const active = open && results.length > 0 ? Math.min(activeIndex, results.length - 1) : -1
  const unavailable = (option) => !!option.groupId && option.groupId !== targetGroupId
  useActiveOptionIntoView(listRef, active, open)

  const choose = (key) => {
    const option = options.find((candidate) => candidate.key === key)
    if (!option || unavailable(option)) return
    onToggle(key)
    setQuery('')
    setActiveIndex(0)
    setOpen(true)
  }

  return (
    <div className="tus-member-picker">
      <div className="field__label-row">
        <span className="field__label">Uczestnicy</span>
        <span className="faint">{selectedOptions.length} wybrano</span>
      </div>
      <span className="field__hint">Wyszukaj osoby z kartoteki lub dzieci zapisane wcześniej do TUS.</span>

      <Button variant="soft" icon="plus" className="member-add" onClick={onStartCreate}>
        Dodaj nowe dziecko
      </Button>

      <div
        className="member-combo"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
        }}
      >
        <Icon name="search" size={17} />
        <input
          className="input member-combo__input"
          type="search"
          role="combobox"
          aria-label="Szukaj dzieci"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          value={query}
          placeholder="Szukaj po imieniu, rodzicu lub telefonie…"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((index) => Math.max(index - 1, 0))
            }
            if (event.key === 'Enter' && active >= 0) {
              event.preventDefault()
              choose(results[active].key)
            }
            if (event.key === 'Escape' && open) {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }
          }}
        />

        {open ? (
          <div
            className="member-combo__menu"
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Wyniki wyszukiwania dzieci"
            aria-multiselectable="true"
          >
            {results.length > 0 ? results.map((option, index) => (
              <MemberOption
                key={option.key}
                id={`${listId}-${index}`}
                option={option}
                selected={selected.has(option.key)}
                disabled={unavailable(option)}
                active={index === active}
                onToggle={choose}
              />
            )) : (
              <div className="member-combo__empty">
                <Icon name="search" size={18} />
                <span>Nie znaleziono takiej osoby</span>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="selected-members" role="list" aria-label="Wybrane dzieci">
        {selectedOptions.length > 0 ? selectedOptions.map((option) => (
          <div className="selected-member" role="listitem" key={option.key}>
            <Avatar name={option.name} size={32} />
            <span className="selected-member__main">
              <b>{option.name}</b>
              <span>{option.parentName ? `Rodzic: ${option.parentName}` : optionMeta(option)}</span>
            </span>
            <IconBtn name="close" size={15} label={`Usuń ${option.name}`} onClick={() => onRemove(option.key)} />
          </div>
        )) : (
          <div className="selected-members__empty">Nie wybrano jeszcze żadnego dziecka.</div>
        )}
      </div>
    </div>
  )
}

export function TusChildQuickCreate({ clients, pendingParents = [], onAdd, onCancel, onInvalid }) {
  const parentListId = useId()
  const parentErrorId = useId()
  const parentListRef = useRef(null)
  const [form, setForm] = useState({
    childName: '',
    age: '',
    parentClientId: '',
    parentName: '',
    parentPhone: '',
    parentEmail: '',
    regulationsSigned: false,
  })
  const [errors, setErrors] = useState({})
  const [parentMode, setParentMode] = useState('existing')
  const [parentQuery, setParentQuery] = useState('')
  const [parentOpen, setParentOpen] = useState(false)
  const [parentActiveIndex, setParentActiveIndex] = useState(0)

  const set = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: null }))
  }

  const parentChoices = useMemo(() => {
    const choices = clients
      .filter((client) => client.familyRole !== 'dziecko')
      .map((client) => ({ ...client, pending: false }))
    const seenPending = new Set()
    for (const draft of pendingParents) {
      if (draft.parentClientId || !draft.parentName) continue
      const identity = `${searchNorm(draft.parentName).trim()}|${String(draft.parentPhone || '').replace(/\D/g, '')}|${searchNorm(draft.parentEmail).trim()}`
      if (seenPending.has(identity)) continue
      seenPending.add(identity)
      choices.push({
        id: `pending-parent:${draft.key}`,
        name: draft.parentName,
        phone: draft.parentPhone || '',
        email: draft.parentEmail || '',
        pending: true,
      })
    }
    return choices.sort((a, b) => polishNameOrder.compare(a.name, b.name) || a.id.localeCompare(b.id))
  }, [clients, pendingParents])
  const parentOptions = useMemo(() => parentChoices.filter((client) => {
    const text = searchNorm(`${client.name} ${client.email || ''} ${client.phone || ''}`)
    const query = parentQuery.trim()
    const queryDigits = query.replace(/\D/g, '')
    return !query || text.includes(searchNorm(query)) || (
      queryDigits.length >= 3 && String(client.phone || '').replace(/\D/g, '').includes(queryDigits)
    )
  }), [parentChoices, parentQuery])
  const selectedParent = parentChoices.find((client) => client.id === form.parentClientId) || null
  const activeParent = parentOpen && parentOptions.length > 0
    ? Math.min(parentActiveIndex, parentOptions.length - 1)
    : -1
  useActiveOptionIntoView(parentListRef, activeParent, parentOpen)

  const submit = (event) => {
    event.preventDefault()
    const nextErrors = {}
    if (!form.childName.trim()) nextErrors.childName = 'Podaj imię i nazwisko dziecka'
    if (!(Number(form.age) >= 3 && Number(form.age) <= 12)) nextErrors.age = 'Podaj wiek 3–12 lat'
    if (parentMode === 'existing' && !form.parentClientId) nextErrors.parentClientId = 'Wybierz rodzica lub dodaj nową osobę'
    if (parentMode === 'new' && !form.parentName.trim()) nextErrors.parentName = 'Podaj imię i nazwisko rodzica'
    if (parentMode === 'new' && !form.parentPhone.trim()) nextErrors.parentPhone = 'Podaj telefon kontaktowy'
    if (parentMode === 'new' && form.parentEmail.trim() && !EMAIL_SHAPE.test(form.parentEmail.trim())) {
      nextErrors.parentEmail = 'Podaj poprawny adres e-mail'
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      onInvalid()
      return
    }
    onAdd({
      childName: form.childName.trim(),
      age: Number(form.age),
      parentClientId: parentMode === 'existing' && !selectedParent?.pending ? form.parentClientId : '',
      parentName: parentMode === 'new' ? form.parentName.trim() : selectedParent?.name || '',
      parentPhone: parentMode === 'new' ? form.parentPhone.trim() : selectedParent?.phone || '',
      parentEmail: parentMode === 'new' ? form.parentEmail.trim() : selectedParent?.email || '',
      regulationsSigned: form.regulationsSigned,
    })
  }

  return (
    <>
      <form className="drawer__body" id="tus-child-quick-create" onSubmit={submit} noValidate>
        <section className="quick-child-section" aria-labelledby="quick-child-data">
          <div className="quick-child-section__head">
            <span className="quick-child-section__step">1</span>
            <div>
              <h3 id="quick-child-data">Dane dziecka</h3>
              <p>Utworzymy osobną kartę klienta i zapis TUS.</p>
            </div>
          </div>
          <div className="form-grid">
            <Field label="Imię i nazwisko dziecka" error={errors.childName} className="span2">
              <input
                className="input"
                value={form.childName}
                placeholder="np. Mila Kowalska"
                autoFocus
                onChange={(event) => set('childName', event.target.value)}
              />
            </Field>
            <Field label="Wiek" error={errors.age}>
              <input
                className="input"
                type="number"
                min="3"
                max="12"
                inputMode="numeric"
                value={form.age}
                onChange={(event) => set('age', event.target.value)}
              />
            </Field>
          </div>
        </section>

        <section className="quick-child-section" aria-labelledby="quick-parent-data">
          <div className="quick-child-section__head">
            <span className="quick-child-section__step">2</span>
            <div>
              <h3 id="quick-parent-data">Rodzic lub opiekun</h3>
              <p>Najpierw sprawdź, czy osoba jest już w kartotece.</p>
            </div>
          </div>

          {parentMode === 'existing' ? (
            <div className={`field ${errors.parentClientId ? 'has-error' : ''}`}>
              <span className="field__label">Rodzic / opiekun</span>
              {selectedParent ? (
                <div className="parent-picked">
                  <Avatar name={selectedParent.name} size={36} />
                  <span>
                    <b>{selectedParent.name}</b>
                    <small>
                      {selectedParent.pending
                        ? 'Nowy rodzic · do utworzenia z grupą'
                        : selectedParent.phone || selectedParent.email || 'Dane kontaktowe do uzupełnienia'}
                    </small>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => {
                    set('parentClientId', '')
                    setParentQuery('')
                    setParentOpen(true)
                  }}>Zmień</Button>
                </div>
              ) : (
                <div
                  className="parent-combo"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setParentOpen(false)
                  }}
                >
                  <Icon name="search" size={17} />
                  <input
                    className="input parent-combo__input"
                    type="search"
                    role="combobox"
                    aria-label="Szukaj rodzica lub opiekuna"
                    aria-autocomplete="list"
                    aria-expanded={parentOpen}
                    aria-controls={parentListId}
                    aria-activedescendant={activeParent >= 0 ? `${parentListId}-${activeParent}` : undefined}
                    aria-invalid={errors.parentClientId ? true : undefined}
                    aria-describedby={errors.parentClientId ? parentErrorId : undefined}
                    value={parentQuery}
                    placeholder="Imię, telefon lub e-mail…"
                    onFocus={() => setParentOpen(true)}
                    onChange={(event) => {
                      setParentQuery(event.target.value)
                      setParentActiveIndex(0)
                      setParentOpen(true)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && parentOpen) {
                        event.preventDefault()
                        event.stopPropagation()
                        setParentOpen(false)
                      }
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        setParentOpen(true)
                        setParentActiveIndex((index) => Math.min(index + 1, Math.max(parentOptions.length - 1, 0)))
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        setParentOpen(true)
                        setParentActiveIndex((index) => Math.max(index - 1, 0))
                      }
                      if (event.key === 'Enter' && activeParent >= 0) {
                        event.preventDefault()
                        set('parentClientId', parentOptions[activeParent].id)
                        setParentOpen(false)
                      }
                    }}
                  />
                  {parentOpen ? (
                    <div
                      className="parent-combo__menu"
                      ref={parentListRef}
                      id={parentListId}
                      role="listbox"
                      aria-label="Wyniki wyszukiwania rodziców"
                    >
                      {parentOptions.length > 0 ? parentOptions.map((parent, index) => (
                        <button
                          key={parent.id}
                          id={`${parentListId}-${index}`}
                          type="button"
                          className={`parent-option ${index === activeParent ? 'is-active' : ''}`}
                          role="option"
                          aria-selected="false"
                          tabIndex={-1}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            set('parentClientId', parent.id)
                            setParentActiveIndex(0)
                            setParentOpen(false)
                          }}
                        >
                          <Avatar name={parent.name} size={32} />
                          <span>
                            <b>{parent.name}</b>
                            <small>
                              {parent.pending
                                ? 'Nowy rodzic · do utworzenia z grupą'
                                : parent.phone || parent.email || 'Brak danych kontaktowych'}
                            </small>
                          </span>
                        </button>
                      )) : <div className="member-combo__empty">Nie znaleziono takiej osoby</div>}
                    </div>
                  ) : null}
                </div>
              )}
              {errors.parentClientId ? <span className="field__error" id={parentErrorId}><Icon name="alert" size={13} /> {errors.parentClientId}</span> : null}
              <Button
                variant="soft"
                icon="plus"
                className="parent-create"
                onClick={() => {
                  setParentMode('new')
                  setErrors((current) => ({ ...current, parentClientId: null }))
                }}
              >
                Dodaj nowego rodzica
              </Button>
            </div>
          ) : (
            <div className="stack quick-parent-new">
              <div className="row row--between quick-parent-new__head">
                <span className="field__label">Nowa osoba w kartotece</span>
                <button type="button" className="link" onClick={() => setParentMode('existing')}>Wybierz istniejącą</button>
              </div>
              <Field label="Imię i nazwisko rodzica" error={errors.parentName}>
                <input className="input" value={form.parentName} placeholder="np. Anna Kowalska" onChange={(event) => set('parentName', event.target.value)} />
              </Field>
              <div className="form-grid">
                <Field label="Telefon rodzica" error={errors.parentPhone}>
                  <input type="tel" className="input" value={form.parentPhone} placeholder="+48 600 000 000" onChange={(event) => set('parentPhone', event.target.value)} />
                </Field>
                <Field label="E-mail rodzica (opcjonalnie)" error={errors.parentEmail}>
                  <input type="email" className="input" value={form.parentEmail} placeholder="anna@gmail.com" onChange={(event) => set('parentEmail', event.target.value)} />
                </Field>
              </div>
            </div>
          )}
        </section>

        <Field label="Regulamin zajęć">
          <Check checked={form.regulationsSigned} onChange={(value) => set('regulationsSigned', value)}>
            Rodzic podpisał regulamin
          </Check>
        </Field>
      </form>

      <div className="drawer__foot">
        <Button variant="primary" type="submit" form="tus-child-quick-create">Dodaj do grupy</Button>
        <Button variant="ghost" onClick={onCancel}>Wróć</Button>
      </div>
    </>
  )
}
