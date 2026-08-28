import { useEffect, useMemo, useState } from 'react'
import { useApp, useActivityMonth } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { Button, EmptyState, Pager } from '../ui.jsx'
import { useRouteParamsSync } from '../ux-patterns.jsx'
import { pageCount, pageSlice } from '../pagination.js'
import { fmtMonthYear } from '../format.js'
import {
  activityActionAvailability,
  activityCurrentMonth,
  activityProgramOverview,
} from '../activity-workspace.js'
import {
  ActivityChargeTable,
  ActivityFigures,
  ActivityLatestLink,
  ActivityLoadState,
  ActivityMonthNav,
} from './ActivityUi.jsx'

const PAGE_SIZE = 30
const validMonth = (month, current) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')
  && month <= current

export function English({ params = {} }) {
  const { workspace } = useApp()
  const {
    actor, capabilities, getViewState, openActivityGroupForm,
    openActivityParticipantForm, patchViewState, role,
  } = useShell()
  const currentMonth = activityCurrentMonth()
  const [month, setMonth] = useState(() => {
    const saved = getViewState('english', { ym: currentMonth })
    if (validMonth(params.ym, currentMonth)) return params.ym
    if (validMonth(saved.ym, currentMonth)) return saved.ym
    return currentMonth
  })
  const [page, setPage] = useState(1)
  const loadState = useActivityMonth(month)
  const ref = useReveal([month])
  useRouteParamsSync('english', { ym: month })

  useEffect(() => {
    patchViewState('english', { ym: month })
    setPage(1)
  }, [month, patchViewState])

  const overview = useMemo(() => loadState === 'ready'
    ? activityProgramOverview(workspace.activities.state, { program: 'english', month })
    : null, [loadState, month, workspace.activities])
  if (!overview) return <ActivityLoadState state={loadState} title="Angielski" />

  const pages = pageCount(overview.rows.length, PAGE_SIZE)
  const visibleRows = pageSlice(overview.rows, page, PAGE_SIZE)
  const actions = activityActionAvailability({ actor, role, capabilities, group: null })
  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Zajęcia językowe</div>
          <h1 className="display view-head__title">Angielski</h1>
          <p className="view-head__sub">
            {role.scope === 'own' ? 'Uczestnicy i rozliczenia w Twoim zakresie' : 'Uczestnicy i rozliczenia całego centrum'}
            {' · '}{fmtMonthYear(month)}
          </p>
        </div>
        <div className="view-head__actions">
          {actions.createGroup && (
            <Button variant="ghost" icon="plus" onClick={() => openActivityGroupForm({
              month, programId: 'apg_english', leaderSpecialistIds: [],
            })}>Nowa grupa angielskiego</Button>
          )}
          {actions.createParticipant && (
            <Button icon="plus" onClick={() => openActivityParticipantForm({
              month, programId: 'apg_english',
            })}>Nowy uczestnik</Button>
          )}
          <ActivityMonthNav currentMonth={currentMonth} month={month} onChange={setMonth} />
        </div>
      </div>
      <ActivityFigures summary={overview.summary} english />
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
          <h2 className="card-title" id="english-groups-title">Grupy i programy</h2>
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

      <section className="card card--pad" aria-labelledby="english-participants-title">
        <h2 className="card-title" id="english-participants-title">Uczestnicy programu</h2>
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
        ) : <p className="muted">Brak uczestników programu.</p>}
      </section>

      <section className="card card--pad activity-monthly-table" aria-labelledby="english-month-title">
        <h2 className="card-title" id="english-month-title">Uczestnicy i rozliczenia</h2>
        {visibleRows.length > 0 ? (
          <>
            <ActivityChargeTable rows={visibleRows} english titleId="english-month-title" />
            <Pager page={page} pages={pages} onPage={setPage} />
          </>
        ) : (
          <EmptyState compact icon="group" title="Brak danych z angielskiego w tym miesiącu" />
        )}
      </section>

      {overview.ungroupedRows.length > 0 && (
        <section className="card card--pad" aria-labelledby="english-ungrouped-title">
          <h2 className="card-title" id="english-ungrouped-title">Bez przypisanej grupy</h2>
          <p className="muted">Te wiersze nie zawierają potwierdzonego przypisania do grupy ani członkostwa.</p>
        </section>
      )}
    </div>
  )
}
