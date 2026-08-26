import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { useMinuteNow } from '../clock.js'
import { Avatar, Pill, Button, EmptyState, IconBtn, SearchInput } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { monthKey, toISODate, fmtDayMonth, fmtMoney, pad2, WEEKDAY_SHORT, plural } from '../format.js'
import {
  kidsOfGroup, nextClassOf, searchTusOverview, sortTusByName, sortTusGroups, tusAgeLabel, tusAssignmentOptions,
  tusAssignmentStatusLabel, tusGroupsForRole, tusMonthSummary, unassignedKids,
} from '../tus.js'
import { EntityLink } from '../ux-patterns.jsx'

export const kidsWord = (n) => plural(n, 'dziecko', 'dzieci', 'dzieci')

function AssignmentDialog({ fallbackRef, groups, kid, kids, onClose }) {
  const { dispatch, toast } = useApp()
  const dialogRef = useRef(null)
  const [groupId, setGroupId] = useState('')
  const options = useMemo(
    () => tusAssignmentOptions({ groups, kids, kid }),
    [groups, kid, kids]
  )

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    dialog?.querySelector('input:not(:disabled)')?.focus()
    return () => {
      if (dialog?.open) dialog.close()
      requestAnimationFrame(() => {
        const target = kid.opener?.isConnected ? kid.opener : fallbackRef.current
        target?.focus({ preventScroll: true })
      })
    }
  }, [fallbackRef, kid.opener])

  const close = () => onClose()
  const assign = () => {
    const group = options.find((option) => option.id === groupId && !option.isFull)
    if (!group) return
    dispatch({ type: 'UPDATE_TUS_KID', id: kid.id, patch: { groupId: group.id } })
    toast(`${kid.name} przypisany do grupy ${group.name}`)
    close()
  }

  return (
    <dialog
      className="quick-dialog tus-assignment-dialog"
      ref={dialogRef}
      aria-labelledby="tus-assignment-title"
      onCancel={(event) => { event.preventDefault(); close() }}
    >
      <div className="quick-dialog__head">
        <div>
          <div className="eyebrow">Szybki przydział</div>
          <h2 id="tus-assignment-title">Przypisz do grupy — {kid.name}</h2>
          <p>{kid.age == null ? 'Wiek nie został podany.' : `Wiek dziecka: ${kid.age} lat.`}</p>
        </div>
        <IconBtn name="close" label="Zamknij" onClick={close} />
      </div>

      <fieldset className="tus-assignment-options">
        <legend className="sr-only">Wybierz grupę</legend>
        {options.length === 0 ? (
          <EmptyState compact icon="group" title="Brak grup do wyboru" hint="Najpierw utwórz grupę TUS." />
        ) : options.map((group) => (
          <label className={`tus-assignment-option ${group.isFull ? 'is-disabled' : ''}`} key={group.id}>
            <input
              type="radio"
              name="tus-group"
              value={group.id}
              checked={groupId === group.id}
              disabled={group.isFull}
              onChange={(event) => setGroupId(event.target.value)}
            />
            <span className="tus-assignment-option__main">
              <strong>{group.name}</strong>
              <span>{group.age || tusAgeLabel(group.ageMin, group.ageMax) || 'Wiek do ustalenia'} · {group.memberCount}/{group.capacity}</span>
            </span>
            <span className="tus-assignment-option__status">
              <b className={group.ageMatch === false ? 'is-warning' : ''}>
                {tusAssignmentStatusLabel(group)}
              </b>
              {group.isFull && group.ageMatch === false ? <b className="is-warning">Poza przedziałem wiekowym</b> : null}
            </span>
          </label>
        ))}
      </fieldset>

      <div className="quick-dialog__actions">
        <Button disabled={!groupId} onClick={assign}>Przypisz do grupy</Button>
        <Button variant="ghost" onClick={close}>Anuluj</Button>
      </div>
    </dialog>
  )
}

function GroupCard({ centre, group, leaders, monthSummary, next, roster }) {
  const titleId = `tus-group-title-${group.id}`
  return (
    <article className="card card--lift gcard" data-reveal aria-labelledby={titleId}>
      <div className="gcard__head">
        <EntityLink
          route="tusGroup"
          params={{ id: group.id }}
          label={`Otwórz grupę — ${group.name}`}
          className="gcard__link"
        >
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <h2 className="gcard__name" id={titleId}>{group.name}</h2>
            <Pill tone="sky">{group.age || tusAgeLabel(group.ageMin, group.ageMax)}</Pill>
          </div>
          <Icon name="chevR" size={18} className="faint" />
        </EntityLink>
        <div className="gcard__meta">
          co tydzień · {WEEKDAY_SHORT[group.weekday]} {group.time} · {fmtMoney(group.fee)} / mies.
        </div>
      </div>
      <div className="gcard__leaders">
        {leaders.map((psychologist) => (
          <span className="row" style={{ gap: 7 }} key={psychologist.id}>
            <Avatar name={psychologist.name} color={psychologist.color} size={26} />
            <span className="muted">{psychologist.name.split(' ')[0]}</span>
          </span>
        ))}
      </div>
      <div className="gcard__stats">
        <span><b>{roster.length}/{group.capacity}</b> {kidsWord(roster.length)}</span>
        <span>najbliższe · <b>{next ? fmtDayMonth(next.date) : '—'}</b></span>
        <span>frekwencja · <b>{monthSummary.attendanceRate == null ? '—' : `${monthSummary.attendanceRate}%`}</b></span>
        {centre && monthSummary.dueCount > 0 && <Pill tone="amber">{monthSummary.dueCount} do opłacenia</Pill>}
      </div>
    </article>
  )
}

export function TusGroups() {
  const { state } = useApp()
  const { appMode, getViewState, patchViewState, role, openTusGroupForm, openTusKidForm } = useShell()
  if (appMode === 'app') return null
  const ref = useReveal()
  const searchRef = useRef(null)
  const centre = role.scope !== 'own'
  const groups = useMemo(() => sortTusGroups(tusGroupsForRole(state, role)), [role, state])
  const groupIds = useMemo(() => new Set(groups.map((group) => group.id)), [groups])
  const visibleKids = useMemo(
    () => centre
      ? state.tusKids
      : state.tusKids.filter((kid) => kid.groupId && groupIds.has(kid.groupId)),
    [centre, groupIds, state.tusKids]
  )
  const assignedKids = visibleKids.filter((kid) => kid.groupId && groupIds.has(kid.groupId))
  const waitingKids = centre ? sortTusByName(unassignedKids(state.tusKids)) : []
  const [initialQuery] = useState(() => {
    const saved = getViewState('tus', { query: '' })
    return typeof saved.query === 'string' ? saved.query : ''
  })
  const [query, setQuery] = useState(initialQuery)
  const [assignment, setAssignment] = useState(null)
  const results = useMemo(
    () => searchTusOverview({ groups, kids: visibleKids, query }),
    [groups, query, visibleKids]
  )
  const searching = query.trim().length > 0
  const ym = monthKey(new Date())
  const now = useMinuteNow()
  const nowIso = `${toISODate(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const psychOf = (id) => state.psychologists.find((psychologist) => psychologist.id === id)
  const groupOf = (id) => groups.find((group) => group.id === id)

  useEffect(() => {
    patchViewState('tus', { query })
  }, [patchViewState, query])

  const openAssignment = (kid, opener) => setAssignment({ ...kid, opener })

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Zajęcia grupowe</div>
          <h1 className="display view-head__title">Grupy <em>TUS</em></h1>
          <p className="view-head__sub">
            {groups.length} {plural(groups.length, 'grupa', 'grupy', 'grup')} ·{' '}
            {assignedKids.length} {plural(assignedKids.length, 'dziecko w grupie', 'dzieci w grupach', 'dzieci w grupach')}
            {centre ? ` · ${waitingKids.length} ${waitingKids.length === 1 ? 'oczekuje' : 'oczekują'} na przydział` : ''}.
          </p>
        </div>
        {centre && (
          <div className="view-head__actions">
            <Button variant="ghost" icon="plus" onClick={() => openTusKidForm()}>Dodaj dziecko</Button>
            <Button icon="plus" magnetic onClick={() => openTusGroupForm()}>Nowa grupa</Button>
          </div>
        )}
      </div>

      <div className="tus-overview-search" data-reveal>
        <SearchInput
          inputRef={searchRef}
          value={query}
          onChange={setQuery}
          placeholder="Dziecko, rodzic lub grupa…"
        />
      </div>

      {searching ? (
        <div className="tus-search-results" aria-label="Wyniki wyszukiwania TUS" data-reveal>
          <section aria-labelledby="tus-search-groups">
            <h2 className="card-title" id="tus-search-groups">Grupy</h2>
            <div className="card tus-result-list">
              {results.groups.length === 0 ? <p className="tus-result-empty">Brak pasujących grup.</p> : null}
              {results.groups.map((group) => (
                <EntityLink
                  key={group.id}
                  route="tusGroup"
                  params={{ id: group.id }}
                  label={`Otwórz grupę — ${group.name}`}
                  className="tus-result-row"
                >
                  <span>
                    <strong>{group.name}</strong>
                    <small>{group.age || tusAgeLabel(group.ageMin, group.ageMax)} · {kidsOfGroup(state.tusKids, group.id).length}/{group.capacity}</small>
                  </span>
                  <Icon name="chevR" size={17} />
                </EntityLink>
              ))}
            </div>
          </section>
          <section aria-labelledby="tus-search-people">
            <h2 className="card-title" id="tus-search-people">Dzieci i rodzice</h2>
            <div className="card tus-result-list">
              {results.kids.length === 0 ? <p className="tus-result-empty">Brak pasujących dzieci lub rodziców.</p> : null}
              {results.kids.map((kid) => {
                const group = groupOf(kid.groupId)
                const content = (
                  <>
                    <Avatar name={kid.name} size={34} />
                    <span>
                      <strong>{kid.name}</strong>
                      <small>{kid.parentName}{group ? ` · ${group.name}` : ' · oczekuje na przydział'}</small>
                    </span>
                    <Icon name="chevR" size={17} />
                  </>
                )
                return group ? (
                  <EntityLink
                    key={kid.id}
                    route="tusGroup"
                    params={{ id: group.id, focusKidId: kid.id }}
                    label={`Otwórz dziecko — ${kid.name}`}
                    className="tus-result-row"
                  >
                    {content}
                  </EntityLink>
                ) : centre ? (
                  <button
                    type="button"
                    key={kid.id}
                    className="tus-result-row"
                    aria-label={`Przypisz dziecko — ${kid.name}`}
                    onClick={(event) => openAssignment(kid, event.currentTarget)}
                  >
                    {content}
                  </button>
                ) : null
              })}
            </div>
          </section>
        </div>
      ) : (
        <>
          {groups.length === 0 && (
            <div className="card card--pad" data-reveal>
              <EmptyState
                icon="group"
                title={centre ? 'Nie ma jeszcze żadnej grupy' : 'Nie prowadzisz żadnej grupy TUS'}
                hint={centre
                  ? 'Utwórz pierwszą grupę wiekową, aby zapisywać dzieci i planować zajęcia.'
                  : 'Grupy przypisuje właścicielka centrum.'}
                action={centre ? <Button size="sm" icon="plus" onClick={() => openTusGroupForm()}>Nowa grupa</Button> : undefined}
              />
            </div>
          )}

          <div className="grid-2">
            {groups.map((group) => {
              const roster = kidsOfGroup(state.tusKids, group.id)
              const next = nextClassOf(state.tusClasses, group.id, nowIso)
              const monthSummary = tusMonthSummary(group, state.tusClasses, state.tusKids, state.tusPayments, ym, nowIso)
              const leaders = group.leaderIds.map(psychOf).filter(Boolean)
              return (
                <GroupCard
                  key={group.id}
                  centre={centre}
                  group={group}
                  leaders={leaders}
                  monthSummary={monthSummary}
                  next={next}
                  roster={roster}
                />
              )
            })}
          </div>

          {centre && waitingKids.length > 0 && (
            <section className="card card--pad tus-waiting" data-reveal style={{ marginTop: 24 }} aria-labelledby="tus-waiting-title">
              <h2 className="card-title" id="tus-waiting-title">Oczekują na przydział</h2>
              <p className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
                Dzieci zgłoszone do TUS, które nie mają jeszcze grupy.
              </p>
              <div className="stack" style={{ marginTop: 14, gap: 8 }}>
                {waitingKids.map((kid) => (
                  <div className="tus-waiting__row" key={kid.id}>
                    <span className="row" style={{ gap: 10 }}>
                      <Avatar name={kid.name} size={34} />
                      <span>
                        <strong>{kid.name}</strong>
                        <small>{kid.age != null ? `${kid.age} l. · ` : ''}{kid.parentName}</small>
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="soft"
                      aria-label={`Przypisz dziecko — ${kid.name}`}
                      onClick={(event) => openAssignment(kid, event.currentTarget)}
                    >
                      Przypisz
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {assignment ? (
        <AssignmentDialog
          fallbackRef={searchRef}
          groups={groups}
          kid={assignment}
          kids={state.tusKids}
          onClose={() => setAssignment(null)}
        />
      ) : null}
    </div>
  )
}
