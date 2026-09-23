import { useEffect, useMemo, useState } from 'react'
import { useApp, useActivityMonthRetry } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { Button, EmptyState } from '../ui.jsx'
import { EntityLink, useRouteParamsSync } from '../ux-patterns.jsx'
import { fmtDayMonth, inMonthYear, plural } from '../format.js'
import { conflictCopy, saveFailureCopy } from '../save-failure-copy.js'
import { Icon } from '../icons.jsx'
import { ActivityBillingAction } from './FinanceEntryActions.jsx'
import {
  activityCurrentMonth,
  activityActionAvailability,
  activityGroupView,
  activityProgramOverview,
} from '../activity-workspace.js'
import {
  activityEnrolmentLabel, activityModuleVisible, activityParticipantsWithoutGroup,
} from '../tus.js'
import {
  ActivityBackLink,
  ActivityChargeTable,
  ActivityFigures,
  ActivityLatestLink,
  ActivityLoadState,
  ActivityModuleEmpty,
  ActivityMonthNav,
  activityMoney,
} from './ActivityUi.jsx'

const validMonth = (month) => /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')

const useSelectedActivityMonth = (routeName, params) => {
  const { getViewState, patchViewState } = useShell()
  const currentMonth = activityCurrentMonth()
  const [month, setMonth] = useState(() => {
    const saved = getViewState(routeName, { ym: currentMonth })
    if (validMonth(params.ym)) return params.ym
    if (validMonth(saved.ym)) return saved.ym
    return currentMonth
  })
  useEffect(() => {
    patchViewState(routeName, { ym: month })
  }, [month, patchViewState, routeName])
  return { currentMonth, month, setMonth }
}

const tusSubtitle = (month, role) => `Trening Umiejętności Społecznych - ${
  role.scope === 'own' ? 'Twoje grupy' : 'grupy'} i rozliczenia ${inMonthYear(month)}.`

const ATTENDANCE_LABEL = Object.freeze({
  absent: 'Nieobecność', excused: 'Nieobecność usprawiedliwiona',
  present: 'Obecność', unknown: 'Nieoznaczona obecność',
})

function ProtectedAttendance({ actions, activityClass, month, participantRows, rows }) {
  const { workspace } = useApp()
  const [pendingId, setPendingId] = useState(null)
  const [error, setError] = useState(null)
  const byParticipant = new Map(rows.map((row) => [row.participant.id, row.attendance]))
  const setAttendance = async (participant) => {
    const current = byParticipant.get(participant.id)
    const nextStatus = current?.status === 'present' ? 'absent' : 'present'
    setPendingId(participant.id)
    setError(null)
    try {
      await workspace.activities.setAttendance(activityClass.id, {
        participantId: participant.id,
        status: nextStatus,
        expectedVersion: current?.version ?? 0,
      }, { from: month, to: month })
    } catch (submitError) {
      if (!['SESSION_AUTHORITY_STALE', 'WORKSPACE_AUTHORITY_STALE'].includes(submitError?.code)) {
        if (submitError?.code === 'VERSION_CONFLICT') {
          try { await workspace.activities.loadWindow({ from: month, to: month }) } catch { /* Keep control available. */ }
        }
        setError(submitError?.code === 'VERSION_CONFLICT'
          ? conflictCopy('obecność')
          : saveFailureCopy(submitError, { subject: 'obecności' }))
        setPendingId(null)
      }
      return
    }
    // The button itself shows the new state, so no toast per click.
    setPendingId(null)
  }
  return (
    <div className="activity-attendance">
      {participantRows.map(({ participant }) => {
        const attendance = byParticipant.get(participant.id)
        const status = attendance?.status ?? 'unknown'
        return (
          <button
            type="button"
            className="att"
            key={participant.id}
            aria-label={`Obecność: ${participant.name}, ${fmtDayMonth(activityClass.date)}, ${ATTENDANCE_LABEL[status]}`}
            aria-pressed={status === 'present'}
            disabled={!actions.editAttendance || pendingId !== null}
            onClick={() => setAttendance(participant)}
          >
            {participant.name} · {ATTENDANCE_LABEL[status]}
          </button>
        )
      })}
      {error && <p className="form-warn form-warn--error" role="alert">{error}</p>}
    </div>
  )
}

export function ProtectedTusOverview({ params }) {
  const { state, workspace } = useApp()
  const {
    actor, activityDiscovery, capabilities, openActivityGroupForm, openActivityMembershipForm,
    openActivityParticipantForm, role,
  } = useShell()
  const ref = useReveal()
  const { currentMonth, month, setMonth } = useSelectedActivityMonth('tus', params)
  const moduleVisible = useMemo(() => activityModuleVisible({
    capabilities,
    state: workspace.activities?.state,
    specialistId: actor?.specialistId,
    program: 'tus',
    month,
  }), [actor?.specialistId, capabilities, month, workspace.activities?.state])
  const usesDiscovery = activityDiscovery?.month === month
  const canLoad = role.scope === 'own' || capabilities.includes('tus.manage')
  const { state: requestedLoadState, retry: retryRequestedLoad } = useActivityMonthRetry(
    month, canLoad && !usesDiscovery,
  )
  const loadState = usesDiscovery ? activityDiscovery.state : requestedLoadState
  const retry = usesDiscovery ? activityDiscovery.retry : retryRequestedLoad
  useRouteParamsSync('tus', { ym: month })
  const actions = activityActionAvailability({ actor, role, capabilities, group: null, loadState })
  const overview = useMemo(() => loadState === 'ready'
    ? activityProgramOverview(workspace.activities.state, { program: 'tus', month })
    : null, [loadState, month, workspace.activities])
  const withoutGroup = useMemo(() => loadState === 'ready'
    ? activityParticipantsWithoutGroup(workspace.activities.state, { programId: 'apg_tus', month })
    : [], [loadState, month, workspace.activities])
  const specialistName = new Map(state.psychologists.map(({ id, name }) => [id, name]))
  const newGroup = () => openActivityGroupForm({ month, programId: 'apg_tus', leaderSpecialistIds: [] })

  if (loadState !== 'ready') return (
    <div ref={ref}>
      <div className="view-head">
        <div>
          <h1 className="display view-head__title">Grupy TUS</h1>
          <p className="view-head__sub">{tusSubtitle(month, role)}</p>
        </div>
        <div className="view-head__actions">
          {actions.createParticipant && <Button variant="ghost" icon="plus" onClick={() => openActivityParticipantForm({ month, programId: 'apg_tus' })}>Nowy uczestnik TUS</Button>}
          {actions.createGroup && <Button icon="plus" onClick={newGroup}>Nowa grupa</Button>}
        </div>
      </div>
      <ActivityMonthNav currentMonth={currentMonth} month={month} onChange={setMonth} />
      <ActivityLoadState state={loadState} title="Grupy TUS" onRetry={retry} />
    </div>
  )
  if (!moduleVisible) return <ActivityModuleEmpty program="tus" />
  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <h1 className="display view-head__title">Grupy TUS</h1>
          <p className="view-head__sub">{tusSubtitle(month, role)}</p>
        </div>
        <div className="view-head__actions">
          {actions.createParticipant && (
            <Button variant="ghost" icon="plus" onClick={() => openActivityParticipantForm({
              month, programId: 'apg_tus',
            })}>Nowy uczestnik TUS</Button>
          )}
          {actions.createGroup && overview.groups.length > 0 && (
            <Button icon="plus" onClick={newGroup}>Nowa grupa</Button>
          )}
        </div>
      </div>
      <ActivityMonthNav currentMonth={currentMonth} month={month} onChange={setMonth} />
      {overview.groups.length === 0 ? (
        <EmptyState
          icon="group"
          title="Nie ma jeszcze żadnej grupy TUS"
          hint={actions.createGroup ? 'Utwórz pierwszą grupę, aby zapisywać uczestników i planować zajęcia.' : undefined}
          action={actions.createGroup ? <Button icon="plus" onClick={newGroup}>Nowa grupa</Button> : null}
        />
      ) : <ActivityFigures summary={overview.summary} />}
      <ActivityLatestLink
        latestMonth={overview.summary.participantCount === 0
          && overview.summary.classCount === 0
          && overview.summary.chargeCount === 0
          ? overview.latestPopulatedMonth : null}
        month={month}
        route="tus"
      />
      <div className="grid-2 activity-group-grid">
        {overview.groups.map(({ group, leaders, latestClass, summary }) => {
          const titleId = `protected-tus-group-${group.id}`
          const leaderNames = leaders.map(({ specialistId }) => specialistName.get(specialistId)).filter(Boolean)
          return (
            <article className="card card--pad activity-group-card" key={group.id} aria-labelledby={titleId} data-reveal>
              <EntityLink
                route="tusGroup"
                params={{ id: group.id, ym: month }}
                className="activity-group-card__link"
                label={`Otwórz grupę — ${group.label}`}
              >
                <div className="row row--between">
                  <h2 className="card-title" id={titleId}>{group.label}</h2>
                  <Icon name="chevR" size={18} aria-hidden="true" />
                </div>
                {group.details && <p className="muted activity-wrap">{group.details}</p>}
                {leaders.length > 0 && (
                  <p className="muted activity-wrap activity-group-card__leaders">
                    Prowadzący: {leaderNames.length > 0
                      ? leaderNames.join(', ')
                      : `${leaders.length} ${plural(leaders.length, 'osoba', 'osoby', 'osób')}`}
                  </p>
                )}
                {latestClass && (
                  <p className="muted activity-group-card__latest">
                    Ostatnie zajęcia: <time dateTime={latestClass.date}>{fmtDayMonth(latestClass.date)}</time>
                  </p>
                )}
                <dl className="activity-card-facts">
                  <div><dt>Uczestnicy</dt><dd>{summary.participantCount}</dd></div>
                  <div><dt>Zajęcia</dt><dd>{summary.classCount}</dd></div>
                  <div><dt>Kwota</dt><dd>{activityMoney(summary.amountGrosze)}</dd></div>
                  <div><dt>Wpłacono</dt><dd>{activityMoney(summary.paidAmountGrosze)}</dd></div>
                  <div><dt>Pozostało</dt><dd>{activityMoney(summary.outstandingAmountGrosze)}</dd></div>
                </dl>
              </EntityLink>
            </article>
          )
        })}
      </div>
      {role.scope === 'centre' && withoutGroup.length > 0 && (
        <section className="card card--pad activity-ungrouped" aria-labelledby="protected-tus-ungrouped">
          <h2 className="card-title" id="protected-tus-ungrouped">Uczestnicy bez grupy</h2>
          <ul className="activity-participant-list">
            {withoutGroup.map((participant) => (
              <li className="activity-participant-row" key={participant.id}>
                <strong className="activity-wrap">{participant.name}</strong>
                {actions.createMembership && overview.groups.length > 0 && (
                <Button size="sm" variant="soft" onClick={() => openActivityMembershipForm({
                  month,
                  participantId: participant.id,
                  participants: overview.participants,
                  groups: overview.groups.map(({ group }) => group),
                })}>Zapisz do grupy</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export function ProtectedTusGroup({ params }) {
  const { workspace } = useApp()
  const {
    actor, activityDiscovery, capabilities, openActivityClassForm, openActivityGroupForm,
    openActivityMembershipForm, openActivityParticipantForm, role,
  } = useShell()
  const ref = useReveal([params.id])
  const { currentMonth, month, setMonth } = useSelectedActivityMonth('tusGroup', params)
  const group = workspace.activities.state.groupsById[params.id]
  const moduleVisible = useMemo(() => activityModuleVisible({
    capabilities,
    state: workspace.activities?.state,
    specialistId: actor?.specialistId,
    program: 'tus',
    month,
  }) && (capabilities.includes('tus.manage') || group?.programId === 'apg_tus'), [
    actor?.specialistId, capabilities, group?.programId, month, workspace.activities?.state,
  ])
  const usesDiscovery = activityDiscovery?.month === month
  const canLoad = role.scope === 'own' || capabilities.includes('tus.manage')
  const { state: requestedLoadState, retry: retryRequestedLoad } = useActivityMonthRetry(
    month, canLoad && !usesDiscovery,
  )
  const loadState = usesDiscovery ? activityDiscovery.state : requestedLoadState
  const retry = usesDiscovery ? activityDiscovery.retry : retryRequestedLoad
  useRouteParamsSync('tusGroup', { id: params.id, ym: month })
  const view = useMemo(() => loadState === 'ready'
    ? activityGroupView(workspace.activities.state, { groupId: params.id, month })
    : undefined, [loadState, month, params.id, workspace.activities])

  if (loadState !== 'ready') return (
    <div ref={ref}>
      <ActivityBackLink month={month} />
      <div className="view-head">
        <div>
          <h1 className="display view-head__title">Grupa TUS</h1>
        </div>
      </div>
      <ActivityMonthNav currentMonth={currentMonth} month={month} onChange={setMonth} />
      <ActivityLoadState state={loadState} title="Grupa TUS" onRetry={retry} />
    </div>
  )
  if (!moduleVisible) return <ActivityModuleEmpty program="tus" />
  if (view === null) {
    return (
      <EmptyState
        icon="group"
        title="Nie znaleziono grupy"
        hint="Grupa nie istnieje albo nie należy do Twojego zakresu."
        action={<EntityLink route="tus" params={{ ym: month }} className="btn btn--soft btn--sm">Wróć do zajęć TUS</EntityLink>}
      />
    )
  }
  const actions = activityActionAvailability({
    actor, role, capabilities, group: { leaders: view.leaders },
  })
  const participants = view.participantOptions
  return (
    <div ref={ref}>
      <ActivityBackLink month={month} />
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Grupa TUS</div>
          <h1 className="display view-head__title activity-wrap">{view.group.label}</h1>
          {view.group.details && <p className="view-head__sub activity-wrap">{view.group.details}</p>}
        </div>
        <div className="view-head__actions">
          {actions.editGroup && (
            <Button variant="ghost" onClick={() => openActivityGroupForm({
              group: view.group,
              leaderSpecialistIds: view.leaders.map(({ specialistId }) => specialistId),
              month,
            })}>Edytuj grupę</Button>
          )}
          {actions.createClass && (
            <Button icon="plus" onClick={() => openActivityClassForm({
              groupId: view.group.id, month, onSavedMonth: setMonth,
            })}>Dodaj zajęcia</Button>
          )}
        </div>
      </div>
      <ActivityMonthNav currentMonth={currentMonth} month={month} onChange={setMonth} />
      <ActivityFigures summary={view.summary} />
      <ActivityLatestLink
        latestMonth={view.summary.participantCount === 0
          && view.summary.classCount === 0
          && view.summary.chargeCount === 0
          ? workspace.activities.state.latestPopulatedMonths.tus : null}
        month={month}
        route="tusGroup"
        params={{ id: view.group.id }}
      />
      <section className="card card--pad" aria-labelledby="protected-tus-participants">
        <div className="row row--between">
          <h2 className="card-title" id="protected-tus-participants">Uczestnicy grupy</h2>
          {actions.createMembership && (
            <Button size="sm" variant="soft" icon="plus" onClick={() => openActivityMembershipForm({
              groupId: view.group.id, month, participants,
            })}>Zapisz do grupy</Button>
          )}
        </div>
        {view.participantRows.length > 0 ? (
          <ul className="activity-participant-list">
            {view.participantRows.map(({ membership, participant }) => (
              <li className="activity-participant-row" key={membership.id}>
                <span className="activity-wrap">
                  <strong>{participant.name}</strong>
                  <small>{activityEnrolmentLabel(membership, month)}</small>
                </span>
                <span className="row">
                  {actions.editParticipant && (
                    <Button size="sm" variant="ghost" onClick={() => openActivityParticipantForm({
                      month, participant, programId: participant.programId,
                    })}>Edytuj uczestnika</Button>
                  )}
                  {actions.editMembership && membership.membershipKind === 'interval' && (
                    <Button size="sm" variant="ghost" onClick={() => openActivityMembershipForm({
                      groupId: view.group.id, membership, month, participants,
                    })}>Zmień daty zapisu</Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : <EmptyState compact icon="group" title="W tym miesiącu nikt nie jest zapisany do grupy." />}
      </section>
      <section className="card card--pad" aria-labelledby="protected-tus-charges">
        <h2 className="card-title" id="protected-tus-charges">Rozliczenia uczestników</h2>
        <ActivityBillingAction month={month} programId="apg_tus" groupId={view.group.id} participants={participants} />
        {view.chargeRows.length > 0
          ? <ActivityChargeTable rows={view.chargeRows} month={month} titleId="protected-tus-charges" />
          : <EmptyState compact icon="payments" title="W tym miesiącu nie ma jeszcze rozliczeń." />}
      </section>
      <section className="card card--pad" aria-labelledby="protected-tus-classes">
        <h2 className="card-title" id="protected-tus-classes">Zajęcia i obecność</h2>
        {view.classes.length === 0 ? (
          <EmptyState compact icon="calendar" title="W tym miesiącu nie ma jeszcze zajęć." />
        ) : view.classes.map(({ activityClass, attendance }) => (
          <article className="activity-class" key={activityClass.id}>
            <div className="row row--between">
              <h3><time dateTime={activityClass.date}>{fmtDayMonth(activityClass.date)}</time>{activityClass.time ? ` · ${activityClass.time}` : ''}</h3>
              {actions.editClass && (
                <Button size="sm" variant="ghost" onClick={() => openActivityClassForm({
                  activityClass, groupId: view.group.id, month, onSavedMonth: setMonth,
                })}>Edytuj zajęcia</Button>
              )}
            </div>
            <p>{activityClass.topic ?? 'Bez zapisanego tematu'} · {attendance.length} {plural(attendance.length, 'zapis obecności', 'zapisy obecności', 'zapisów obecności')}</p>
            <ProtectedAttendance
              actions={actions}
              activityClass={activityClass}
              month={month}
              participantRows={view.participantRows}
              rows={attendance}
            />
          </article>
        ))}
      </section>
    </div>
  )
}
