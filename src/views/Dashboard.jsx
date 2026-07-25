import { Fragment, useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useDrawerFX } from '../anim.js'
import { useMinuteNow } from '../clock.js'
import { Button, Avatar, IconBtn, EmptyState, Figure } from '../ui.jsx'
import { todayWorkspace } from '../workspace.js'
import {
  fmtMoney, fmtWeekday, fmtFullDate, toISODate, pad2,
  cap, plural, timeToMin, relDayLabel,
} from '../format.js'

// A row only earns a status word when its state isn't obvious from the clock.
const ROW_STATUS = { completed: 'odbyta', noshow: 'nieobecność' }

// today's sessions in plain time order — the "teraz" marker carries the ordering
// so no row has to explain its own position
function TodayThread({ sessions, nowMin, currentId, onOpen }) {
  return (
    <div className="dash-hero__day" data-reveal>
      <div className="spine">
        <span className="spine__rule" data-spine aria-hidden="true" />
        {sessions.map((session, i) => {
          const live = session.id === currentId
          // placed like the cockpit's: before the first session yet to start,
          // and only when nothing is running to mark the spot already
          const markerHere = !currentId
            && timeToMin(session.time) > nowMin
            && (i === 0 || timeToMin(sessions[i - 1].time) <= nowMin)
          const overdue = session.status === 'scheduled'
            && !live
            && timeToMin(session.time) + (session.duration || 50) <= nowMin
          const status = live ? 'trwa' : overdue ? 'wymaga statusu' : ROW_STATUS[session.status] || ''
          return (
            <Fragment key={session.id}>
              {markerHere && <div className="spine__now" aria-hidden="true">teraz</div>}
              <button
                className={`spine__row today-session ${live ? 'is-live' : ''} ${session.status === 'completed' ? 'is-done' : ''}`}
                data-status={session.status}
                style={{ '--node-color': session.psych?.color }}
                onClick={() => onOpen(session)}
              >
                <span className="spine__time">{session.time}</span>
                <span className="spine__name">{session.client?.name}</span>
                <span className="today-session__status">{status}</span>
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

function BoardPost({ post }) {
  const { state, dispatch, toast } = useApp()
  const color = state.psychologists.find((p) => p.name === post.author)?.color
  return (
    <div className="bpost">
      <Avatar name={post.author} color={color} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bpost__meta">
          <b>{post.author}</b> · {relDayLabel(post.date)}, {post.time}
        </div>
        <div className="bpost__text">{post.text}</div>
      </div>
      <IconBtn
        name="trash"
        label="Usuń wpis"
        size={14}
        className="bpost__del"
        onClick={() => {
          const index = state.posts.findIndex((entry) => entry.id === post.id)
          dispatch({ type: 'DELETE_POST', id: post.id })
          toast('Wpis usunięty z tablicy', 'close', {
            label: 'Cofnij',
            key: `post:${post.id}`,
            timeoutMs: 5000,
            onClick: () => dispatch({ type: 'RESTORE_POST', post, index }),
          })
        }}
      />
    </div>
  )
}

function BoardComposer() {
  const { state, dispatch, toast } = useApp()
  const [text, setText] = useState('')

  const publish = () => {
    const t = text.trim()
    if (!t) return
    const now = new Date()
    dispatch({
      type: 'ADD_POST',
      post: {
        author: state.user.name,
        text: t,
        date: toISODate(now),
        time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
      },
    })
    setText('')
    toast('Wpis dodany na tablicę')
  }

  return (
    <div className="note-composer">
      <textarea
        className="textarea"
        value={text}
        placeholder="Krótka wiadomość dla zespołu…"
        aria-label="Nowy wpis na tablicy"
        onChange={(e) => setText(e.target.value)}
      />
      <div>
        <Button size="sm" variant="soft" icon="plus" onClick={publish} disabled={!text.trim()}>
          Opublikuj
        </Button>
      </div>
    </div>
  )
}

// Full board — slide-over with the composer and complete history.
export function BoardDrawer({ onClose }) {
  const { state } = useApp()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const { close } = useDrawerFX(drawerRef, backRef, onClose)

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label="Tablica zespołu">
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">Tablica zespołu</h2>
            <p className="drawer__sub">
              {state.posts.length} {plural(state.posts.length, 'wpis', 'wpisy', 'wpisów')} — ogłoszenia i wiadomości dla zespołu.
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>
        <div className="drawer__body">
          <BoardComposer />
          <div>
            {state.posts.length === 0 && (
              <EmptyState compact icon="pin" title="Tablica jest pusta" hint="Zostaw zespołowi pierwszą wiadomość." />
            )}
            {state.posts.map((p) => (
              <BoardPost key={p.id} post={p} />
            ))}
          </div>
        </div>
        <div className="drawer__foot">
          <Button variant="ghost" className="btn--full" onClick={close}>Zamknij</Button>
        </div>
      </aside>
    </>
  )
}

export function Dashboard() {
  const { state } = useApp()
  const { openSessionForm, openClientForm, openTeamBoard, navigate, role } = useShell()
  const ref = useReveal()

  // minute-aligned shared clock — "Trwa teraz" / "Następna sesja" never go stale
  const now = useMinuteNow()
  const today = toISODate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const workspace = todayWorkspace(state, role, now)
  const heroSession = workspace.current || workspace.next

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const clientOf = (id) => state.clients.find((c) => c.id === id)

  const todays = workspace.schedule
    .map((s) => ({ ...s, psych: psychOf(s.psychId), client: clientOf(s.clientId) }))
  const daySummary = workspace.daySummary
  const heroPsych = heroSession ? psychOf(heroSession.psychId) : null
  const heroClient = heroSession ? clientOf(heroSession.clientId) : null
  const heroState = workspace.current ? 'Trwa teraz' : workspace.next ? 'Następna sesja' : null
  const terminalHeading = daySummary.unresolvedPast > 0
    ? `${daySummary.unresolvedPast} sesji wymaga statusu`
    : daySummary.total > 0 ? 'Dzień zakończony' : 'Wolny dzień'
  const terminalSupport = daySummary.unresolvedPast > 0
    ? 'Zaktualizuj status zakończonych sesji, aby domknąć plan dnia.'
    : daySummary.total > 0
      ? 'Wszystkie dzisiejsze sesje mają uzupełniony status.'
      : 'Kalendarz jest dziś pusty — czas na oddech.'

  // The masthead is just the cover date; the nearest session follows as the lede.
  // Therapists have no Payments route, so their arrears stay a plain figure.
  const canOpenPayments = role.scope !== 'own'
  const showBoard = ['owner', 'coordinator'].includes(role.id)

  return (
    <section className="today-page" role="region" aria-label="Pulpit dnia" ref={ref}>
      <header className="today-hero" data-reveal>
        <h1 className="display masthead__day">{cap(fmtWeekday(today))}, {fmtFullDate(today)}</h1>
        <hr className="today-rule today-rule--masthead" aria-hidden="true" />
        {heroSession ? (
          <>
            <p className="today-hero__state">{heroState}</p>
            <p className="display today-hero__time">{heroSession.time}</p>
            <p className="display today-hero__name">{heroClient?.name}</p>
            <p className="today-hero__meta">
              {heroPsych?.room || 'Gabinet do potwierdzenia'} · {heroPsych?.name}
            </p>
          </>
        ) : (
          <>
            <h2 className="display today-hero__title">{terminalHeading}</h2>
            <p className="today-hero__meta">{terminalSupport}</p>
          </>
        )}
        <div className="today-hero__actions">
          {heroSession && (
            <Button magnetic onClick={() => openSessionForm({ session: heroSession })}>Otwórz sesję</Button>
          )}
          <Button
            variant={heroSession ? 'ghost' : 'primary'}
            icon="plus"
            magnetic={!heroSession}
            onClick={() => openSessionForm()}
          >
            Nowa sesja
          </Button>
          <button className="link" onClick={() => openClientForm()}>Nowy klient</button>
        </div>
      </header>

      <div className="figures today-figures" role="group" aria-label="Podsumowanie dnia">
        <Figure label="Odbyte" value={daySummary.completed} suffix={`/${daySummary.total}`} />
        <Figure label="Nieobecności" value={daySummary.noshow} />
        <Figure label="Pozostałe" value={daySummary.scheduled} />
        <Figure
          label="Zaległe"
          value={workspace.outstanding}
          fmt={fmtMoney}
          attention={workspace.outstanding > 0}
          onClick={canOpenPayments
            ? () => navigate('payments', { allPeriods: true, unpaidOnly: true })
            : undefined}
        />
      </div>

      {daySummary.total > 0 && (
        <section className="today-plan" aria-label="Plan dnia">
          <TodayThread
            sessions={todays}
            nowMin={nowMin}
            currentId={workspace.current?.id}
            onOpen={(s) => openSessionForm({ session: state.sessions.find((x) => x.id === s.id) })}
          />
        </section>
      )}

      {showBoard && (
        <section className="today-links" aria-label="Skróty" data-reveal>
          <button className="today-links__item" onClick={openTeamBoard}>Tablica zespołu</button>
        </section>
      )}
    </section>
  )
}
