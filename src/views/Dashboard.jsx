import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { apiClient } from '../api.js'
import { useApp, useWorkspaceRetry, useWorkspaceWindow } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { canPerformAction } from '../capability-access.js'
import { useReveal, useDrawerFX } from '../anim.js'
import { useMinuteNow } from '../clock.js'
import { Button, Avatar, IconBtn, EmptyState, Figure } from '../ui.jsx'
import { EntityLink, ViewState } from '../ux-patterns.jsx'
import { todayWorkspace } from '../workspace.js'
import { isWorkspaceRangeCovered, rollingWorkspaceRange, weekWorkspaceRange } from '../workspace-view.js'
import { isWorkspaceRangePending } from '../workspace-load-request.js'
import { dashboardBackupAlert } from '../operations-view.js'
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
          const Row = onOpen ? 'button' : 'div'
          return (
            <Fragment key={session.id}>
              {markerHere && <div className="spine__now" aria-hidden="true">teraz</div>}
              <Row
                className={`spine__row today-session ${live ? 'is-live' : ''} ${session.status === 'completed' ? 'is-done' : ''}`}
                data-status={session.status}
                style={{ '--node-color': session.psych?.color }}
                onClick={onOpen ? () => onOpen(session) : undefined}
              >
                <span className="spine__time">{session.time}</span>
                <span className="spine__name">{session.client?.name}</span>
                <span className="today-session__status">{status}</span>
              </Row>
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
  const { appMode } = useShell()
  if (appMode === 'app') return null
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

export function Dashboard({ todayWorkspaceRange, todayWorkspaceState = 'ready' }) {
  const { state, workspace, workspaceFailures, workspacePendingRanges } = useApp()
  const {
    appMode, canAccess, capabilities, openSessionForm, openClientForm, navigate, role,
  } = useShell()
  const isApp = appMode === 'app'
  const ref = useReveal()
  const canReadBackupHealth = isApp && role.id === 'owner'
    && canPerformAction(capabilities, 'operations.health.read')
  const [backupHealth, setBackupHealth] = useState(null)

  useEffect(() => {
    if (!canReadBackupHealth) return undefined
    let active = true
    const timer = window.setTimeout(() => {
      void apiClient.getOperationsHealth()
        .then((health) => {
          if (active) setBackupHealth(health)
        })
        .catch(() => {
          if (active) setBackupHealth(null)
        })
    }, 0)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [canReadBackupHealth])

  // minute-aligned shared clock — "Trwa teraz" / "Następna sesja" never go stale
  const now = useMinuteNow()
  const today = toISODate(now)
  const defaultWorkspaceRange = useMemo(() => weekWorkspaceRange(today), [today])
  const workspaceRange = todayWorkspaceRange || defaultWorkspaceRange
  const balanceRange = useMemo(() => rollingWorkspaceRange(today), [today])
  const balanceWorkspaceState = useWorkspaceWindow(
    balanceRange,
    isApp && role.scope !== 'own',
  )
  const retryWorkspace = useWorkspaceRetry()
  const workspaceUnavailable = isApp && (
    todayWorkspaceState === 'unavailable' || balanceWorkspaceState === 'unavailable'
  )
  const todayWorkspaceCovered = !isApp || isWorkspaceRangeCovered(workspace.loadedRanges, workspaceRange)
  const balanceWorkspaceCovered = !isApp || role.scope === 'own'
    || isWorkspaceRangeCovered(workspace.loadedRanges, balanceRange)
  const workspaceCovered = todayWorkspaceCovered && balanceWorkspaceCovered
  const todayWorkspaceFailed = isApp && workspaceFailures.has(`${workspaceRange.from}|${workspaceRange.to}`)
  const balanceWorkspaceFailed = isApp && role.scope !== 'own'
    && workspaceFailures.has(`${balanceRange.from}|${balanceRange.to}`)
  const workspaceFailed = todayWorkspaceFailed || balanceWorkspaceFailed
  const workspaceReadOnlyError = isApp && workspace.status === 'read-only-error'
  const workspaceRefreshing = isApp && workspaceCovered && (
    isWorkspaceRangePending(workspacePendingRanges, workspaceRange)
    || (role.scope !== 'own' && isWorkspaceRangePending(workspacePendingRanges, balanceRange))
  )
  const workspaceRefreshFailed = isApp && workspaceCovered && (workspaceFailed || workspaceReadOnlyError)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const outstandingRange = isApp
    ? (role.scope === 'own' ? { from: today, to: today } : balanceRange)
    : null
  const workspaceModel = todayWorkspace(state, role, now, outstandingRange)
  const heroSession = workspaceModel.current || workspaceModel.next

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const clientOf = (id) => state.clients.find((c) => c.id === id)

  const todays = workspaceModel.schedule
    .map((s) => ({ ...s, psych: psychOf(s.psychId), client: clientOf(s.clientId) }))
  const daySummary = workspaceModel.daySummary
  const heroPsych = heroSession ? psychOf(heroSession.psychId) : null
  const heroClient = heroSession ? clientOf(heroSession.clientId) : null
  const heroState = workspaceModel.current ? 'Trwa teraz' : workspaceModel.next ? 'Następna sesja' : null
  const terminalHeading = !workspaceCovered
    ? (workspaceUnavailable ? 'Nie udało się wczytać całego podsumowania dnia' : 'Wczytuję grafik dnia…')
    : daySummary.unresolvedPast > 0
      ? `${daySummary.unresolvedPast} sesji wymaga statusu`
      : daySummary.total > 0 ? 'Dzień zakończony' : 'Wolny dzień'
  const terminalSupport = !workspaceCovered
    ? (workspaceUnavailable
      ? 'Nie pokazujemy częściowych danych. Spróbuj ponownie.'
      : 'Pobieramy dzisiejszy grafik.')
    : daySummary.unresolvedPast > 0
      ? 'Zaktualizuj status zakończonych sesji, aby domknąć plan dnia.'
      : daySummary.total > 0
        ? 'Wszystkie dzisiejsze sesje mają uzupełniony status.'
        : 'Grafik jest dziś pusty — czas na oddech.'

  const outstandingLabel = isApp
    ? (role.scope === 'own' ? 'Do zapłaty za dzisiejsze sesje' : 'Do zapłaty (ostatnie 3 miesiące)')
    : 'Zaległe'
  const canOpenPayments = isApp ? canAccess('payments') : role.scope !== 'own'
  const canCreateSession = !isApp || canPerformAction(capabilities, 'appointment.create')
  const canCreateDashboardSession = canCreateSession && (!isApp || (
    workspaceCovered && !workspaceRefreshFailed && !workspaceReadOnlyError
  ))
  const backupAlert = canReadBackupHealth ? dashboardBackupAlert(backupHealth) : null
  const hasDashboardRangeFailure = todayWorkspaceState === 'unavailable'
    || todayWorkspaceFailed
    || (role.scope !== 'own' && (
      balanceWorkspaceState === 'unavailable' || balanceWorkspaceFailed
    ))
  const retryAllDashboardRanges = workspaceReadOnlyError && !hasDashboardRangeFailure
  const retryDashboard = () => Promise.all([
    ...(todayWorkspaceState === 'unavailable' || todayWorkspaceFailed || retryAllDashboardRanges
      ? [retryWorkspace(workspaceRange)] : []),
    ...(role.scope !== 'own' && (balanceWorkspaceState === 'unavailable'
      || balanceWorkspaceFailed || retryAllDashboardRanges) ? [retryWorkspace(balanceRange)] : []),
  ]).catch(() => {})
  const openPayments = () => navigate(
    'payments',
    isApp ? undefined : { allPeriods: true, unpaidOnly: true },
  )
  const figureFmt = !workspaceCovered ? () => '-' : undefined

  return (
    <section className="today-page" role="region" aria-label="Pulpit dnia" ref={ref}>
      <header className="today-hero" data-reveal>
        <h1 className="display masthead__day">{cap(fmtWeekday(today))}, {fmtFullDate(today)}</h1>
        <hr className="today-rule today-rule--masthead" aria-hidden="true" />
        {workspaceCovered && heroSession ? (
          <>
            <p className="today-hero__state">{heroState}</p>
            <p className="display today-hero__time">{heroSession.time}</p>
            <p className="display today-hero__name">{heroClient?.name}</p>
            <p className="today-hero__meta">
              {heroPsych?.room || 'Gabinet do potwierdzenia'} · {heroPsych?.name}
            </p>
          </>
        ) : workspaceCovered ? (
          <>
            <h2 className="display today-hero__title">{terminalHeading}</h2>
            <p className="today-hero__meta">{terminalSupport}</p>
          </>
        ) : null}
        {canCreateDashboardSession && <div className="today-hero__actions">
          {!isApp && heroSession && (
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
          {!isApp && <button className="link" onClick={() => openClientForm()}>Nowy klient</button>}
        </div>}
      </header>

      {backupAlert ? (
        <aside className="today-backup-alert" role="alert" aria-label={backupAlert.title}>
          <div>
            <strong>{backupAlert.title}</strong>
            <span>{backupAlert.description}</span>
          </div>
          <EntityLink route="settings" params={{ section: 'security' }} className="today-backup-alert__link">
            Zobacz, co zrobić <span aria-hidden="true">›</span>
          </EntityLink>
        </aside>
      ) : null}

      {!workspaceCovered && <ViewState
        tone={workspaceUnavailable ? 'error' : 'loading'}
        icon="calendar"
        title={workspaceUnavailable ? 'Nie udało się wczytać całego podsumowania dnia' : 'Wczytuję grafik dnia…'}
        hint={workspaceUnavailable
          ? 'Nie pokazujemy niepełnych danych. Spróbuj ponownie.'
          : 'Pobieramy dzisiejszy grafik.'}
        action={workspaceUnavailable ? <Button onClick={retryDashboard}>Spróbuj ponownie</Button> : undefined}
      />}
      {workspaceRefreshing && <ViewState
        compact
        tone="loading"
        icon="calendar"
        title="Odświeżamy pulpit dnia…"
        hint="Wyświetlamy ostatnio potwierdzone podsumowanie dnia."
      />}
      {workspaceRefreshFailed && <ViewState
        compact
        tone="error"
        icon="calendar"
        title="Nie udało się odświeżyć pulpitu dnia"
        hint="Wyświetlamy ostatnio potwierdzone podsumowanie dnia."
        action={<Button size="sm" onClick={retryDashboard}>Spróbuj ponownie</Button>}
      />}
      <div
        className={`today-page__workspace ${workspaceRefreshing ? 'is-refreshing' : ''}`}
        aria-busy={workspaceRefreshing || undefined}
      >
      <div className="figures today-figures" role="group" aria-label="Podsumowanie dnia">
        <Figure
          label="Odbyte"
          value={!workspaceCovered ? 0 : daySummary.completed}
          fmt={figureFmt}
          suffix={!workspaceCovered ? undefined : `/${daySummary.total}`}
        />
        <Figure label="Nieobecności" value={!workspaceCovered ? 0 : daySummary.noshow} fmt={figureFmt} />
        <Figure label="Pozostałe" value={!workspaceCovered ? 0 : daySummary.scheduled} fmt={figureFmt} />
        <Figure
          label={outstandingLabel}
          value={!workspaceCovered ? 0 : workspaceModel.outstanding}
          fmt={figureFmt || fmtMoney}
          sub={workspaceCovered && canOpenPayments ? 'Pokaż ›' : undefined}
          attention={workspaceCovered && workspaceModel.outstanding > 0}
          onClick={workspaceCovered && canOpenPayments ? openPayments : undefined}
        />
      </div>

      {workspaceCovered && daySummary.total > 0 && (
        <section className="today-plan" aria-label="Plan dnia">
          <TodayThread
            sessions={todays}
            nowMin={nowMin}
            currentId={workspaceModel.current?.id}
            onOpen={isApp ? undefined : (s) => openSessionForm({ session: state.sessions.find((x) => x.id === s.id) })}
          />
        </section>
      )}

      </div>
    </section>
  )
}
