import { Fragment, useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useDrawerFX } from '../anim.js'
import { Button, Avatar, IconBtn, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { todayWorkspace } from '../workspace.js'
import {
  fmtMoney, fmtWeekday, fmtDayMonth, fmtShortDate, toISODate, pad2,
  sessionsWord, cap, plural, timeToMin,
} from '../format.js'

// today's sessions on the day thread — the hero's working half
function TodayThread({ sessions, nowMin, onOpen, onCalendar }) {
  const MAX = 4
  const shown = sessions.slice(0, MAX)
  const hidden = sessions.length - shown.length
  const running = sessions.find(
    (s) => s.status === 'scheduled' && timeToMin(s.time) <= nowMin && nowMin < timeToMin(s.time) + s.duration
  )
  const nextId = sessions.find((s) => s.status === 'scheduled' && timeToMin(s.time) > nowMin)?.id

  return (
    <div className="dash-hero__day" data-reveal>
      <div className="spine">
        <span className="spine__rule" data-spine aria-hidden="true" />
        {shown.map((s, i) => {
          const nowHere = !running &&
            timeToMin(s.time) > nowMin &&
            (i === 0 || timeToMin(shown[i - 1].time) <= nowMin)
          return (
            <Fragment key={s.id}>
              {nowHere && <div className="spine__now" aria-hidden="true">teraz</div>}
              <button
                className={`spine__row ${s.status === 'completed' ? 'is-done' : ''} ${s.id === nextId ? 'is-next' : ''}`}
                style={{ '--node-color': s.psych?.color }}
                onClick={() => onOpen(s)}
              >
                <span className="spine__time">{s.time}</span>
                <span className="spine__name">{s.client?.name}</span>
                <span className="spine__meta">{s.psych?.name.split(' ')[0]}</span>
                <Icon
                  name={s.status === 'completed' ? 'check' : running?.id === s.id ? 'wave' : 'clock'}
                  size={14}
                  className="faint"
                />
              </button>
            </Fragment>
          )
        })}
        {hidden > 0 && (
          <button className="bpost-more" onClick={onCalendar}>
            Jeszcze {hidden} {sessionsWord(hidden)} — otwórz kalendarz →
          </button>
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
  const doneCount = todays.filter((session) => session.status === 'completed').length
  const shortcuts = TODAY_SHORTCUTS.filter((shortcut) => !shortcut.roles || shortcut.roles.includes(role.id))
  const heroPsych = heroSession ? psychOf(heroSession.psychId) : null
  const heroClient = heroSession ? clientOf(heroSession.clientId) : null

  // the eyebrow is the whole page header: role, date, day progress
  const eyebrow = [
    role.id === 'therapist' && 'Mój dzień',
    `${cap(fmtWeekday(today))}, ${fmtDayMonth(today)}`,
    heroSession && `${doneCount} z ${todays.length} sesji za Tobą`,
    workspace.current && 'trwa teraz',
  ].filter(Boolean).join(' · ')

  return (
    <section className="today-page" role="region" aria-label="Pulpit dnia" ref={ref}>
      <header className="today-hero" data-reveal>
        <p className="eyebrow">{eyebrow}</p>
        {heroSession ? (
          <>
            <h1 className="display today-hero__time">{heroSession.time}</h1>
            <p className="display today-hero__name">{heroClient?.name}</p>
            <p className="today-hero__meta">
              {heroPsych?.room || 'Gabinet do potwierdzenia'} · {heroPsych?.name}
            </p>
          </>
        ) : (
          <>
            <h1 className="display today-hero__title">
              {todays.length > 0 ? 'Wszystko za Tobą' : 'Wolny dzień'}
            </h1>
            <p className="today-hero__meta">
              {todays.length > 0
                ? `${doneCount} z ${todays.length} sesji zakończonych`
                : 'Kalendarz jest dziś pusty — czas na oddech.'}
            </p>
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

      {todays.length > 0 && (
        <>
          <hr className="today-rule" aria-hidden="true" />
          <section className="today-plan" aria-label="Plan dnia">
            <TodayThread
              sessions={todays}
              nowMin={nowMin}
              onOpen={(s) => openSessionForm({ session: state.sessions.find((x) => x.id === s.id) })}
              onCalendar={() => navigate('calendar')}
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
