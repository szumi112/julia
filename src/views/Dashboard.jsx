import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp, monthStats, upcomingSessions, totalOutstanding, revenueSeries } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useCountUp, useDrawerFX, motionOK } from '../anim.js'
import { Ambient } from '../three-scene.jsx'
import { AreaChart, Sparkline, BarFill } from '../charts.jsx'
import { Button, Avatar, Pill, IconBtn, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import {
  fmtMoney, fmtNumber, monthKey, addMonths, fmtWeekday, fmtDayMonth, fmtShortDate, toISODate, pad2,
  sessionsWord, outstandingOf, isBillable, cap, greeting, fmtMonthName, plural,
} from '../format.js'

const vocative = (name) => {
  const first = name.split(' ')[0]
  return first.endsWith('a') ? first.slice(0, -1) + 'o' : first
}

function StatCard({ label, value, fmt, suffix, delta, spark, sparkColor = '#a4596b', gold, onClick }) {
  const ref = useCountUp(value, fmt)
  return (
    <div className={`card stat card--lift ${gold ? 'stat--gold' : ''}`} data-reveal onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">
        <span ref={ref}>0</span>
        {suffix && <small>{suffix}</small>}
      </div>
      {delta && <div className="stat__delta">{delta}</div>}
      {spark && <Sparkline values={spark} color={sparkColor} />}
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
        { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power3.out', clearProps: 'all' }
      )
    }
    prevCount.current = state.posts.length
  }, [state.posts.length])

  const visible = state.posts.slice(0, BOARD_PREVIEW)
  const hidden = state.posts.length - visible.length

  return (
    <>
      <div className="card card--pad" data-reveal-scroll style={{ alignSelf: 'start' }}>
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

// The current month is in progress, so percent deltas would mislead —
// show last month's value as context instead.
const prevContext = (prevYm, formatted) => (
  <span>
    {fmtMonthName(prevYm).slice(0, 3)}: <b>{formatted}</b>
  </span>
)

export function Dashboard() {
  const { state } = useApp()
  const { navigate, openSessionForm, openClientForm } = useShell()
  const ref = useReveal()

  const ym = monthKey(new Date())
  const months = useMemo(() => Array.from({ length: 6 }, (_, i) => addMonths(ym, i - 5)), [ym])
  const series = useMemo(() => revenueSeries(state.sessions, months), [state.sessions, months])
  const cur = series[series.length - 1]
  const prev = series[series.length - 2]

  const activeClients = state.clients.filter((c) => c.status === 'active').length
  const outstanding = totalOutstanding(state.sessions)
  const unpaidCount = state.sessions.filter((s) => isBillable(s) && outstandingOf(s) > 0).length
  const upcoming = upcomingSessions(state.sessions, 6)
  const today = toISODate(new Date())
  const todayCount = state.sessions.filter((s) => s.date === today && s.status !== 'cancelled').length

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const clientOf = (id) => state.clients.find((c) => c.id === id)

  const psychMonth = state.psychologists.map((p) => {
    const sess = state.sessions.filter((s) => s.psychId === p.id)
    return { p, ...monthStats(sess, ym) }
  })
  const maxRev = Math.max(...psychMonth.map((x) => x.revenue), 1)

  return (
    <div ref={ref}>
      <section className="dash-hero" data-reveal>
        <Ambient className="dash-hero__scene" amp={0.34} speed={0.5} scale={3.4} />
        <div className="dash-hero__inner">
          <div>
            <div className="eyebrow">{cap(fmtWeekday(today))}, {fmtDayMonth(today)}</div>
            <h1 className="display dash-hero__title">
              {greeting()}, <em>{vocative(state.user.name)}</em>
            </h1>
            <p className="dash-hero__sub">
              {todayCount > 0
                ? <>Dziś w grafiku {plural(todayCount, 'jest', 'są', 'jest')} <b>{todayCount} {sessionsWord(todayCount)}</b>. Powodzenia!</>
                : 'Dziś kalendarz jest wolny — czas na oddech.'}
            </p>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Button icon="plus" magnetic onClick={() => openSessionForm()}>
              Nowa sesja
            </Button>
            <Button variant="ghost" icon="user" onClick={() => openClientForm()}>
              Nowy klient
            </Button>
          </div>
        </div>
      </section>

      <div className="stats-row">
        <StatCard
          label="Aktywni klienci"
          value={activeClients}
          fmt={fmtNumber}
          delta={<span>spośród {state.clients.length} w kartotece</span>}
          spark={series.map((s) => s.count)}
          sparkColor="#9d8190"
        />
        <StatCard
          label="Sesje w tym mies."
          value={cur.count}
          fmt={fmtNumber}
          delta={prevContext(prev.ym, fmtNumber(prev.count))}
          spark={series.map((s) => s.count)}
        />
        <StatCard
          label="Godziny pracy"
          value={cur.hours}
          fmt={(v) => fmtNumber(Math.round(v))}
          suffix=" h"
          delta={prevContext(prev.ym, `${Math.round(prev.hours)} h`)}
          spark={series.map((s) => s.hours)}
          sparkColor="#c26b4b"
        />
        <StatCard
          label="Przychód (mies.)"
          value={cur.revenue}
          fmt={fmtMoney}
          delta={prevContext(prev.ym, fmtMoney(prev.revenue))}
          spark={series.map((s) => s.revenue)}
        />
        <StatCard
          label="Zaległe płatności"
          value={outstanding}
          fmt={fmtMoney}
          gold
          delta={<span>{unpaidCount} {sessionsWord(unpaidCount)} · <span className="link">zobacz</span></span>}
          onClick={() => navigate('payments')}
        />
      </div>

      <div className="grid-31">
        <div className="card card--pad" data-reveal>
          <h2 className="card-title">
            Przychód miesięczny
            <button className="link" onClick={() => navigate('reports')}>Pełny raport →</button>
          </h2>
          <div style={{ marginTop: 14 }}>
            <AreaChart data={series} />
          </div>
        </div>

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
      </div>

      <div className="grid-31" style={{ marginTop: 20 }}>
        <div className="card card--pad" data-reveal-scroll style={{ alignSelf: 'start' }}>
          <h2 className="card-title">
            Zespół w tym miesiącu
            <button className="link" onClick={() => navigate('team')}>Zespół →</button>
          </h2>
          <div className="hbar" style={{ marginTop: 20 }}>
            {psychMonth.map(({ p, count, hours, revenue }) => (
              <div className="hbar__row" key={p.id}>
                <button className="hbar__name link" style={{ color: 'var(--ink)', display: 'flex' }} onClick={() => navigate('psych', { id: p.id })}>
                  <Avatar name={p.name} color={p.color} size={30} />
                  <span>{p.name}</span>
                </button>
                <div className="hbar__track">
                  <BarFill segments={[{ value: revenue, color: p.color, label: p.name }]} totalMax={maxRev} />
                </div>
                <div className="hbar__val">
                  {fmtMoney(revenue)} <span className="faint" style={{ fontWeight: 500 }}>· {count} {sessionsWord(count)} · {Math.round(hours)} h</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <TeamBoard />
      </div>
    </div>
  )
}
