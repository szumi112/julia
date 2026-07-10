import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { Avatar, Pill, Button, EmptyState } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { monthKey, toISODate, fmtDayMonth, fmtMoney, WEEKDAY_SHORT, plural } from '../format.js'
import { tusGroupsForRole, kidsOfGroup, unassignedKids, nextClassOf, tusMonthSummary } from '../tus.js'

export const kidsWord = (n) => plural(n, 'dziecko', 'dzieci', 'dzieci')

export function TusGroups() {
  const { state } = useApp()
  const { navigate, role, openTusGroupForm, openTusKidForm } = useShell()
  const ref = useReveal()
  const centre = role.scope !== 'own'
  const groups = tusGroupsForRole(state, role)
  const ym = monthKey(new Date())
  const todayIso = toISODate(new Date())
  const loose = unassignedKids(state.tusKids)
  const psychOf = (id) => state.psychologists.find((p) => p.id === id)

  return (
    <div ref={ref}>
      <div className="view-head" data-reveal>
        <div>
          <div className="eyebrow">Zajęcia grupowe</div>
          <h1 className="display view-head__title">Grupa <em>TUS</em></h1>
          <p className="view-head__sub">
            Trening umiejętności społecznych dla dzieci — osobna kategoria od codziennych sesji.
            Prowadzące wpisują temat zajęć i odhaczają obecność.
          </p>
        </div>
        {centre && (
          <div className="view-head__actions">
            <Button variant="ghost" icon="plus" onClick={() => openTusKidForm()}>Dodaj dziecko</Button>
            <Button icon="plus" magnetic onClick={() => openTusGroupForm()}>Nowa grupa</Button>
          </div>
        )}
      </div>

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
        {groups.map((g) => {
          const roster = kidsOfGroup(state.tusKids, g.id)
          const next = nextClassOf(state.tusClasses, g.id, todayIso)
          const m = tusMonthSummary(g, state.tusClasses, state.tusKids, state.tusPayments, ym, todayIso)
          const leaders = g.leaderIds.map(psychOf).filter(Boolean)
          return (
            <div
              className="card card--lift gcard"
              key={g.id}
              data-reveal
              role="button"
              tabIndex={0}
              onClick={() => navigate('tusGroup', { id: g.id })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  navigate('tusGroup', { id: g.id })
                }
              }}
            >
              <div className="row row--between" style={{ gap: 12 }}>
                <div>
                  <h2 className="gcard__name">{g.name}</h2>
                  <div className="gcard__meta">
                    co tydzień · {WEEKDAY_SHORT[g.weekday]} {g.time} · {fmtMoney(g.fee)} / mies.
                  </div>
                </div>
                <Icon name="chevR" size={18} className="faint" />
              </div>
              <div className="gcard__leaders">
                {leaders.map((p) => (
                  <span className="row" style={{ gap: 7 }} key={p.id}>
                    <Avatar name={p.name} color={p.color} size={26} />
                    <span className="muted">{p.name.split(' ')[0]}</span>
                  </span>
                ))}
              </div>
              <div className="gcard__stats">
                <span><b>{roster.length}</b> {kidsWord(roster.length)}</span>
                <span>najbliższe · <b>{next ? fmtDayMonth(next.date) : '—'}</b></span>
                <span>frekwencja · <b>{m.attendanceRate == null ? '—' : `${m.attendanceRate}%`}</b></span>
                {centre && m.dueCount > 0 && <Pill tone="gold">{m.dueCount} do opłacenia</Pill>}
              </div>
            </div>
          )
        })}
      </div>

      {centre && loose.length > 0 && (
        <div className="card card--pad" data-reveal style={{ marginTop: 24 }}>
          <h2 className="card-title">Bez grupy</h2>
          <p className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
            Zgłoszone dzieci czekające na przydział do grupy wiekowej.
          </p>
          <div className="stack" style={{ marginTop: 14, gap: 12 }}>
            {loose.map((k) => (
              <div className="row row--between" key={k.id}>
                <span className="row" style={{ gap: 10 }}>
                  <Avatar name={k.name} size={30} />
                  <span style={{ fontWeight: 600 }}>{k.name} <span className="faint" style={{ fontWeight: 400 }}>· {k.age} l.</span></span>
                </span>
                <Button size="sm" variant="soft" onClick={() => openTusKidForm({ kid: k })}>Przypisz</Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
