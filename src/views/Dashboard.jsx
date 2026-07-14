import { useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useDrawerFX } from '../anim.js'
import { Button, Avatar, IconBtn, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { todayWorkspace } from '../workspace.js'
import {
  fmtMoney, fmtWeekday, fmtDayMonth, fmtShortDate, toISODate, pad2,
  cap, plural, timeToMin,
} from '../format.js'

// today's sessions on the day thread — the hero's working half
function TodayThread({ sessions, nowMin, currentId, nextId, onOpen }) {
  const [completedOpen, setCompletedOpen] = useState(false)
  const scheduled = sessions.filter((session) => session.status === 'scheduled')
  const current = scheduled.filter((session) => session.id === currentId)
  const concurrent = scheduled.filter((session) => {
    const start = timeToMin(session.time)
    return session.id !== currentId && start <= nowMin && nowMin < start + (session.duration || 50)
  })
  const next = scheduled.filter((session) => session.id === nextId && session.id !== currentId)
  const unresolved = scheduled.filter((session) => (
    session.id !== currentId
    && session.id !== nextId
    && !concurrent.some((currentSession) => currentSession.id === session.id)
    && timeToMin(session.time) + (session.duration || 50) <= nowMin
  ))
  const future = scheduled.filter((session) => (
    session.id !== currentId
    && session.id !== nextId
    && !concurrent.some((currentSession) => currentSession.id === session.id)
    && timeToMin(session.time) > nowMin
  ))
  const noShows = sessions.filter((session) => session.status === 'noshow')
  const completed = sessions.filter((session) => session.status === 'completed')
  const visible = [
    ...current.map((session) => ({ session, priority: 'current', status: 'Zaplanowana · Trwa teraz' })),
    ...concurrent.map((session) => ({ session, priority: 'current', status: 'Zaplanowana · Trwa teraz' })),
    ...next.map((session) => ({ session, priority: 'next', status: 'Zaplanowana · Następna sesja' })),
    ...unresolved.map((session) => ({ session, priority: 'unresolved', status: 'Zaplanowana · Wymaga statusu' })),
    ...future.map((session) => ({ session, priority: 'future', status: 'Zaplanowana' })),
    ...noShows.map((session) => ({ session, priority: 'noshow', status: 'Nieobecność' })),
  ]

  const row = ({ session, priority, status }) => (
    <button
      key={session.id}
      className={`spine__row today-session ${priority === 'current' ? 'is-live' : ''} ${priority === 'next' ? 'is-next' : ''}`}
      data-priority={priority}
      data-status={session.status}
      style={{ '--node-color': session.psych?.color }}
      onClick={() => onOpen(session)}
    >
      <span className="spine__time">{session.time}</span>
      <span className="spine__name">{session.client?.name}</span>
      <span className="today-session__status">{status}</span>
    </button>
  )

  return (
    <div className="dash-hero__day" data-reveal>
      <div className="spine">
        <span className="spine__rule" data-spine aria-hidden="true" />
        {visible.map(row)}
        {completed.length > 0 && (
          <div className="today-completed">
            <button
              type="button"
              className="today-completed__trigger"
              aria-expanded={completedOpen}
              aria-controls="today-completed-sessions"
              onClick={() => setCompletedOpen((open) => !open)}
            >
              Odbyte ({completed.length})
            </button>
            {completedOpen && (
              <div id="today-completed-sessions">
                {completed.map((session) => row({ session, priority: 'completed', status: 'Odbyta' }))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// The dashboard only links to destinations that help with today's work.
// Detailed finance, reporting and team views stay in the main navigation.

const TODAY_SHORTCUTS = [
  { id: 'calendar', label: 'Kalendarz', icon: 'calendar' },
  { id: 'clients', label: 'Klienci', icon: 'clients' },
  { id: 'board', label: 'Tablica zespołu', icon: 'pin', roles: ['owner', 'coordinator'] },
  { id: 'tus', label: 'Zajęcia TUS', icon: 'group' },
]

const relDay = (iso) => {
  const today = toISODate(new Date())
  const y = new Date()
  y.setDate(y.getDate() - 1)
  return iso === today ? 'dziś' : iso === toISODate(y) ? 'wczoraj' : fmtShortDate(iso)
}

function BoardPost({ post }) {
  const { state, dispatch, toast } = useApp()
  const color = state.psychologists.find((p) => p.name === post.author)?.color
  return (
    <div className="bpost">
      <Avatar name={post.author} color={color} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bpost__meta">
          <b>{post.author}</b> · {relDay(post.date)}, {post.time}
        </div>
        <div className="bpost__text">{post.text}</div>
      </div>
      <IconBtn
        name="trash"
        label="Usuń wpis"
        size={14}
        className="bpost__del"
        onClick={() => {
          dispatch({ type: 'DELETE_POST', id: post.id })
          toast('Wpis usunięty z tablicy', 'close')
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
  const { navigate, openSessionForm, openClientForm, openTeamBoard, role } = useShell()
  const ref = useReveal()

  const now = new Date()
  const today = toISODate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const workspace = todayWorkspace(state, role, now)
  const heroSession = workspace.current || workspace.next

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const clientOf = (id) => state.clients.find((c) => c.id === id)

  const todays = workspace.schedule
    .map((s) => ({ ...s, psych: psychOf(s.psychId), client: clientOf(s.clientId) }))
  const daySummary = workspace.daySummary
  const shortcuts = TODAY_SHORTCUTS.filter((shortcut) => !shortcut.roles || shortcut.roles.includes(role.id))
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

  // the eyebrow is the whole page header: role, date, day progress
  const eyebrow = [
    role.id === 'therapist' && 'Mój dzień',
    `${cap(fmtWeekday(today))}, ${fmtDayMonth(today)}`,
    heroSession && `${daySummary.completed} z ${daySummary.total} sesji za Tobą`,
  ].filter(Boolean).join(' · ')

  return (
    <section className="today-page" role="region" aria-label="Pulpit dnia" ref={ref}>
      <header className="today-hero" data-reveal>
        <p className="eyebrow">{eyebrow}</p>
        {heroSession ? (
          <>
            <p className="today-hero__state">{heroState}</p>
            <h1 className="display today-hero__time">{heroSession.time}</h1>
            <p className="display today-hero__name">{heroClient?.name}</p>
            <p className="today-hero__meta">
              {heroPsych?.room || 'Gabinet do potwierdzenia'} · {heroPsych?.name}
            </p>
          </>
        ) : (
          <>
            <h1 className="display today-hero__title">{terminalHeading}</h1>
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

      <section className="today-summary" aria-label="Podsumowanie dnia">
        <h2 className="sr-only">Podsumowanie dnia</h2>
        <span>Odbyte <b>{daySummary.completed}</b></span>
        <span>Nieobecności <b>{daySummary.noshow}</b></span>
        <span>Pozostałe <b>{daySummary.scheduled}</b></span>
      </section>

      {daySummary.total > 0 && (
        <>
          <hr className="today-rule" aria-hidden="true" />
          <section className="today-plan" aria-label="Plan dnia">
            <TodayThread
              sessions={todays}
              nowMin={nowMin}
              currentId={workspace.current?.id}
              nextId={workspace.next?.id}
              onOpen={(s) => openSessionForm({ session: state.sessions.find((x) => x.id === s.id) })}
            />
          </section>
        </>
      )}

      {workspace.attention.length > 0 && (
        <section className="today-attn" aria-label="Wymaga uwagi" data-reveal>
          {workspace.attention.slice(0, 2).map((item) => {
            const session = state.sessions.find((entry) => entry.id === item.sessionId)
            const client = session && clientOf(session.clientId)
            const canOpenPayments = role.id !== 'therapist'
            return (
              <button
                key={item.sessionId}
                className="today-attn__row"
                onClick={() => canOpenPayments
                  ? navigate('payments', { allPeriods: true, unpaidOnly: true })
                  : openSessionForm({ session })}
              >
                <Icon name="payments" size={15} />
                <span><b>{client?.name || 'Klient'}</b> · zaległa płatność {fmtMoney(item.amount)}</span>
                <Icon name="chevR" size={14} className="faint" />
              </button>
            )
          })}
        </section>
      )}

      <hr className="today-rule" aria-hidden="true" />
      <section className="today-links" aria-label="Skróty" data-reveal>
        {shortcuts.map((shortcut) => (
          <button
            key={shortcut.id}
            className="today-links__item"
            onClick={() => shortcut.id === 'board' ? openTeamBoard() : navigate(shortcut.id)}
          >
            {shortcut.label}
          </button>
        ))}
      </section>
    </section>
  )
}
