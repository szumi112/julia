import { useEffect, useMemo, useState } from 'react'
import { useApp, monthStats, clientOutstanding, lastSessionOf, upcomingSessions, revenueSeries } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { useMinuteNow } from '../clock.js'
import { Avatar, Pill, Button, Chip, IconBtn, EmptyState, Stat } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { AreaChart } from '../charts.jsx'
import {
  fmtMoney, fmtNumber, fmtShortDate, monthKey, addMonths, fmtMonthName,
  sessionsWord, fmtDayMonth, clientsWord, plural, toISODate,
} from '../format.js'
import { sessionConflicts, specialistWeekLoad } from '../workspace.js'
import { EntityLink, FilterBar, FilterGroup } from '../ux-patterns.jsx'

const TEAM_FILTERS = [
  { value: 'all', label: 'Cały zespół' },
  { value: 'available', label: 'Dostępne miejsca' },
  { value: 'full', label: 'Pełne obłożenie' },
]

function TeamCard({ clients, conflicts, load, psychologist, sessions, today }) {
  const titleId = `team-specialist-title-${psychologist.id}`
  const todaySessions = sessions
    .filter((session) => session.date === today && session.status !== 'cancelled')
    .toSorted((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
  const calendarSession = sessions
    .filter((session) => session.status !== 'cancelled')
    .toSorted((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.id.localeCompare(b.id))[0]
  const capacityText = load.remaining > 0
    ? `Pozostało ${load.remaining} ${sessionsWord(load.remaining)}`
    : load.remaining === 0
      ? 'Pełne obłożenie'
      : `Przekroczono limit o ${Math.abs(load.remaining)} ${sessionsWord(Math.abs(load.remaining))}`

  return (
    <article
      className={`card team-card team-card--${load.status}`}
      data-reveal
      data-psych-id={psychologist.id}
      aria-labelledby={titleId}
    >
      <span className="team-card__band" style={{ background: `linear-gradient(90deg, ${psychologist.color}, ${psychologist.color}55)` }} />
      <EntityLink
        route="psych"
        params={{ id: psychologist.id }}
        label={`Otwórz profil — ${psychologist.name}`}
        className="team-card__profile"
      >
        <Avatar name={psychologist.name} color={psychologist.color} size={52} />
        <div className="team-card__identity">
          <h2 className="team-card__name" id={titleId}>{psychologist.title} {psychologist.name}</h2>
          <span className="team-card__spec">{psychologist.spec}</span>
          <span className="team-card__today">
            {todaySessions.length > 0
              ? <>dziś <b>{todaySessions.length} {sessionsWord(todaySessions.length)}</b> · {todaySessions.map((session) => session.time).join(', ')}</>
              : 'dziś bez sesji'}
          </span>
        </div>
        <Icon name="chevR" size={18} className="faint" />
      </EntityLink>

      <div className="team-card__capacity">
        <div className="row row--between">
          <strong>{load.booked} / {load.capacity} sesji w tym tygodniu</strong>
          <span className={`team-card__capacity-state is-${load.status}`}>{capacityText}</span>
        </div>
        <progress
          max={load.capacity}
          value={Math.min(load.booked, load.capacity)}
          aria-label={`Obłożenie — ${psychologist.name}: ${load.booked} z ${load.capacity} sesji`}
          aria-valuetext={capacityText}
        />
      </div>

      {conflicts.length > 0 ? (
        <div className="team-card__conflicts">
          {conflicts.map((conflict) => {
            const conflictSessions = conflict.sessionIds
              .map((id) => sessions.find((session) => session.id === id))
              .filter(Boolean)
              .toSorted((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
            return (
              <div className="team-conflict" role="alert" key={`${conflict.date}:${conflict.sessionIds.join(':')}`}>
                <Icon name="alert" size={16} />
                <span>
                  <b>Konflikt w kalendarzu</b>
                  <span>{fmtDayMonth(conflict.date)} · {conflictSessions.length > 1 && conflictSessions.every((session) => session.time === conflictSessions[0].time)
                    ? `${conflictSessions.length}× ${conflictSessions[0].time}`
                    : conflictSessions.map((session) => session.time).join(' i ')}</span>
                </span>
                <EntityLink
                  route="calendar"
                  params={{ date: conflict.date, highlightSessionIds: conflict.sessionIds }}
                  label={`Otwórz konflikt — ${psychologist.name}, ${fmtDayMonth(conflict.date)}, ${conflictSessions.map((session) => `${session.time} (${session.id})`).join(' i ')}`}
                >
                  Sprawdź
                </EntityLink>
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="team-card__footer">
        <span>{clients.length} {clientsWord(clients.length)}</span>
        <nav className="team-card__actions" aria-label={`Skróty — ${psychologist.name}`}>
          <EntityLink
            route="clients"
            params={{ specialist: psychologist.id }}
            label={`Klienci — ${psychologist.name}`}
          >
            <Icon name="clients" size={15} /> Klienci
          </EntityLink>
          <EntityLink
            route="calendar"
            params={{
              date: calendarSession?.date || today,
              highlightSessionIds: calendarSession ? [calendarSession.id] : undefined,
            }}
            label={`Kalendarz — ${psychologist.name}`}
          >
            <Icon name="calendar" size={15} /> Kalendarz
          </EntityLink>
        </nav>
      </div>
    </article>
  )
}

export function Team() {
  const { state } = useApp()
  const { appMode, getViewState, openPsychForm, patchViewState } = useShell()
  const isApp = appMode === 'app'
  const ref = useReveal()
  const now = useMinuteNow()
  const today = toISODate(now)
  const [filter, setFilter] = useState(() => {
    const saved = getViewState('team', { filter: 'all' })
    return TEAM_FILTERS.some((option) => option.value === saved.filter) ? saved.filter : 'all'
  })
  const psychologists = useMemo(
    () => state.psychologists.toSorted((a, b) => a.name.localeCompare(b.name, 'pl')),
    [state.psychologists]
  )
  const loads = useMemo(
    () => new Map(psychologists.map((psychologist) => [
      psychologist.id,
      specialistWeekLoad(state.sessions, psychologist, now),
    ])),
    [now.getDate(), now.getMonth(), now.getFullYear(), psychologists, state.sessions]
  )
  const firstLoad = loads.values().next().value
  const weekSessions = useMemo(
    () => firstLoad
      ? state.sessions.filter((session) => session.date >= firstLoad.start && session.date <= firstLoad.end)
      : [],
    [firstLoad, state.sessions]
  )
  const conflictsByPsychologist = useMemo(() => {
    const map = new Map()
    for (const conflict of sessionConflicts(weekSessions)) {
      const current = map.get(conflict.psychId) || []
      current.push(conflict)
      map.set(conflict.psychId, current)
    }
    return map
  }, [weekSessions])
  const visible = psychologists.filter((psychologist) => {
    const load = loads.get(psychologist.id)
    if (filter === 'available') return load.booked < load.capacity
    if (filter === 'full') return load.booked >= load.capacity
    return true
  })

  useEffect(() => {
    patchViewState('team', { filter })
  }, [filter, patchViewState])

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Specjalistki</div>
          <h1 className="display view-head__title">Zespół <em>centrum</em></h1>
          <p className="view-head__sub">
            Obłożenie od poniedziałku do niedzieli{firstLoad ? ` · ${fmtDayMonth(firstLoad.start)} – ${fmtDayMonth(firstLoad.end)}` : ''}. Konflikty prowadzą prosto do właściwych sesji.
          </p>
        </div>
        {!isApp && <div className="view-head__actions">
          <Button icon="plus" magnetic onClick={() => openPsychForm()}>
            Dodaj specjalistkę
          </Button>
        </div>}
      </div>

      {state.psychologists.length === 0 && (
        <div className="card card--pad" data-reveal>
          <EmptyState
            icon="team"
            title="Zespół jest jeszcze pusty"
            hint="Dodaj pierwszą specjalistkę, aby przypisywać jej klientów i sesje."
            action={!isApp && <Button size="sm" icon="plus" onClick={() => openPsychForm()}>Dodaj specjalistkę</Button>}
          />
        </div>
      )}

      {state.psychologists.length > 0 ? (
        <div data-reveal className="team-toolbar">
          <FilterBar
            activeCount={filter === 'all' ? 0 : 1}
            summary={TEAM_FILTERS.find((option) => option.value === filter)?.label || ''}
            onClear={() => setFilter('all')}
            label="Filtry zespołu"
          >
            <FilterGroup label="Obłożenie">
              {TEAM_FILTERS.map((option) => (
                <Chip key={option.value} on={filter === option.value} onClick={() => setFilter(option.value)}>
                  {option.label}
                </Chip>
              ))}
            </FilterGroup>
          </FilterBar>
          <p className="team-results" role="status" aria-live="polite" aria-label="Liczba specjalistek">
            {visible.length} {plural(visible.length, 'specjalistka', 'specjalistki', 'specjalistek')}
          </p>
        </div>
      ) : null}

      <div className="grid-2 team-grid">
        {visible.map((psychologist) => (
          <TeamCard
            key={psychologist.id}
            clients={state.clients.filter((client) => client.psychId === psychologist.id)}
            conflicts={conflictsByPsychologist.get(psychologist.id) || []}
            load={loads.get(psychologist.id)}
            psychologist={psychologist}
            sessions={weekSessions.filter((session) => session.psychId === psychologist.id)}
            today={today}
          />
        ))}
      </div>
      {state.psychologists.length > 0 && visible.length === 0 ? (
        <div className="card card--pad" data-reveal>
          <EmptyState compact icon="team" title="Brak specjalistek w tym filtrze" hint="Zmień filtr obłożenia, aby zobaczyć pozostałe osoby." />
        </div>
      ) : null}
    </div>
  )
}

export function PsychDetail({ params }) {
  const { state } = useApp()
  const { appMode, openSessionForm, openPsychForm } = useShell()
  const isApp = appMode === 'app'
  const ref = useReveal([params.id])
  const [debtOnly, setDebtOnly] = useState(false)
  const psych = state.psychologists.find((p) => p.id === params.id)
  if (!psych) {
    return (
      <EmptyState
        icon="team"
        title="Nie znaleziono profilu"
        hint="Być może profil został usunięty z zespołu."
        action={<EntityLink route="team" className="btn btn--soft btn--sm"><span>Wróć do zespołu</span></EntityLink>}
      />
    )
  }

  const ym = monthKey(new Date())
  const months = Array.from({ length: 6 }, (_, i) => addMonths(ym, i - 5))
  const own = state.sessions.filter((s) => s.psychId === psych.id)
  const series = revenueSeries(own, months)
  const stats = monthStats(own, ym)
  const clients = state.clients.filter((c) => c.psychId === psych.id)
  const visibleClients = debtOnly
    ? clients.filter((c) => clientOutstanding(state.sessions, c.id) > 0)
    : clients
  const upcoming = upcomingSessions(own, 5)
  const clientOf = (id) => state.clients.find((c) => c.id === id)

  return (
    <div ref={ref}>
      <EntityLink route="team" className="link row" style={{ gap: 7, marginBottom: 20, width: 'fit-content' }} data-reveal>
        <Icon name="arrowL" size={16} /> Wróć do zespołu
      </EntityLink>

      <div className="id-band" data-reveal style={{ '--band-color': psych.color }}>
        <Avatar name={psych.name} color={psych.color} size={64} />
        <div className="id-band__main">
          <h1 className="display id-band__name">{psych.title} {psych.name}</h1>
          <div className="id-band__sub">{psych.spec}</div>
          <div className="id-band__meta">
            {psych.email && <span><Icon name="mail" size={14} /> {psych.email}</span>}
            {psych.phone && <span><Icon name="phone" size={14} /> {psych.phone}</span>}
            {psych.room && <span><Icon name="room" size={14} /> {psych.room}</span>}
          </div>
          <div className="id-band__pills">
            <Pill tone="amber">{fmtMoney(psych.rate)} / sesja</Pill>
          </div>
        </div>
        {!isApp && <div className="id-band__actions">
          <Button variant="ghost" icon="edit" onClick={() => openPsychForm({ psych })}>Edytuj profil</Button>
          <Button icon="plus" onClick={() => openSessionForm({ psychId: psych.id })}>Nowa sesja</Button>
        </div>}
      </div>

      <div className="stats-row stats-row--4">
        <Stat label="Klienci" value={clients.length} fmt={fmtNumber} />
        <Stat label={`Sesje · ${fmtMonthName(ym)}`} value={stats.count} fmt={(v) => fmtNumber(Math.round(v))} />
        <Stat label={`Godziny · ${fmtMonthName(ym)}`} value={stats.hours} fmt={(v) => `${fmtNumber(Math.round(v))} h`} />
        <Stat label={`Przychód · ${fmtMonthName(ym)}`} value={stats.revenue} fmt={fmtMoney} />
      </div>

      <div className="grid-31" style={{ marginTop: 4 }}>
        <div className="stack">
          <div className="card card--pad" data-reveal>
            <h2 className="card-title">Klienci pod opieką</h2>
            {clients.length > 0 && (
              <div className="row chips-row" style={{ marginTop: 12, marginBottom: 0 }}>
                <Chip on={!debtOnly} onClick={() => setDebtOnly(false)}>Wszyscy</Chip>
                <Chip on={debtOnly} onClick={() => setDebtOnly(true)}>
                  <Icon name="payments" size={14} /> Z zaległościami
                </Chip>
              </div>
            )}
            <table className="table table--cards" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Klient</th>
                  <th>Ostatnia sesja</th>
                  <th className="right">Sesje</th>
                  <th className="right">Zaległość</th>
                </tr>
              </thead>
              <tbody>
                {clients.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <EmptyState compact icon="clients" title="Brak przypisanych klientów" hint="Przypisz klienta tej specjalistce w jego karcie." />
                    </td>
                  </tr>
                )}
                {clients.length > 0 && visibleClients.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <EmptyState compact icon="check" title="Brak zaległości" hint="Wszyscy klienci tej specjalistki są rozliczeni." />
                    </td>
                  </tr>
                )}
                {visibleClients.map((c) => {
                  const last = lastSessionOf(state.sessions, c.id)
                  const count = state.sessions.filter((s) => s.clientId === c.id && s.status === 'completed').length
                  const debt = clientOutstanding(state.sessions, c.id)
                  return (
                    <tr key={c.id}>
                      <td>
                        <span className="row" style={{ gap: 11 }}>
                          <Avatar name={c.name} color={psych.color} size={32} />
                          <EntityLink
                            route="client"
                            params={{ id: c.id }}
                            label={`Otwórz kartę: ${c.name}`}
                            style={{ fontWeight: 600 }}
                          >
                            {c.name}
                          </EntityLink>
                        </span>
                      </td>
                      <td className="muted" data-th="Ostatnia sesja">{last ? fmtShortDate(last.date) : '—'}</td>
                      <td className="right num-cell" data-th="Sesje">{count}</td>
                      <td className="right" data-th="Zaległość">
                        {debt > 0 ? <Pill tone="amber">{fmtMoney(debt)}</Pill> : <span className="faint">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="card card--pad" data-reveal>
            <h2 className="card-title">Przychód · ostatnie 6 miesięcy</h2>
            <div style={{ marginTop: 12 }}>
              <AreaChart data={series} height={200} />
            </div>
          </div>
        </div>

        <div className="card card--pad" data-reveal style={{ alignSelf: 'start' }}>
          <h2 className="card-title">Najbliższe sesje</h2>
          <div className="agenda" style={{ marginTop: 6 }}>
            {upcoming.length === 0 && (
              <EmptyState
                compact
                icon="calendar"
                title="Brak zaplanowanych sesji"
                action={!isApp && <Button size="sm" variant="soft" icon="plus" onClick={() => openSessionForm({ psychId: psych.id })}>Nowa sesja</Button>}
              />
            )}
            {upcoming.map((s) => {
              const Row = isApp ? 'div' : 'button'
              return (
                <Row key={s.id} className={`agenda__row ${isApp ? '' : 'hover-row'}`} style={{ width: '100%', textAlign: 'left' }}
                  onClick={isApp ? undefined : () => openSessionForm({ session: s })}>
                  <span className="agenda__time">{s.time}</span>
                  <span className="agenda__main">
                    <span className="agenda__client">{clientOf(s.clientId)?.name}</span>
                    <span className="agenda__meta">{fmtDayMonth(s.date)} · {s.duration} min</span>
                  </span>
                  <Icon name="chevR" size={15} className="faint" />
                </Row>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
