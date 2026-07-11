import { Fragment, useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useDrawerFX } from '../anim.js'
import { Button, Avatar, Pill, IconBtn, EmptyState } from '../ui.jsx'
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
  const done = sessions.filter((s) => s.status === 'completed').length
  const running = sessions.find(
    (s) => s.status === 'scheduled' && timeToMin(s.time) <= nowMin && nowMin < timeToMin(s.time) + s.duration
  )
  const nextId = sessions.find((s) => s.status === 'scheduled' && timeToMin(s.time) > nowMin)?.id

  return (
    <div className="dash-hero__day" data-reveal>
      <div className="dash-hero__day-head">
        <span className="eyebrow">Plan dnia</span>
        {sessions.length > 0 && (
          <span className="figures__sub">{done} z {sessions.length} za Tobą</span>
        )}
      </div>
      {sessions.length === 0 ? (
        <EmptyState compact icon="sparkle" title="Wolny dzień" hint="Kalendarz jest dziś wolny — czas na oddech." />
      ) : (
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
      )}
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
  const selectedSession = workspace.current || workspace.next

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const clientOf = (id) => state.clients.find((c) => c.id === id)

  const todays = workspace.schedule
    .map((s) => ({ ...s, psych: psychOf(s.psychId), client: clientOf(s.clientId) }))
  const completedCount = todays.filter((session) => session.status === 'completed').length
  const scheduledCount = todays.filter((session) => session.status === 'scheduled').length
  const shortcuts = TODAY_SHORTCUTS.filter((shortcut) => !shortcut.roles || shortcut.roles.includes(role.id))
  const focusPsych = selectedSession ? psychOf(selectedSession.psychId) : null
  const focusClient = selectedSession ? clientOf(selectedSession.clientId) : null

  return (
    <section className="today-page" role="region" aria-label="Pulpit dnia" ref={ref}>
      <header className="today-head" data-reveal>
        <div>
          <div className="eyebrow">{cap(fmtWeekday(today))}, {fmtDayMonth(today)}</div>
          <h1 className="display today-head__title">
            {role.id === 'therapist' ? 'Mój dzień' : 'Dziś'}
          </h1>
        </div>
        <div className="today-head__actions">
          <Button icon="plus" magnetic onClick={() => openSessionForm()}>Nowa sesja</Button>
          <Button variant="ghost" icon="user" onClick={() => openClientForm()}>Nowy klient</Button>
        </div>
      </header>

      <div className="today-command">
        <div className="today-primary">
          <section className="today-region today-region--focus card card--pad" aria-labelledby="today-focus-title" data-reveal>
            <div className="today-region__head">
              <div>
                <span className="eyebrow">Najbliższe działanie</span>
                <h2 id="today-focus-title" className="card-title">Teraz lub następna sesja</h2>
              </div>
              {workspace.current && <Pill tone="rose" dot>Trwa teraz</Pill>}
            </div>
            {selectedSession ? (
              <div className="today-focus">
                <div className="today-focus__time">{selectedSession.time}</div>
                <div className="today-focus__main">
                  <b>{focusClient?.name}</b>
                  <span>{focusPsych?.room || 'Gabinet do potwierdzenia'} · {focusPsych?.name}</span>
                </div>
                <Button onClick={() => openSessionForm({ session: selectedSession })}>Otwórz sesję</Button>
              </div>
            ) : (
              <EmptyState compact icon="calendar" title="Brak kolejnej sesji" hint="Zaplanuj spotkanie, gdy pojawi się nowa potrzeba." />
            )}
          </section>

          <section className="today-region today-region--plan" aria-label="Plan dnia">
            <TodayThread
              sessions={todays}
              nowMin={nowMin}
              onOpen={(s) => openSessionForm({ session: state.sessions.find((x) => x.id === s.id) })}
              onCalendar={() => navigate('calendar')}
            />
          </section>
        </div>

        <aside className="today-side card card--pad" data-reveal>
          <section className="today-side__section" aria-label="Dzień w skrócie">
            <div className="today-region__head">
              <div>
                <span className="eyebrow">Na szybko</span>
                <h2 className="card-title">Dzień w skrócie</h2>
              </div>
            </div>
            <div className="today-stats">
              <div className="today-stat">
                <strong>{todays.length}</strong>
                <span>sesji dzisiaj</span>
              </div>
              <div className="today-stat">
                <strong>{scheduledCount}</strong>
                <span>zaplanowane</span>
              </div>
              <div className="today-stat">
                <strong>{completedCount}</strong>
                <span>zakończone</span>
              </div>
            </div>
          </section>

          <section className="today-side__section today-side__section--attention" aria-labelledby="today-attention-title">
            <div className="today-region__head">
              <div>
                <span className="eyebrow">Do działania</span>
                <h2 id="today-attention-title" className="card-title">Wymaga uwagi</h2>
              </div>
              {workspace.attention.length > 0 && (
                <Pill tone="gold">{workspace.attention.length === 3 ? '3+' : workspace.attention.length}</Pill>
              )}
            </div>
            {workspace.attention.length === 0 ? (
              <div className="today-calm">
                <span className="today-calm__icon"><Icon name="check" size={16} /></span>
                <span>
                  <b>Wszystko pod kontrolą</b>
                  <small>Brak pilnych spraw na dziś.</small>
                </span>
              </div>
            ) : (
              <div className="today-attention">
                {workspace.attention.slice(0, 2).map((item) => {
                  const session = state.sessions.find((entry) => entry.id === item.sessionId)
                  const client = session && clientOf(session.clientId)
                  const canOpenPayments = role.id !== 'therapist'
                  return (
                    <button
                      key={item.sessionId}
                      className="today-attention__row"
                      onClick={() => canOpenPayments
                        ? navigate('payments', { allPeriods: true, unpaidOnly: true })
                        : openSessionForm({ session })}
                    >
                      <Icon name="payments" size={16} />
                      <span>
                        <b>{client?.name || 'Klient'}</b>
                        <small>Zaległa płatność · {fmtMoney(item.amount)}</small>
                      </span>
                      <Icon name="chevR" size={15} className="faint" />
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          <section className="today-side__section today-shortcuts" aria-label="Skróty">
            <div className="today-region__head">
              <div>
                <span className="eyebrow">Przejdź do</span>
                <h2 className="card-title">Skróty</h2>
              </div>
            </div>
            <div className="today-shortcuts__grid">
              {shortcuts.map((shortcut) => (
                <button
                  key={shortcut.id}
                  className="today-shortcut"
                  onClick={() => shortcut.id === 'board' ? openTeamBoard() : navigate(shortcut.id)}
                >
                  <Icon name={shortcut.icon} size={16} />
                  <span>{shortcut.label}</span>
                  <Icon name="chevR" size={13} className="today-shortcut__chev" />
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  )
}
