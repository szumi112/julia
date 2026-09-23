import { Fragment, useMemo, useRef, useState } from 'react'
import { useApp, useAppointmentMutationLock, useWorkspaceRetry, useWorkspaceWindow } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { canPerformAction } from '../capability-access.js'
import { useReveal, useDrawerFX } from '../anim.js'
import { useMinuteNow } from '../clock.js'
import { Button, Avatar, IconBtn, EmptyState, Figure } from '../ui.jsx'
import { EntityLink, ViewState } from '../ux-patterns.jsx'
import { todayWorkspace } from '../workspace.js'
import { isWorkspaceRangeCovered, rollingWorkspaceRange, weekWorkspaceRange } from '../workspace-view.js'
import { isWorkspaceRangePending } from '../workspace-load-request.js'
import { loadFailureCopy } from '../save-failure-copy.js'
import {
  fmtMoney, fmtWeekday, fmtFullDate, toISODate, pad2,
  cap, plural, timeToMin, relDayLabel,
} from '../format.js'

// A row only earns a status word when its state isn't obvious from the clock.
const ROW_STATUS = { completed: 'odbyta', noshow: 'nieobecność' }

// today's sessions in plain time order — the "teraz" marker carries the ordering
// so no row has to explain its own position
function TodayThread({ sessions, nowMin, currentId, canOpen, onOpen }) {
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
          const status = live ? 'trwa' : overdue ? 'do oznaczenia' : ROW_STATUS[session.status] || ''
          const Row = canOpen(session) ? 'button' : 'div'
          return (
            <Fragment key={session.id}>
              {markerHere && <div className="spine__now" aria-hidden="true">teraz</div>}
              <Row
                className={`spine__row today-session ${live ? 'is-live' : ''} ${session.status === 'completed' ? 'is-done' : ''}`}
                data-status={session.status}
                style={{ '--node-color': session.psych?.color }}
                onClick={Row === 'button' ? () => onOpen(session) : undefined}
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
  const { locked: appointmentMutationLocked } = useAppointmentMutationLock()
  const {
    appMode, canAccess, capabilities, openSessionForm, openClientForm, navigate, role,
  } = useShell()
  const isApp = appMode === 'app'
  const ref = useReveal()
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
  const unresolved = daySummary.unresolvedPast
  const terminalHeading = unresolved > 0
    ? `${unresolved} ${plural(unresolved, 'sesja czeka', 'sesje czekają', 'sesji czeka')} na oznaczenie`
    : daySummary.total > 0 ? 'Dzień zakończony' : 'Dziś nie ma sesji.'
  const terminalSupport = unresolved > 0
    ? 'Zaznacz, jak poszły dzisiejsze sesje.'
    : daySummary.total > 0 ? 'Wszystkie dzisiejsze sesje są oznaczone.' : null

  const outstandingLabel = isApp
    ? (role.scope === 'own' ? 'Do zapłaty za dzisiejsze sesje' : 'Do zapłaty (ostatnie 3 miesiące)')
    : 'Zaległe'
  const canOpenPayments = isApp ? canAccess('payments') : role.scope !== 'own'
  const canCreateSession = !isApp || canPerformAction(capabilities, 'appointment.create')
  const canCreateDashboardSession = canCreateSession && (!isApp || (
    workspaceCovered && !workspaceRefreshFailed && !workspaceReadOnlyError
  ))
  const canEditSession = (session) => !isApp || (
    canPerformAction(capabilities, 'appointment.edit')
    && workspaceCovered && !workspaceRefreshFailed && !workspaceReadOnlyError
    && !appointmentMutationLocked
    && !session.readOnly && !clientOf(session.clientId)?.readOnly
  )
  const openSession = (session) => openSessionForm({
    session: state.sessions.find((candidate) => candidate.id === session.id) ?? session,
    workspaceRange,
  })
  const canOpenHero = workspaceCovered && heroSession && canEditSession(heroSession)
  const showClientsLink = isApp && canAccess('clients') === true
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
              {heroPsych?.room ? `${heroPsych.room} · ` : ''}{heroPsych?.name}
            </p>
          </>
        ) : workspaceCovered ? (
          <>
            <h2 className="display today-hero__title">{terminalHeading}</h2>
            {terminalSupport && <p className="today-hero__meta">{terminalSupport}</p>}
          </>
        ) : null}
        {(canCreateDashboardSession || canOpenHero || showClientsLink) && <div className="today-hero__actions">
          {canOpenHero && (
            <Button magnetic onClick={() => openSession(heroSession)}>Otwórz sesję</Button>
          )}
          {canCreateDashboardSession && <Button
            variant={canOpenHero ? 'ghost' : 'primary'}
            icon="plus"
            magnetic={!canOpenHero}
            onClick={() => openSessionForm()}
          >
            Nowa sesja
          </Button>}
          {!isApp && <button className="link" onClick={() => openClientForm()}>Nowy klient</button>}
          {showClientsLink && <EntityLink route="clients" className="link">Przejdź do klientów</EntityLink>}
        </div>}
      </header>

      {!workspaceCovered && <ViewState
        tone={workspaceUnavailable ? 'error' : 'loading'}
        icon={workspaceUnavailable ? 'alert' : 'calendar'}
        title={workspaceUnavailable ? loadFailureCopy('planu dnia') : 'Wczytuję plan dnia…'}
        action={workspaceUnavailable ? <Button onClick={retryDashboard}>Spróbuj ponownie</Button> : undefined}
      />}
      {workspaceRefreshing && <ViewState
        compact
        tone="loading"
        icon="calendar"
        title="Wczytuję plan dnia…"
      />}
      {workspaceRefreshFailed && <ViewState
        compact
        tone="error"
        icon="alert"
        title="Nie udało się odświeżyć planu dnia"
        hint="Widzisz ostatnio wczytane dane."
        action={<Button size="sm" onClick={retryDashboard}>Spróbuj ponownie</Button>}
      />}
      <div
        className={`today-page__workspace ${workspaceRefreshing ? 'is-refreshing' : ''}`}
        aria-busy={workspaceRefreshing || undefined}
      >
      <div className="figures today-figures" role="group" aria-label="Podsumowanie dnia">
        <Figure label="Odbyte" value={!workspaceCovered ? 0 : daySummary.completed} fmt={figureFmt} />
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
            canOpen={canEditSession}
            onOpen={openSession}
          />
        </section>
      )}

      </div>
    </section>
  )
}
