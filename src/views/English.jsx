import { useEffect, useMemo, useState } from 'react'
import { useApp, useActivityMonthRetry } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { Button, EmptyState, Pager } from '../ui.jsx'
import { useRouteParamsSync } from '../ux-patterns.jsx'
import { pageCount, pageSlice } from '../pagination.js'
import { inMonthYear } from '../format.js'
import { ActivityBillingAction } from './FinanceEntryActions.jsx'
import {
  activityActionAvailability,
  activityCurrentMonth,
  activityProgramOverview,
} from '../activity-workspace.js'
import { activityModuleVisible } from '../tus.js'
import {
  ActivityChargeTable,
  ActivityFigures,
  ActivityLatestLink,
  ActivityLoadState,
  ActivityModuleEmpty,
  ActivityMonthNav,
} from './ActivityUi.jsx'

const PAGE_SIZE = 30
const validMonth = (month) => /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')
const englishSubtitle = (month, role) => `${
  role.scope === 'own' ? 'Twoi uczestnicy' : 'Uczestnicy'} i rozliczenia ${inMonthYear(month)}.`

export function English({ params = {} }) {
  const { workspace } = useApp()
  const {
    actor, activityDiscovery, capabilities, getViewState, openActivityGroupForm,
    openActivityParticipantForm, patchViewState, role,
  } = useShell()
  const currentMonth = activityCurrentMonth()
  const [month, setMonth] = useState(() => {
    const saved = getViewState('english', { ym: currentMonth })
    if (validMonth(params.ym)) return params.ym
    if (validMonth(saved.ym)) return saved.ym
    return currentMonth
  })
  const [page, setPage] = useState(1)
  const moduleVisible = useMemo(() => activityModuleVisible({
    capabilities,
    state: workspace.activities?.state,
    specialistId: actor?.specialistId,
    program: 'english',
    month,
  }), [actor?.specialistId, capabilities, month, workspace.activities?.state])
  const usesDiscovery = activityDiscovery?.month === month
  const canLoad = role.scope === 'own' || capabilities.includes('tus.manage')
  const { state: requestedLoadState, retry: retryRequestedLoad } = useActivityMonthRetry(
    month, canLoad && !usesDiscovery,
  )
  const loadState = usesDiscovery ? activityDiscovery.state : requestedLoadState
  const retry = usesDiscovery ? activityDiscovery.retry : retryRequestedLoad
  const ref = useReveal()
  useRouteParamsSync('english', { ym: month })

  useEffect(() => {
    patchViewState('english', { ym: month })
    setPage(1)
  }, [month, patchViewState])

  const overview = useMemo(() => loadState === 'ready'
    ? activityProgramOverview(workspace.activities.state, { program: 'english', month })
    : null, [loadState, month, workspace.activities])

  const actions = activityActionAvailability({ actor, role, capabilities, group: null, loadState })
  const newParticipant = () => openActivityParticipantForm({ month, programId: 'apg_english' })
  const newGroup = () => openActivityGroupForm({ month, programId: 'apg_english', leaderSpecialistIds: [] })
  if (loadState !== 'ready') return (
    <div ref={ref}>
      <div className="view-head">
        <div>
          <h1 className="display view-head__title">Angielski</h1>
          <p className="view-head__sub">{englishSubtitle(month, role)}</p>
        </div>
        <div className="view-head__actions">
          {actions.createParticipant && <Button variant="ghost" icon="plus" onClick={newParticipant}>Nowy uczestnik</Button>}
          {actions.createGroup && <Button icon="plus" onClick={newGroup}>Nowa grupa</Button>}
        </div>
      </div>
      <ActivityMonthNav currentMonth={currentMonth} month={month} onChange={setMonth} />
      <ActivityLoadState state={loadState} title="Angielski" onRetry={retry} />
    </div>
  )
  if (!moduleVisible) return <ActivityModuleEmpty program="english" />

  const programEmpty = overview.groups.length === 0 && overview.participants.length === 0
    && overview.rows.length === 0
  const pages = pageCount(overview.rows.length, PAGE_SIZE)
  const visibleRows = pageSlice(overview.rows, page, PAGE_SIZE)
  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <h1 className="display view-head__title">Angielski</h1>
          <p className="view-head__sub">{englishSubtitle(month, role)}</p>
        </div>
        <div className="view-head__actions">
          {actions.createParticipant && !programEmpty && (
            <Button variant="ghost" icon="plus" onClick={newParticipant}>Nowy uczestnik</Button>
          )}
          {actions.createGroup && <Button icon="plus" onClick={newGroup}>Nowa grupa</Button>}
        </div>
      </div>
      <ActivityMonthNav currentMonth={currentMonth} month={month} onChange={setMonth} />
      {programEmpty ? (
        <EmptyState
          icon="english"
          title="Nie ma jeszcze uczestników angielskiego"
          hint={actions.createParticipant ? 'Dodaj pierwszego uczestnika, aby rozliczać zajęcia.' : undefined}
          action={actions.createParticipant
            ? <Button icon="plus" onClick={newParticipant}>Nowy uczestnik</Button>
            : null}
        />
      ) : overview.rows.length > 0 && <ActivityFigures summary={overview.summary} english />}
      <ActivityLatestLink
        latestMonth={overview.summary.participantCount === 0
          && overview.summary.classCount === 0
          && overview.summary.chargeCount === 0
          ? overview.latestPopulatedMonth : null}
        month={month}
        route="english"
      />

      {overview.groups.length > 0 && (
        <section aria-labelledby="english-groups-title">
          <h2 className="card-title" id="english-groups-title">Grupy angielskiego</h2>
          <div className="grid-2 activity-group-grid">
            {overview.groups.map(({ group, leaders }) => {
              const titleId = `protected-english-group-${group.id}`
              const groupActions = activityActionAvailability({
                actor, role, capabilities, group: { leaders },
              })
              return (
              <article className="card card--pad activity-group-card" key={group.id} aria-labelledby={titleId}>
                <div className="row row--between">
                  <h3 className="card-title activity-wrap" id={titleId}>{group.label}</h3>
                  {groupActions.editGroup && (
                    <Button size="sm" variant="ghost" onClick={() => openActivityGroupForm({
                      group,
                      leaderSpecialistIds: leaders.map(({ specialistId }) => specialistId),
                      month,
                    })}>Edytuj grupę angielskiego</Button>
                  )}
                </div>
                {group.details && <p className="muted activity-wrap">{group.details}</p>}
              </article>
              )
            })}
          </div>
        </section>
      )}

      {!programEmpty && <>
      <section className="card card--pad" aria-labelledby="english-participants-title">
        <h2 className="card-title" id="english-participants-title">Uczestnicy</h2>
        {overview.participants.length > 0 ? (
          <ul className="activity-participant-list">
            {overview.participants.map((participant) => (
              <li className="activity-participant-row activity-wrap" key={participant.id}>
                <span>{participant.name}</span>
                {actions.editParticipant && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openActivityParticipantForm({
                      month, participant, programId: participant.programId,
                    })}
                  >Edytuj</Button>
                )}
              </li>
            ))}
          </ul>
        ) : <EmptyState compact icon="group" title="Nie ma jeszcze uczestników." />}
      </section>

      <section className="card card--pad activity-monthly-table" aria-labelledby="english-month-title">
        <h2 className="card-title" id="english-month-title">Uczestnicy i rozliczenia</h2>
        <ActivityBillingAction month={month} programId="apg_english" participants={overview.participants} />
        {visibleRows.length > 0 ? (
          <>
            <ActivityChargeTable rows={visibleRows} month={month} english titleId="english-month-title" />
            <Pager page={page} pages={pages} onPage={setPage} />
          </>
        ) : (
          <EmptyState compact icon="payments" title="W tym miesiącu nie ma jeszcze rozliczeń." />
        )}
      </section>
      </>}
    </div>
  )
}
