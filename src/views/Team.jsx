import { useMemo, useState } from 'react'
import { useApp, monthStats, clientOutstanding, lastSessionOf, upcomingSessions, revenueSeries } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useCountUp } from '../anim.js'
import { Avatar, Pill, Button, Chip, IconBtn, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { AreaChart } from '../charts.jsx'
import {
  fmtMoney, fmtNumber, fmtShortDate, monthKey, addMonths, fmtMonthName,
  sessionsWord, fmtDayMonth, clientsWord, toISODate,
} from '../format.js'

export function Team() {
  const { state } = useApp()
  const { navigate, openPsychForm } = useShell()
  const ref = useReveal()
  const ym = monthKey(new Date())
  const today = toISODate(new Date())
  const monthShort = fmtMonthName(ym).slice(0, 3)

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Specjalistki</div>
          <h1 className="display view-head__title">Zespół <em>Aurelii</em></h1>
          <p className="view-head__sub">
            Każda specjalistka ma własną listę klientów. Wejdź w profil, by zobaczyć obciążenie i podsumowanie miesiąca.
          </p>
        </div>
        <div className="view-head__actions">
          <Button icon="plus" magnetic onClick={() => openPsychForm()}>
            Dodaj specjalistkę
          </Button>
        </div>
      </div>

      {state.psychologists.length === 0 && (
        <div className="card card--pad" data-reveal>
          <EmptyState
            icon="team"
            title="Zespół jest jeszcze pusty"
            hint="Dodaj pierwszą specjalistkę, aby przypisywać jej klientów i sesje."
            action={<Button size="sm" icon="plus" onClick={() => openPsychForm()}>Dodaj specjalistkę</Button>}
          />
        </div>
      )}

      <div className="grid-2">
        {state.psychologists.map((p) => {
          const clients = state.clients.filter((c) => c.psychId === p.id)
          const stats = monthStats(state.sessions.filter((s) => s.psychId === p.id), ym)
          const todays = state.sessions
            .filter((s) => s.psychId === p.id && s.date === today && s.status !== 'cancelled')
            .sort((a, b) => (a.time < b.time ? -1 : 1))
          return (
            <div className="card psy-card" key={p.id} data-reveal onClick={() => navigate('psych', { id: p.id })}
              role="button" tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  navigate('psych', { id: p.id })
                }
              }}>
              <span className="psy-card__band" style={{ background: `linear-gradient(90deg, ${p.color}, ${p.color}55)` }} />
              <div className="row" style={{ gap: 16 }}>
                <Avatar name={p.name} color={p.color} size={52} />
                <div style={{ flex: 1 }}>
                  <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 21, fontWeight: 490 }}>
                    {p.title} {p.name}
                  </h2>
                  <div className="psy-card__spec">{p.spec}</div>
                  <div className="psy-card__today">
                    {todays.length > 0
                      ? <>dziś <b>{todays.length} {sessionsWord(todays.length)}</b> · {todays.map((s) => s.time).join(', ')}</>
                      : 'dziś bez sesji'}
                  </div>
                </div>
                <Icon name="chevR" size={18} className="faint" />
              </div>
              <div className="psy-card__stats">
                <div className="psy-card__stat">
                  <b>{clients.length}</b>
                  <span>{clientsWord(clients.length)}</span>
                </div>
                <div className="psy-card__stat">
                  <b>{stats.count}</b>
                  <span>{sessionsWord(stats.count)} · {monthShort}</span>
                </div>
                <div className="psy-card__stat">
                  <b>{Math.round(stats.hours)} h</b>
                  <span>godziny · {monthShort}</span>
                </div>
                <div className="psy-card__stat">
                  <b>{fmtMoney(stats.revenue)}</b>
                  <span>przychód · {monthShort}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PsychStat({ label, value, fmt }) {
  const ref = useCountUp(value, fmt)
  return (
    <div className="card stat card--lift" data-reveal>
      <div className="stat__label">{label}</div>
      <div className="stat__value"><span ref={ref}>0</span></div>
    </div>
  )
}

export function PsychDetail({ params }) {
  const { state } = useApp()
  const { navigate, openSessionForm, openPsychForm } = useShell()
  const ref = useReveal([params.id])
  const [debtOnly, setDebtOnly] = useState(false)
  const psych = state.psychologists.find((p) => p.id === params.id)
  if (!psych) {
    return (
      <EmptyState
        icon="team"
        title="Nie znaleziono profilu"
        hint="Być może profil został usunięty z zespołu."
        action={<Button size="sm" variant="soft" onClick={() => navigate('team')}>Wróć do zespołu</Button>}
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
      <button className="link row" style={{ gap: 7, marginBottom: 20 }} onClick={() => navigate('team')} data-reveal>
        <Icon name="arrowL" size={16} /> Wróć do zespołu
      </button>

      <div className="id-band" data-reveal style={{ '--band-color': psych.color }}>
        <Avatar name={psych.name} color={psych.color} size={64} />
        <div className="id-band__main">
          <h1 className="display id-band__name">{psych.title} {psych.name}</h1>
          <div className="id-band__sub">{psych.spec}</div>
          <div className="id-band__meta">
            <span><Icon name="mail" size={14} /> {psych.email}</span>
            <span><Icon name="phone" size={14} /> {psych.phone}</span>
            <span><Icon name="room" size={14} /> {psych.room}</span>
          </div>
          <div className="id-band__pills">
            <Pill tone="gold">{fmtMoney(psych.rate)} / sesja</Pill>
          </div>
        </div>
        <div className="id-band__actions">
          <Button variant="ghost" icon="edit" onClick={() => openPsychForm({ psych })}>Edytuj profil</Button>
          <Button icon="plus" onClick={() => openSessionForm({ psychId: psych.id })}>Nowa sesja</Button>
        </div>
      </div>

      <div className="stats-row stats-row--4">
        <PsychStat label="Klienci" value={clients.length} fmt={fmtNumber} />
        <PsychStat label={`Sesje · ${fmtMonthName(ym)}`} value={stats.count} fmt={(v) => fmtNumber(Math.round(v))} />
        <PsychStat label={`Godziny · ${fmtMonthName(ym)}`} value={stats.hours} fmt={(v) => `${fmtNumber(Math.round(v))} h`} />
        <PsychStat label={`Przychód · ${fmtMonthName(ym)}`} value={stats.revenue} fmt={fmtMoney} />
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
                    <tr
                      key={c.id}
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
                        <span className="row" style={{ gap: 11 }}>
                          <Avatar name={c.name} color={psych.color} size={32} />
                          <span style={{ fontWeight: 600 }}>{c.name}</span>
                        </span>
                      </td>
                      <td className="muted" data-th="Ostatnia sesja">{last ? fmtShortDate(last.date) : '—'}</td>
                      <td className="right num-cell" data-th="Sesje">{count}</td>
                      <td className="right" data-th="Zaległość">
                        {debt > 0 ? <Pill tone="gold">{fmtMoney(debt)}</Pill> : <span className="faint">—</span>}
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
                action={<Button size="sm" variant="soft" icon="plus" onClick={() => openSessionForm({ psychId: psych.id })}>Nowa sesja</Button>}
              />
            )}
            {upcoming.map((s) => (
              <button key={s.id} className="agenda__row hover-row" style={{ width: '100%', textAlign: 'left' }}
                onClick={() => openSessionForm({ session: s })}>
                <span className="agenda__time">{s.time}</span>
                <span className="agenda__main">
                  <span className="agenda__client">{clientOf(s.clientId)?.name}</span>
                  <span className="agenda__meta">{fmtDayMonth(s.date)} · {s.duration} min</span>
                </span>
                <Icon name="chevR" size={15} className="faint" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
