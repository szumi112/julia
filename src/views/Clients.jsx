import { useMemo, useState } from 'react'
import { useApp, clientOutstanding, lastSessionOf } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useFlip } from '../anim.js'
import { Button, Avatar, Pill, Chip, SearchInput, IconBtn, EmptyState, usePagination, Pager } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { StatusPicker, PaymentPicker } from './session-bits.jsx'
import { fmtMoney, fmtShortDate, fmtFullDate, fmtDayMonth, fmtWeekday, cap, sessionsWord, toISODate, pad2, plural, searchNorm } from '../format.js'
import { clientsForRole } from '../workspace.js'

// the client's next scheduled visit — sessions stay sorted by date+time
const nextSessionOf = (sessions, clientId) => {
  const now = new Date()
  const today = toISODate(now)
  const nowTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  return sessions.find(
    (s) => s.clientId === clientId && s.status === 'scheduled' &&
      (s.date > today || (s.date === today && s.time >= nowTime))
  )
}

export function Clients() {
  const { state } = useApp()
  const { navigate, openClientForm, role } = useShell()
  const ref = useReveal()
  const [query, setQuery] = useState('')
  const [psychFilter, setPsychFilter] = useState(null)
  const [debtOnly, setDebtOnly] = useState(false)

  const scopedClients = useMemo(() => clientsForRole(state, role), [state, role])
  const filtered = useMemo(() => {
    return scopedClients.filter((c) => {
      if (role.scope !== 'own' && psychFilter && c.psychId !== psychFilter) return false
      if (debtOnly && clientOutstanding(state.sessions, c.id) <= 0) return false
      if (query && !searchNorm(c.name + ' ' + c.email).includes(searchNorm(query))) return false
      return true
    })
  }, [scopedClients, state.sessions, query, psychFilter, debtOnly, role.scope])

  const { pageItems, page, pages, setPage } = usePagination(filtered, {
    pageSize: 25,
    resetKey: `${query}|${psychFilter}|${debtOnly}`,
  })
  const tbodyRef = useFlip(pageItems.map((c) => c.id).join(','))

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Kartoteka</div>
          <h1 className="display view-head__title">
            {role.scope === 'own' ? <>Moi <em>klienci</em></> : <>Klienci <em>centrum</em></>}
          </h1>
          <p className="view-head__sub">
            {scopedClients.length} {plural(scopedClients.length, 'osoba', 'osoby', 'osób')}
            {role.scope === 'own'
              ? ' przypisanych do Twojej opieki — wyszukuj i przechodź do kart klientów.'
              : ' pod opieką zespołu — wyszukuj, filtruj i przechodź do kart klientów.'}
          </p>
        </div>
        <div className="view-head__actions">
          <SearchInput value={query} onChange={setQuery} placeholder="Szukaj klienta…" />
          <Button icon="plus" magnetic onClick={() => openClientForm({ psychId: role.scope === 'own' ? role.psychId : psychFilter || undefined })}>
            Dodaj klienta
          </Button>
        </div>
      </div>

      <div className="row chips-row" data-reveal>
        {role.scope !== 'own' && (
          <>
            <Chip on={!psychFilter} onClick={() => setPsychFilter(null)}>Cały zespół</Chip>
            {state.psychologists.map((p) => (
              <Chip key={p.id} on={psychFilter === p.id} swatch={p.color} onClick={() => setPsychFilter(psychFilter === p.id ? null : p.id)}>
                {p.name.split(' ')[0]}
              </Chip>
            ))}
            <span className="chips-row__divider" />
          </>
        )}
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
              <th>Opieka</th>
              <th>Ostatnia sesja</th>
              <th>Następna sesja</th>
              <th className="right">Zaległość</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6}>
                  {scopedClients.length === 0 ? (
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
            {pageItems.map((c) => {
              const p = psychOf(c.psychId)
              const last = lastSessionOf(state.sessions, c.id)
              const next = nextSessionOf(state.sessions, c.id)
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
                        <span className="faint" style={{ fontSize: 12.5 }}>{c.phone}</span>
                      </span>
                    </span>
                  </td>
                  <td data-th="Opieka">
                    <span className="row" style={{ gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 99, background: p?.color, display: 'inline-block' }} />
                      <span className="muted">{p?.name}</span>
                    </span>
                  </td>
                  <td className="muted" data-th="Ostatnia sesja">{last ? fmtShortDate(last.date) : '—'}</td>
                  <td data-th="Następna sesja">
                    {next
                      ? <span style={{ fontWeight: 600 }}>{fmtShortDate(next.date)} · {next.time}</span>
                      : <span className="faint">nie umówiono</span>}
                  </td>
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
        <Pager page={page} pages={pages} onPage={setPage} />
      </div>
    </div>
  )
}

export function ClientDetail({ params }) {
  const { state, dispatch, toast } = useApp()
  const { navigate, openSessionForm, openClientForm, role } = useShell()
  const ref = useReveal([params.id])
  const [noteText, setNoteText] = useState('')
  const client = state.clients.find((c) => c.id === params.id)
  const all = state.sessions.filter((s) => s.clientId === params.id)
  // upcoming care first, everything else newest-first below it
  const now = new Date()
  const todayIso = toISODate(now)
  const nowTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const upcoming = all.filter(
    (s) => s.status === 'scheduled' && (s.date > todayIso || (s.date === todayIso && s.time >= nowTime))
  )
  const upcomingIds = new Set(upcoming.map((s) => s.id))
  const history = all.filter((s) => !upcomingIds.has(s.id)).slice().reverse()
  const historyPages = usePagination(history, { pageSize: 10, resetKey: params.id })
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
  const completed = all.filter((s) => s.status === 'completed')
  const debt = clientOutstanding(state.sessions, client.id)
  const next = upcoming[0] || null
  const family = client.familyId
    ? state.clients.filter((c) => c.familyId === client.familyId && c.id !== client.id)
    : []
  const canReadClinicalNotes = role.scope === 'own' && client.psychId === role.psychId
  const canManageCare = role.scope !== 'own' || client.psychId === role.psychId

  const addNote = () => {
    if (!canReadClinicalNotes) return
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
    if (!canReadClinicalNotes) return
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

      <div className="client-record">
        <section className="client-record__section" aria-labelledby="care-overview-title" data-reveal>
          <h2 className="client-record__title" id="care-overview-title">Przegląd opieki</h2>
          <div className="id-band" style={{ '--band-color': psych?.color }}>
            <Avatar name={client.name} color={psych?.color} size={64} />
            <div className="id-band__main">
              <h1 className="display id-band__name">{client.name}</h1>
              <div className="id-band__meta">
                <span><Icon name="phone" size={14} /> {client.phone}</span>
                {client.email && <span><Icon name="mail" size={14} /> {client.email}</span>}
                <span>klient od {fmtFullDate(client.since)}</span>
                <span>{completed.length} {plural(completed.length, 'sesja odbyta', 'sesje odbyte', 'sesji odbytych')}</span>
              </div>
              <div className="id-band__pills">
                <Pill tone={client.status === 'active' ? 'sage' : 'mauve'} dot>
                  {client.status === 'active' ? 'Aktywny' : 'Wstrzymany'}
                </Pill>
              </div>
            </div>
            {canManageCare && (
              <div className="id-band__actions">
                <Button variant="ghost" icon="edit" onClick={() => openClientForm({ client })}>Edytuj</Button>
                <Button icon="plus" onClick={() => openSessionForm({ clientId: client.id })}>
                  {role.scope === 'own' ? 'Przygotuj sesję' : 'Umów spotkanie'}
                </Button>
              </div>
            )}
          </div>
          <div className="care-overview" aria-label="Podsumowanie opieki">
            <div className="care-overview__item">
              <span>Specjalistka prowadząca</span>
              {psych && role.scope !== 'own' ? (
                <button className="link care-overview__value" onClick={() => navigate('psych', { id: psych.id })}>
                  {psych.title} {psych.name}
                </button>
              ) : <b>{psych ? `${psych.title} ${psych.name}` : 'Nieprzypisana'}</b>}
            </div>
            <div className="care-overview__item">
              <span>Następne spotkanie</span>
              <b>{next ? `${cap(fmtWeekday(next.date))}, ${fmtDayMonth(next.date)} · ${next.time}` : 'Nie umówiono'}</b>
            </div>
            <div className="care-overview__item">
              <span>Saldo klienta</span>
              <b className={debt > 0 ? 'care-overview__debt' : ''}>{debt > 0 ? `Do rozliczenia ${fmtMoney(debt)}` : 'Rozliczony'}</b>
            </div>
            <div className="care-overview__item">
              <span>Rodzina</span>
              {family.length > 0 ? (
                <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  {family.map((member) => {
                    const label = `${member.name} (${member.familyRole || 'rodzina'})`
                    // a therapist sees the family fact, but only their own
                    // clients' cards open from here
                    return role.scope === 'own' && member.psychId !== role.psychId ? (
                      <b key={member.id}>{label}</b>
                    ) : (
                      <button
                        key={member.id}
                        className="link care-overview__value"
                        onClick={() => navigate('client', { id: member.id })}
                      >
                        {label}
                      </button>
                    )
                  })}
                </span>
              ) : <b>—</b>}
            </div>
          </div>
        </section>

        <section className="client-record__section" aria-labelledby="upcoming-appointments-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="upcoming-appointments-title">
              Najbliższe spotkania
              <span className="faint" style={{ fontSize: 13, fontFamily: 'var(--font-ui)' }}>
                {upcoming.length} {sessionsWord(upcoming.length)}
              </span>
            </h2>
            {upcoming.length > 0 ? (
              <div className="agenda agenda--spine" style={{ marginTop: 6 }}>
                <span className="spine__rule" aria-hidden="true" />
                {upcoming.map((s) => (
                  <div className="agenda__row" key={s.id} style={{ '--node-color': psych?.color }}>
                    <span className="agenda__time">{s.time}</span>
                    <span className="agenda__main">
                      <span className="agenda__client">{cap(fmtWeekday(s.date))}, {fmtDayMonth(s.date)}</span>
                      <span className="agenda__meta">{s.duration} min · {fmtMoney(s.amount)}</span>
                      <span className="agenda__pills">
                        <StatusPicker session={s} />
                        <PaymentPicker session={s} />
                      </span>
                    </span>
                    {canManageCare && <IconBtn name="edit" label="Edytuj sesję" size={16} onClick={() => openSessionForm({ session: s })} />}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState compact icon="calendar" title="Brak najbliższych spotkań" hint="Umów spotkanie, aby pojawiło się w planie opieki." />
            )}
          </div>
        </section>

        <section className="client-record__section" aria-labelledby="attendance-history-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="attendance-history-title">
              Historia frekwencji
              <span className="faint" style={{ fontSize: 13, fontFamily: 'var(--font-ui)' }}>
                {history.length} {sessionsWord(history.length)}
              </span>
            </h2>
            {history.length > 0 ? (
              <>
              <div className="table-scroll table-scroll--until-tablet">
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
                    {historyPages.pageItems.map((s) => (
                      <tr key={s.id}>
                        <td style={{ fontWeight: 600 }} data-th="Data">{fmtShortDate(s.date)}</td>
                        <td className="num-cell muted" data-th="Godzina">{s.time}</td>
                        <td data-th="Status"><StatusPicker session={s} /></td>
                        <td className="right num-cell" data-th="Kwota">{fmtMoney(s.amount)}</td>
                        <td data-th="Płatność"><PaymentPicker session={s} /></td>
                        <td className="right td--actions" style={{ width: 44 }}>
                          {canManageCare && <IconBtn name="edit" label="Edytuj sesję" size={15} onClick={() => openSessionForm({ session: s })} />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={historyPages.page} pages={historyPages.pages} onPage={historyPages.setPage} />
              </>
            ) : (
              <EmptyState compact icon="calendar" title="Brak historii frekwencji" hint="Odbyte, odwołane i nieobecne spotkania pojawią się tutaj." />
            )}
          </div>
        </section>

        <section className="client-record__section" aria-labelledby="clinical-notes-title" data-reveal>
          <div className="card card--pad">
            <h2 className="card-title" id="clinical-notes-title">Notatki kliniczne</h2>
            {canReadClinicalNotes ? (
              <>
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
              </>
            ) : (
              <p className="clinical-notes__restricted">Notatki są dostępne w widoku specjalistki.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
