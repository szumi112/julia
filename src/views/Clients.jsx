import { useMemo, useState } from 'react'
import { useApp, clientOutstanding, lastSessionOf } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useFlip } from '../anim.js'
import { Button, Avatar, Pill, Chip, SearchInput, IconBtn, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { StatusPicker, PaymentPicker } from './session-bits.jsx'
import { fmtMoney, fmtShortDate, fmtFullDate, sessionsWord, toISODate, plural, searchNorm } from '../format.js'

export function Clients() {
  const { state } = useApp()
  const { navigate, openClientForm } = useShell()
  const ref = useReveal()
  const [query, setQuery] = useState('')
  const [psychFilter, setPsychFilter] = useState(null)
  const [debtOnly, setDebtOnly] = useState(false)

  const filtered = useMemo(() => {
    return state.clients.filter((c) => {
      if (psychFilter && c.psychId !== psychFilter) return false
      if (debtOnly && clientOutstanding(state.sessions, c.id) <= 0) return false
      if (query && !searchNorm(c.name + ' ' + c.email).includes(searchNorm(query))) return false
      return true
    })
  }, [state.clients, state.sessions, query, psychFilter, debtOnly])

  const tbodyRef = useFlip(filtered.map((c) => c.id).join(','))

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Kartoteka</div>
          <h1 className="display view-head__title">Klienci <em>centrum</em></h1>
          <p className="view-head__sub">
            {state.clients.length} {plural(state.clients.length, 'osoba', 'osoby', 'osób')} pod opieką zespołu — wyszukuj, filtruj i przechodź do kart klientów.
          </p>
        </div>
        <div className="view-head__actions">
          <SearchInput value={query} onChange={setQuery} placeholder="Szukaj klienta…" />
          <Button icon="plus" magnetic onClick={() => openClientForm({ psychId: psychFilter || undefined })}>
            Dodaj klienta
          </Button>
        </div>
      </div>

      <div className="row chips-row" data-reveal>
        <Chip on={!psychFilter} onClick={() => setPsychFilter(null)}>Wszyscy</Chip>
        {state.psychologists.map((p) => (
          <Chip key={p.id} on={psychFilter === p.id} swatch={p.color} onClick={() => setPsychFilter(psychFilter === p.id ? null : p.id)}>
            {p.name.split(' ')[0]}
          </Chip>
        ))}
        <span style={{ width: 1, height: 22, background: 'var(--line)', margin: '0 6px' }} />
        <Chip on={debtOnly} onClick={() => setDebtOnly(!debtOnly)}>
          <Icon name="payments" size={14} /> Z zaległościami
        </Chip>
      </div>

      <div className="card card--table" data-reveal>
        <div className="table-scroll table-scroll--until-tablet">
        <table className="table table--cards">
          <thead>
            <tr>
              <th>Klient</th>
              <th>Specjalistka</th>
              <th>Telefon</th>
              <th>Ostatnia sesja</th>
              <th className="right">Sesje</th>
              <th className="right">Zaległość</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7}>
                  {state.clients.length === 0 ? (
                    <EmptyState
                      icon="clients"
                      title="Kartoteka jest jeszcze pusta"
                      hint="Dodaj pierwszego klienta, aby planować sesje i rozliczenia."
                      action={<Button size="sm" icon="plus" onClick={() => openClientForm()}>Dodaj klienta</Button>}
                    />
                  ) : (
                    <EmptyState
                      icon="search"
                      title="Nie znaleziono klientów"
                      hint="Zmień wyszukiwanie lub filtry — albo dodaj nową osobę."
                      action={<Button size="sm" variant="soft" icon="plus" onClick={() => openClientForm()}>Dodaj klienta</Button>}
                    />
                  )}
                </td>
              </tr>
            )}
            {filtered.map((c) => {
              const p = psychOf(c.psychId)
              const last = lastSessionOf(state.sessions, c.id)
              const count = state.sessions.filter((s) => s.clientId === c.id && s.status === 'completed').length
              const debt = clientOutstanding(state.sessions, c.id)
              return (
                <tr
                  key={c.id}
                  data-flip-id={c.id}
                  className="is-click"
                  tabIndex={0}
                  aria-label={`Otwórz kartę: ${c.name}`}
                  onClick={() => navigate('client', { id: c.id })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      navigate('client', { id: c.id })
                    }
                  }}
                >
                  <td>
                    <span className="row" style={{ gap: 12 }}>
                      <Avatar name={c.name} color={p?.color} size={36} />
                      <span>
                        <span style={{ fontWeight: 650, display: 'block' }}>{c.name}</span>
                        <span className="faint" style={{ fontSize: 12.5 }}>{c.email}</span>
                      </span>
                    </span>
                  </td>
                  <td data-th="Specjalistka">
                    <span className="row" style={{ gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: p?.color, display: 'inline-block' }} />
                      <span className="muted">{p?.name}</span>
                    </span>
                  </td>
                  <td className="muted" data-th="Telefon">{c.phone}</td>
                  <td className="muted" data-th="Ostatnia sesja">{last ? fmtShortDate(last.date) : '—'}</td>
                  <td className="right num-cell" data-th="Sesje">{count}</td>
                  <td className="right" data-th="Zaległość">
                    {debt > 0 ? <Pill tone="gold">{fmtMoney(debt)}</Pill> : <span className="faint">—</span>}
                  </td>
                  <td data-th="Status">
                    <Pill tone={c.status === 'active' ? 'sage' : 'mauve'} dot>
                      {c.status === 'active' ? 'Aktywny' : 'Wstrzymany'}
                    </Pill>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

export function ClientDetail({ params }) {
  const { state, dispatch, toast } = useApp()
  const { navigate, openSessionForm, openClientForm } = useShell()
  const ref = useReveal([params.id])
  const [noteText, setNoteText] = useState('')
  const client = state.clients.find((c) => c.id === params.id)
  if (!client) {
    return (
      <EmptyState
        icon="clients"
        title="Nie znaleziono klienta"
        hint="Być może został usunięty z kartoteki."
        action={<Button size="sm" variant="soft" onClick={() => navigate('clients')}>Wróć do listy</Button>}
      />
    )
  }

  const psych = state.psychologists.find((p) => p.id === client.psychId)
  const history = state.sessions.filter((s) => s.clientId === client.id).slice().reverse()
  const completed = history.filter((s) => s.status === 'completed')
  const debt = clientOutstanding(state.sessions, client.id)

  const addNote = () => {
    const text = noteText.trim()
    if (!text) return
    dispatch({
      type: 'UPDATE_CLIENT',
      id: client.id,
      patch: { notes: [{ date: toISODate(new Date()), text }, ...client.notes] },
    })
    setNoteText('')
    toast('Notatka dodana')
  }

  const removeNote = (idx) => {
    dispatch({
      type: 'UPDATE_CLIENT',
      id: client.id,
      patch: { notes: client.notes.filter((_, k) => k !== idx) },
    })
    toast('Notatka usunięta', 'close')
  }

  return (
    <div ref={ref}>
      <button className="link row" style={{ gap: 7, marginBottom: 20 }} onClick={() => navigate('clients')} data-reveal>
        <Icon name="arrowL" size={16} /> Wróć do listy klientów
      </button>

      <div className="grid-13">
        <div className="stack">
          <div className="card card--pad" data-reveal>
            <div className="row" style={{ gap: 16 }}>
              <Avatar name={client.name} color={psych?.color} size={56} />
              <div style={{ flex: 1 }}>
                <h1 className="display" style={{ fontSize: 24 }}>{client.name}</h1>
                <div style={{ marginTop: 6 }}>
                  <Pill tone={client.status === 'active' ? 'sage' : 'mauve'} dot>
                    {client.status === 'active' ? 'Aktywny' : 'Wstrzymany'}
                  </Pill>
                </div>
              </div>
              <IconBtn name="edit" label="Edytuj dane klienta" onClick={() => openClientForm({ client })} />
            </div>
            <div className="divider-soft" />
            <div className="kv">
              <div className="kv__row">
                <span className="kv__key"><Icon name="phone" size={14} /> Telefon</span>
                <span className="kv__val">{client.phone}</span>
              </div>
              <div className="kv__row">
                <span className="kv__key"><Icon name="mail" size={14} /> E-mail</span>
                <span className="kv__val">{client.email}</span>
              </div>
              <div className="kv__row">
                <span className="kv__key">Specjalistka</span>
                {psych ? (
                  <button className="kv__val link" onClick={() => navigate('psych', { id: psych.id })}>
                    {psych.title} {psych.name}
                  </button>
                ) : (
                  <span className="kv__val faint">—</span>
                )}
              </div>
              <div className="kv__row">
                <span className="kv__key">Klient od</span>
                <span className="kv__val">{fmtFullDate(client.since)}</span>
              </div>
              <div className="kv__row">
                <span className="kv__key">Sesje odbyte</span>
                <span className="kv__val num-cell">{completed.length}</span>
              </div>
              <div className="kv__row">
                <span className="kv__key">Zaległość</span>
                <span className="kv__val">
                  {debt > 0 ? <Pill tone="gold">{fmtMoney(debt)}</Pill> : <Pill tone="sage">Rozliczony</Pill>}
                </span>
              </div>
            </div>
            <Button icon="plus" className="btn--full" style={{ marginTop: 20 }}
              onClick={() => openSessionForm({ clientId: client.id })}>
              Nowa sesja
            </Button>
          </div>

          <div className="card card--pad" data-reveal>
            <h2 className="card-title">Zalecenia i notatki</h2>
            <div className="note-composer" style={{ marginTop: 16 }}>
              <textarea
                className="textarea"
                value={noteText}
                placeholder="Nowa notatka — zalecenia, obserwacje…"
                aria-label="Nowa notatka"
                onChange={(e) => setNoteText(e.target.value)}
              />
              <div>
                <Button size="sm" variant="soft" icon="plus" onClick={addNote} disabled={!noteText.trim()}>
                  Dodaj notatkę
                </Button>
              </div>
            </div>
            <div className="notes" style={{ marginTop: 18 }}>
              {client.notes.length === 0 && (
                <EmptyState
                  compact
                  icon="edit"
                  title="Brak notatek"
                  hint="Dodaj pierwszą notatkę powyżej — data dzisiejsza doda się sama."
                />
              )}
              {client.notes.map((n, i) => (
                <div className="note" key={`${n.date}-${i}`}>
                  <div className="note__date">{fmtFullDate(n.date)}</div>
                  <div className="note__text">{n.text}</div>
                  <IconBtn
                    name="trash"
                    label="Usuń notatkę"
                    size={14}
                    className="note__del"
                    onClick={() => removeNote(i)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card card--pad" data-reveal style={{ alignSelf: 'start' }}>
          <h2 className="card-title">
            Historia sesji
            <span className="faint" style={{ fontSize: 13, fontFamily: 'var(--font-ui)' }}>
              {history.length} {sessionsWord(history.length)}
            </span>
          </h2>
          <table className="table table--cards" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Data</th>
                <th>Godzina</th>
                <th>Status</th>
                <th className="right">Kwota</th>
                <th>Płatność</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }} data-th="Data">{fmtShortDate(s.date)}</td>
                  <td className="num-cell muted" data-th="Godzina">{s.time}</td>
                  <td data-th="Status"><StatusPicker session={s} /></td>
                  <td className="right num-cell" data-th="Kwota">{fmtMoney(s.amount)}</td>
                  <td data-th="Płatność"><PaymentPicker session={s} /></td>
                  <td className="right td--actions" style={{ width: 44 }}>
                    <IconBtn name="edit" label="Edytuj sesję" size={15} onClick={() => openSessionForm({ session: s })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
