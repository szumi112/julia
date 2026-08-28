import { useEffect, useMemo, useState } from 'react'
import { useApp, useActivityMonth } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { EmptyState } from '../ui.jsx'
import { Button } from '../ui.jsx'
import { EntityLink, useRouteParamsSync } from '../ux-patterns.jsx'
import { fmtMonthYear } from '../format.js'
import {
  activityCurrentMonth,
  activityActionAvailability,
  activityGroupView,
  activityProgramOverview,
} from '../activity-workspace.js'
import {
  ActivityBackLink,
  ActivityChargeTable,
  ActivityFigures,
  ActivityLatestLink,
  ActivityLoadState,
  ActivityMonthNav,
  activityMoney,
} from './ActivityUi.jsx'

const validMonth = (month, current) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')
  && month <= current

const useSelectedActivityMonth = (routeName, params) => {
  const { getViewState, patchViewState } = useShell()
  const currentMonth = activityCurrentMonth()
  const [month, setMonth] = useState(() => {
    const saved = getViewState(routeName, { ym: currentMonth })
    if (validMonth(params.ym, currentMonth)) return params.ym
    if (validMonth(saved.ym, currentMonth)) return saved.ym
    return currentMonth
  })
  useEffect(() => {
    patchViewState(routeName, { ym: month })
  }, [month, patchViewState, routeName])
  return { currentMonth, month, setMonth }
}

const ATTENDANCE_LABEL = Object.freeze({
  absent: 'nieobecna', excused: 'nieobecność usprawiedliwiona',
  present: 'obecna', unknown: 'status nieznany',
})

function ProtectedAttendance({ actions, activityClass, month, participantRows, rows }) {
  const { toast, workspace } = useApp()
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
          ? 'Obecność zmieniła się w innym oknie. Sprawdź odświeżone dane.'
          : 'Nie udało się zapisać obecności.')
        setPendingId(null)
      }
      return
    }
    toast('Obecność została zapisana')
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
            aria-label={`Obecność: ${participant.name}, ${activityClass.date}, ${ATTENDANCE_LABEL[status]}`}
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
  const { workspace } = useApp()
  const {
    actor, capabilities, openActivityGroupForm, openActivityParticipantForm, role,
  } = useShell()
  const ref = useReveal()
  const { currentMonth, month, setMonth } = useSelectedActivityMonth('tus', params)
  const loadState = useActivityMonth(month)
  useRouteParamsSync('tus', { ym: month })
  const overview = useMemo(() => loadState === 'ready'
    ? activityProgramOverview(workspace.activities.state, { program: 'tus', month })
    : null, [loadState, month, workspace.activities])

  if (!overview) return <ActivityLoadState state={loadState} />
  const actions = activityActionAvailability({ actor, role, capabilities, group: null })
  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Zajęcia grupowe</div>
          <h1 className="display view-head__title">Grupy TUS</h1>
          <p className="view-head__sub">
            {role.scope === 'own' ? 'Widok grup i rozliczeń w Twoim zakresie' : 'Widok grup i rozliczeń całego centrum'}
            {' · '}{fmtMonthYear(month)}
          </p>
        </div>
        <div className="view-head__actions">
          {actions.createParticipant && (
            <Button variant="ghost" icon="plus" onClick={() => openActivityParticipantForm({
              month, programId: 'apg_tus',
            })}>Nowy uczestnik TUS</Button>
          )}
          {actions.createGroup && (
            <Button icon="plus" onClick={() => openActivityGroupForm({
              month, programId: 'apg_tus', leaderSpecialistIds: [],
            })}>Nowa grupa</Button>
          )}
          <ActivityMonthNav currentMonth={currentMonth} month={month} onChange={setMonth} />
        </div>
      </div>
      <ActivityFigures summary={overview.summary} />
      <ActivityLatestLink
        latestMonth={overview.summary.participantCount === 0
          && overview.summary.classCount === 0
          && overview.summary.chargeCount === 0
          ? overview.latestPopulatedMonth : null}
        month={month}
        route="tus"
      />
      <div className="grid-2 activity-group-grid">
        {overview.groups.map(({ group, leaders, summary }) => {
          const titleId = `protected-tus-group-${group.id}`
          return (
            <article className="card card--pad activity-group-card" key={group.id} aria-labelledby={titleId} data-reveal>
              <EntityLink
                route="tusGroup"
                params={{ id: group.id, ym: month }}
                className="activity-group-card__link"
                label={`Otwórz grupę — ${group.label}`}
              >
                <h2 className="card-title" id={titleId}>{group.label}</h2>
              </EntityLink>
              {group.details && <p className="muted activity-wrap">{group.details}</p>}
              <dl className="activity-card-facts">
                <div><dt>Uczestnicy</dt><dd>{summary.participantCount}</dd></div>
                <div><dt>Zajęcia</dt><dd>{summary.classCount}</dd></div>
                <div><dt>Prowadzący</dt><dd>{leaders.length}</dd></div>
                <div><dt>Kwota</dt><dd>{activityMoney(summary.amountGrosze)}</dd></div>
                <div><dt>Wpłacono</dt><dd>{activityMoney(summary.paidAmountGrosze)}</dd></div>
                <div><dt>Pozostało</dt><dd>{activityMoney(summary.outstandingAmountGrosze)}</dd></div>
              </dl>
            </article>
          )
        })}
      </div>
      {overview.groups.length === 0 && (
        <EmptyState icon="group" title="Brak grup TUS w tym zakresie" />
      )}
      {overview.summary.classCount === 0 && (
        <p className="muted activity-empty-note">Brak zapisanych zajęć w tym miesiącu</p>
      )}
    </div>
  )
}

export function ProtectedTusGroup({ params }) {
  const { workspace } = useApp()
  const {
    actor, capabilities, openActivityClassForm, openActivityGroupForm,
    openActivityMembershipForm, openActivityParticipantForm, role,
  } = useShell()
  const ref = useReveal([params.id])
  const { currentMonth, month, setMonth } = useSelectedActivityMonth('tusGroup', params)
  const loadState = useActivityMonth(month)
  useRouteParamsSync('tusGroup', { id: params.id, ym: month })
  const view = useMemo(() => loadState === 'ready'
    ? activityGroupView(workspace.activities.state, { groupId: params.id, month })
    : undefined, [loadState, month, params.id, workspace.activities])

  if (loadState !== 'ready') return <ActivityLoadState state={loadState} />
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
  const participants = Object.values(workspace.activities.state.participantsById)
    .filter((participant) => participant.programId === view.group.programId)
    .sort((left, right) => left.name.localeCompare(right.name, 'pl'))
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
          {actions.createMembership && (
            <Button variant="ghost" icon="plus" onClick={() => openActivityMembershipForm({
              groupId: view.group.id, month, participants,
            })}>Dodaj przypisanie</Button>
          )}
          {actions.createClass && (
            <Button icon="plus" onClick={() => openActivityClassForm({
              groupId: view.group.id, month,
            })}>Dodaj zajęcia</Button>
          )}
          <ActivityMonthNav currentMonth={currentMonth} month={month} onChange={setMonth} />
        </div>
      </div>
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
      <section className="card card--pad" aria-label="Przypisania uczestników">
        <h2 className="card-title">Przypisania uczestników</h2>
        {view.participantRows.length > 0 ? (
          <ul className="activity-participant-list">
            {view.participantRows.map(({ membership, participant }) => (
              <li className="activity-participant-row" key={membership.id}>
                <span className="activity-wrap">
                  <strong>{participant.name}</strong>
                  <small>
                    {membership.membershipKind === 'observation'
                      ? `Obserwacja: ${membership.period.month ?? membership.period.day}`
                      : `${membership.startsOn}${membership.endsOn ? ` – ${membership.endsOn}` : ''}`}
                  </small>
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
                    })}>Edytuj przypisanie</Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">Brak jawnych przypisań w tym miesiącu.</p>}
      </section>
      <section className="card card--pad" aria-labelledby="protected-tus-charges">
        <h2 className="card-title" id="protected-tus-charges">Rozliczenia uczestników</h2>
        {view.chargeRows.length > 0
          ? <ActivityChargeTable rows={view.chargeRows} titleId="protected-tus-charges" />
          : <p className="muted">Brak rozliczeń w tym miesiącu.</p>}
      </section>
      <section className="card card--pad" aria-labelledby="protected-tus-classes">
        <h2 className="card-title" id="protected-tus-classes">Zajęcia i obecność</h2>
        {view.classes.length === 0 ? (
          <p className="muted">Brak zapisanych zajęć w tym miesiącu</p>
        ) : view.classes.map(({ activityClass, attendance }) => (
          <article className="activity-class" key={activityClass.id}>
            <div className="row row--between">
              <h3><time dateTime={activityClass.date}>{activityClass.date}</time>{activityClass.time ? ` · ${activityClass.time}` : ''}</h3>
              {actions.editClass && (
                <Button size="sm" variant="ghost" onClick={() => openActivityClassForm({
                  activityClass, groupId: view.group.id, month,
                })}>Edytuj zajęcia</Button>
              )}
            </div>
            <p>{activityClass.topic ?? 'Bez zapisanego tematu'} · {attendance.length} zapisów obecności</p>
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
