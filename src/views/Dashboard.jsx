import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, monthStats, upcomingSessions, totalOutstanding, clientOutstanding, revenueSeries } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useDrawerFX, motionOK } from '../anim.js'
import { AreaChart, BarFill } from '../charts.jsx'
import { Button, Avatar, Pill, IconBtn, EmptyState, Figure } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { sessionsForRole, todayWorkspace } from '../workspace.js'
import {
  fmtMoney, monthKey, addMonths, fmtWeekday, fmtDayMonth, fmtShortDate, toISODate, pad2,
  sessionsWord, outstandingOf, isBillable, cap, fmtMonthName, plural, timeToMin,
} from '../format.js'

// today's sessions on the day thread — the hero's working half
function TodayThread({ sessions, nowMin, onOpen, onCalendar }) {
  const MAX = 6
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

// --- Tablica zespołu — lightweight in-memory announcements board. The
// dashboard card shows only the newest posts; the full board lives in a
// slide-over drawer.

const BOARD_PREVIEW = 3

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
function BoardDrawer({ onClose }) {
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

function TeamBoard() {
  const { state } = useApp()
  const [boardOpen, setBoardOpen] = useState(false)
  const listRef = useRef(null)
  const prevCount = useRef(state.posts.length)

  // gently slide a freshly published post in
  useEffect(() => {
    if (state.posts.length > prevCount.current && motionOK() && listRef.current?.firstElementChild) {
      window.gsap.fromTo(
        listRef.current.firstElementChild,
        { autoAlpha: 0, y: -10 },
        { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power3.out', clearProps: 'transform,opacity,visibility' }
      )
    }
    prevCount.current = state.posts.length
  }, [state.posts.length])

  const visible = state.posts.slice(0, BOARD_PREVIEW)
  const hidden = state.posts.length - visible.length

  return (
    <>
      <div className="card card--pad" data-reveal style={{ alignSelf: 'start' }}>
        <h2 className="card-title">
          <span className="row" style={{ gap: 8 }}>
            <Icon name="pin" size={17} style={{ color: 'var(--gold-deep)' }} />
            Tablica zespołu
          </span>
          {state.posts.length > BOARD_PREVIEW && (
            <button className="link" onClick={() => setBoardOpen(true)}>
              Cała tablica ({state.posts.length}) →
            </button>
          )}
        </h2>
        <div style={{ marginTop: 14 }}>
          <BoardComposer />
        </div>
        <div style={{ marginTop: 8 }} ref={listRef}>
          {state.posts.length === 0 && (
            <EmptyState compact icon="pin" title="Tablica jest pusta" hint="Zostaw zespołowi pierwszą wiadomość." />
          )}
          {visible.map((p) => (
            <BoardPost key={p.id} post={p} />
          ))}
        </div>
        {hidden > 0 && (
          <button className="bpost-more" onClick={() => setBoardOpen(true)}>
            Pokaż {hidden} {plural(hidden, 'starszy wpis', 'starsze wpisy', 'starszych wpisów')} →
          </button>
        )}
      </div>
      {boardOpen && <BoardDrawer onClose={() => setBoardOpen(false)} />}
    </>
  )
}

export function Dashboard() {
  const { state } = useApp()
  const { navigate, openSessionForm, openClientForm, role } = useShell()
  const ref = useReveal()

  const now = new Date()
  const today = toISODate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const workspace = todayWorkspace(state, role, now)
  const roleSessions = sessionsForRole(state, role)
  const selectedSession = workspace.current || workspace.next
  const ym = monthKey(now)
  const months = useMemo(() => Array.from({ length: 6 }, (_, i) => addMonths(ym, i - 5)), [ym])
  const series = useMemo(() => revenueSeries(roleSessions, months), [roleSessions, months])
  const monthName = fmtMonthName(ym)

  const outstanding = totalOutstanding(roleSessions)
  const unpaidCount = roleSessions.filter((s) => isBillable(s) && outstandingOf(s) > 0).length
  const upcoming = upcomingSessions(roleSessions, 5)

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const clientOf = (id) => state.clients.find((c) => c.id === id)

  const todays = workspace.schedule
    .map((s) => ({ ...s, psych: psychOf(s.psychId), client: clientOf(s.clientId) }))

  // The secondary billing card stays useful in each role, without exposing
  // another specialist's client balance in therapist mode.
  const debtors = state.clients
    .map((c) => ({ c, due: clientOutstanding(roleSessions, c.id) }))
    .filter((d) => d.due > 0)
    .sort((a, b) => b.due - a.due)
    .slice(0, 3)

  const psychMonth = state.psychologists.map((p) => {
    const sess = roleSessions.filter((s) => s.psychId === p.id)
    const todayCount = todays.filter((s) => s.psychId === p.id).length
    return { p, todayCount, ...monthStats(sess, ym) }
  })
  const visiblePsychMonth = role.scope === 'own'
    ? psychMonth.filter(({ p }) => p.id === role.psychId)
    : psychMonth
  const maxRev = Math.max(...visiblePsychMonth.map((x) => x.revenue), 1)
  const focusPsych = selectedSession ? psychOf(selectedSession.psychId) : null
  const focusClient = selectedSession ? clientOf(selectedSession.clientId) : null

  return (
    <div ref={ref}>
      <header className="today-head" data-reveal>
        <div>
          <div className="eyebrow">{cap(fmtWeekday(today))}, {fmtDayMonth(today)}</div>
          <h1 className="display today-head__title">
            {role.id === 'therapist' ? 'Mój dzień' : 'Dziś'}
          </h1>
          <p className="today-head__sub">
            {todays.length > 0
              ? <>W planie {todays.length} {sessionsWord(todays.length)}. Zacznij od tego, co najbliżej.</>
              : 'Dziś kalendarz jest wolny — czas na oddech.'}
          </p>
        </div>
        <div className="today-head__actions">
          <Button icon="plus" magnetic onClick={() => openSessionForm()}>Nowa sesja</Button>
          <Button variant="ghost" icon="user" onClick={() => openClientForm()}>Nowy klient</Button>
        </div>
      </header>

      <div className="today-workspace">
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

        <section className="today-region today-region--attention card card--pad" aria-labelledby="today-attention-title" data-reveal>
          <div className="today-region__head">
            <div>
              <span className="eyebrow">Do działania</span>
              <h2 id="today-attention-title" className="card-title">Wymaga uwagi</h2>
            </div>
            {workspace.attention.length > 0 && <Pill tone="gold">{workspace.attention.length}</Pill>}
          </div>
          {workspace.attention.length === 0 ? (
            <EmptyState compact icon="check" title="Wszystko pod kontrolą" hint="Nie ma dziś spraw wymagających działania." />
          ) : (
            <div className="today-attention">
              {workspace.attention.map((item) => {
                const session = state.sessions.find((entry) => entry.id === item.sessionId)
                const client = session && clientOf(session.clientId)
                const canOpenPayments = role.id !== 'therapist'
                return (
                  <button
                    key={item.sessionId}
                    className="today-attention__row"
                    onClick={() => canOpenPayments ? navigate('payments') : openSessionForm({ session })}
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

        <section className="today-region today-region--plan" aria-label="Plan dnia">
          <TodayThread
            sessions={todays}
            nowMin={nowMin}
            onOpen={(s) => openSessionForm({ session: state.sessions.find((x) => x.id === s.id) })}
            onCalendar={() => navigate('calendar')}
          />
        </section>

        {workspace.summary && (
          <section className="today-region today-region--summary" aria-label="Stan praktyki" data-reveal>
            <div className="today-region__head">
              <div>
                <span className="eyebrow">Właścicielka</span>
                <h2 className="card-title">Stan praktyki</h2>
              </div>
            </div>
            <div className="figures" role="group" aria-label="Stan praktyki">
              <Figure
                label="Sesje zakończone"
                value={workspace.summary.completedToday.value}
                sub="dzisiaj"
                onClick={() => navigate('calendar')}
              />
              <Figure
                label={`Przychód · ${monthName}`}
                value={workspace.summary.revenueMonth.value}
                fmt={fmtMoney}
                sub="bieżący miesiąc"
                onClick={() => navigate('reports')}
              />
              <Figure
                label="Zaległe · łącznie"
                value={workspace.summary.outstandingAllTime.value}
                fmt={fmtMoney}
                gold
                sub="wszystkie okresy"
                onClick={() => navigate('payments', { allPeriods: true, unpaidOnly: true })}
              />
            </div>
          </section>
        )}
      </div>

      <div className="grid-31 today-secondary">
        <div className="card card--pad" data-reveal style={{ alignSelf: 'start' }}>
          <h2 className="card-title">
            Przychód miesięczny
            <button className="link" onClick={() => navigate('reports')}>Pełny raport →</button>
          </h2>
          <div style={{ marginTop: 14 }}>
            <AreaChart data={series} />
          </div>
        </div>

        <div className="stack">
          <div className="card card--pad" data-reveal>
            <h2 className="card-title">
              Najbliższe sesje
              <button className="link" onClick={() => navigate('calendar')}>Kalendarz →</button>
            </h2>
            <div className="agenda" style={{ marginTop: 8 }}>
              {upcoming.length === 0 && (
                <EmptyState
                  compact
                  icon="calendar"
                  title="Brak zaplanowanych sesji"
                  hint="Zaplanuj spotkanie, a pojawi się tutaj."
                  action={<Button size="sm" variant="soft" icon="plus" onClick={() => openSessionForm()}>Nowa sesja</Button>}
                />
              )}
              {upcoming.map((s) => {
                const p = psychOf(s.psychId)
                const c = clientOf(s.clientId)
                return (
                  <button
                    key={s.id}
                    className="agenda__row hover-row"
                    style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => openSessionForm({ session: s })}
                  >
                    <span className="agenda__time">{s.time}</span>
                    <span className="agenda__main">
                      <span className="agenda__client">{c?.name}</span>
                      <span className="agenda__meta">
                        <span className="dot" style={{ width: 7, height: 7, borderRadius: 99, background: p?.color, display: 'inline-block' }} />
                        {p?.name} · {s.date === today ? 'dziś' : fmtDayMonth(s.date)}
                      </span>
                    </span>
                    <Icon name="chevR" size={15} className="faint" />
                  </button>
                )
              })}
            </div>
          </div>

          <div className="card card--pad" data-reveal>
            <h2 className="card-title">
              Do rozliczenia
              <button className="link" onClick={() => navigate('payments')}>Finanse →</button>
            </h2>
            {debtors.length === 0 ? (
              <EmptyState compact icon="check" title="Wszystko rozliczone" hint="Żaden klient nie ma zaległości." />
            ) : (
              <div style={{ marginTop: 8 }}>
                {debtors.map(({ c, due }) => (
                  <button
                    key={c.id}
                    className="hover-row row row--between"
                    style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => navigate('client', { id: c.id })}
                  >
                    <span className="row" style={{ gap: 10, minWidth: 0 }}>
                      <Avatar name={c.name} size={28} />
                      <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    </span>
                    <Pill tone="gold">{fmtMoney(due)}</Pill>
                  </button>
                ))}
                <div className="figures__sub" style={{ marginTop: 10 }}>
                  Łącznie {fmtMoney(outstanding)} · {unpaidCount} {sessionsWord(unpaidCount)}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`grid-31 today-secondary ${role.scope === 'own' ? 'grid-31--single' : ''}`} style={{ marginTop: 20 }}>
        <div className="card card--pad" data-reveal style={{ alignSelf: 'start' }}>
          <h2 className="card-title">
            Zespół dziś
            <button className="link" onClick={() => navigate('team')}>Zespół →</button>
          </h2>
          <div className="hbar" style={{ marginTop: 20 }}>
            {visiblePsychMonth.map(({ p, todayCount, count, revenue }) => (
              <div className="hbar__row" key={p.id}>
                <button className="hbar__name link" style={{ color: 'var(--ink)', display: 'flex' }} aria-label={`Otwórz profil specjalistki: ${p.name}`} onClick={() => navigate('psych', { id: p.id })}>
                  <Avatar name={p.name} color={p.color} size={30} />
                  <span>{p.name}</span>
                </button>
                <div className="hbar__track">
                  <BarFill segments={[{ value: revenue, color: p.color, label: p.name }]} totalMax={maxRev} />
                </div>
                <div className="hbar__val">
                  {todayCount > 0 ? `dziś ${todayCount} ${sessionsWord(todayCount)}` : 'dziś wolne'}
                  <span className="faint" style={{ fontWeight: 500 }}> · {fmtMoney(revenue)} / {monthName.slice(0, 3)} · {count} {sessionsWord(count)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {role.scope !== 'own' && <TeamBoard />}
      </div>
    </div>
  )
}
