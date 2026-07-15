import { useEffect, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal } from '../anim.js'
import { useMinuteNow } from '../clock.js'
import { Avatar, Pill, Button, Check, IconBtn, EmptyState, Figure, Popover, PopItem } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import {
  fmtMoney, fmtDayMonth, fmtMonthYear, monthKey, addMonths, toISODate, parseISO, pad2,
  METHOD_LABELS, PAY_LABELS, WEEKDAY_SHORT,
} from '../format.js'
import {
  canLeadGroup, classHasStarted, kidsOfGroup, classesInMonth, tusMonths, attendanceRate,
  tusPaymentFor, tusMonthSummary,
} from '../tus.js'
import { kidsWord } from './Tus.jsx'

function MethodPick({ payment, onPick }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      ariaLabel="Forma płatności"
      trigger={
        <Pill
          tone="ink"
          onClick={() => setOpen(!open)}
          title="Zmień formę płatności"
          aria-label={`Forma płatności: ${payment.method ? METHOD_LABELS[payment.method] : 'nieoznaczona'}`}
        >
          {payment.method ? METHOD_LABELS[payment.method] : '—'}
          <Icon name="chevD" size={11} />
        </Pill>
      }
    >
      {Object.entries(METHOD_LABELS).map(([value, label]) => (
        <PopItem key={value} on={payment.method === value} onClick={() => { onPick(value); setOpen(false) }}>
          {label}
        </PopItem>
      ))}
    </Popover>
  )
}

function TusPayPill({ payment, onPatch }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      ariaLabel="Status opłaty"
      trigger={
        <Pill tone={payment.status === 'paid' ? 'sage' : 'error'} dot onClick={() => setOpen(!open)} title="Zmień status opłaty">
          {PAY_LABELS[payment.status]}
          <Icon name="chevD" size={11} />
        </Pill>
      }
    >
      <PopItem on={payment.status === 'paid'} onClick={() => { onPatch({ status: 'paid', paidDate: toISODate(new Date()) }); setOpen(false) }}>
        {PAY_LABELS.paid}
      </PopItem>
      <PopItem on={payment.status === 'unpaid'} onClick={() => { onPatch({ status: 'unpaid', paidDate: null }); setOpen(false) }}>
        {PAY_LABELS.unpaid}
      </PopItem>
    </Popover>
  )
}

export function TusGroupDetail({ params }) {
  const { state, dispatch, toast } = useApp()
  const { navigate, role, openTusGroupForm, openTusKidForm, openTusClassForm } = useShell()
  const ref = useReveal([params.id])
  const [ym, setYm] = useState(monthKey(new Date()))
  const now = useMinuteNow()
  const group = state.tusGroups.find((g) => g.id === params.id)
  const centre = role.scope !== 'own'

  useEffect(() => {
    if (!params.focusKidId) return
    const frame = requestAnimationFrame(() => {
      const row = ref.current?.querySelector(`[data-kid-id="${CSS.escape(params.focusKidId)}"]`)
      if (!row) return
      row.scrollIntoView({ block: 'center', behavior: 'auto' })
      row.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [params.focusKidId, params.id, ref])

  if (!group || !canLeadGroup(group, role)) {
    return (
      <EmptyState
        icon="group"
        title={group ? 'Ta grupa należy do innej prowadzącej' : 'Nie znaleziono grupy'}
        hint={group ? 'Widzisz tylko grupy, które prowadzisz.' : 'Być może grupa została usunięta.'}
        action={<Button size="sm" variant="soft" onClick={() => navigate('tus')}>Wróć do zajęć TUS</Button>}
      />
    )
  }

  const canEdit = canLeadGroup(group, role)
  const todayIso = toISODate(now)
  const nowIso = `${todayIso}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`
  const roster = kidsOfGroup(state.tusKids, group.id)
  const groupClasses = state.tusClasses.filter((c) => c.groupId === group.id)
  const months = tusMonths(groupClasses)
  const hasMonths = months.length > 0
  const monthClasses = classesInMonth(groupClasses, ym)
  const m = tusMonthSummary(group, state.tusClasses, state.tusKids, state.tusPayments, ym, nowIso)
  const leaders = group.leaderIds.map((id) => state.psychologists.find((p) => p.id === id)).filter(Boolean)
  const currentYm = monthKey(new Date())

  const patchPayment = (kidId, patch) => dispatch({ type: 'UPSERT_TUS_PAYMENT', kidId, ym, patch })
  const bookPayment = (kid) => {
    patchPayment(kid.id, { status: 'paid', paidDate: toISODate(new Date()) })
    toast(`Płatność zaksięgowana — ${kid.parentName}`)
  }

  return (
    <div ref={ref}>
      <button className="link row" style={{ gap: 7, marginBottom: 20 }} onClick={() => navigate('tus')} data-reveal>
        <Icon name="arrowL" size={16} /> Wróć do zajęć TUS
      </button>

      <div className="id-band" data-reveal style={{ '--band-color': leaders[0]?.color || 'var(--rose-deep)' }}>
        <Avatar name={group.name.replace('Grupa ', '')} color={leaders[0]?.color} size={64} />
        <div className="id-band__main">
          <h1 className="display id-band__name">{group.name}</h1>
          <div className="id-band__sub id-band__leaders">
            <span>{leaders.length === 1 ? 'prowadzi' : 'prowadzą'}</span>
            {leaders.map((p) => (
              <span className="row" key={p.id}>
                <Avatar name={p.name} color={p.color} size={24} />
                <span>{p.name}</span>
              </span>
            ))}
          </div>
          <div className="id-band__meta">
            <span><Icon name="calendar" size={14} /> co tydzień · {WEEKDAY_SHORT[group.weekday]} {group.time}</span>
            <span><Icon name="clients" size={14} /> {roster.length} {kidsWord(roster.length)}</span>
            <span><Icon name="payments" size={14} /> {fmtMoney(group.fee)} / mies.</span>
          </div>
          <div className="id-band__pills">
            <Pill tone="mauve">{group.age}</Pill>
          </div>
        </div>
        <div className="id-band__actions">
          {centre && <Button variant="ghost" icon="edit" onClick={() => openTusGroupForm({ group })}>Edytuj grupę</Button>}
          {centre && <Button variant="ghost" icon="plus" onClick={() => openTusKidForm({ groupId: group.id })}>Dodaj dziecko</Button>}
          {canEdit && <Button icon="plus" onClick={() => openTusClassForm({ groupId: group.id })}>Dodaj zajęcia</Button>}
        </div>
      </div>

      <div className="row row--between" data-reveal style={{ marginTop: 4, marginBottom: 2 }}>
        <div className="eyebrow">{fmtMonthYear(ym)} · {group.name}</div>
        <div className="row" style={{ gap: 10 }}>
          {ym !== currentYm && months.includes(currentYm) && (
            <Button variant="ghost" size="sm" onClick={() => setYm(currentYm)}>Bieżący miesiąc</Button>
          )}
          <div className="month-nav">
            <IconBtn name="chevL" label="Poprzedni miesiąc" disabled={!hasMonths || ym <= months[0]} onClick={() => setYm(addMonths(ym, -1))} />
            <span className="month-nav__label">{fmtMonthYear(ym)}</span>
            <IconBtn name="chevR" label="Następny miesiąc" disabled={!hasMonths || ym >= months[months.length - 1]} onClick={() => setYm(addMonths(ym, 1))} />
          </div>
        </div>
      </div>

      <div className="figures" role="group" aria-label={`Podsumowanie grupy — ${fmtMonthYear(ym)}`}>
        <Figure label="Zajęcia odbyte" value={m.heldCount} suffix={`/${m.classCount}`} />
        <Figure
          label="Frekwencja"
          value={m.attendanceRate ?? 0}
          fmt={(v) => (m.attendanceRate == null ? '—' : `${Math.round(v)}%`)}
        />
        {centre && (
          <Figure
            label="Opłacone"
            value={m.paidCount}
            suffix={`/${roster.length}`}
            gold={m.dueCount > 0}
          />
        )}
      </div>

      <div className="stack" style={{ marginTop: 4 }}>
        <div className="card" data-reveal style={{ overflow: 'hidden' }}>
          <div className="row row--between" style={{ padding: '20px 24px 0' }}>
            <h2 className="card-title" id="tus-attendance">Obecność · {fmtMonthYear(ym)}</h2>
            {!canEdit && <span className="faint" style={{ fontSize: 13 }}>tylko podgląd</span>}
          </div>
          {roster.length === 0 ? (
            <div style={{ padding: '8px 24px 24px' }}>
              <EmptyState
                compact
                icon="group"
                title="W tej grupie nie ma jeszcze dzieci"
                action={centre ? <Button size="sm" variant="soft" icon="plus" onClick={() => openTusKidForm({ groupId: group.id })}>Dodaj dziecko</Button> : undefined}
              />
            </div>
          ) : (
            <div className="table-scroll" style={{ marginTop: 8 }}>
              <table className="table att-table" aria-labelledby="tus-attendance">
                <thead>
                  <tr>
                    <th>Zajęcia</th>
                    {roster.map((k) => (
                      <th className="att-col" key={k.id} aria-label={k.name}>
                        <span title={k.name}>
                          <Avatar name={k.name} size={24} />
                          {k.name.split(' ')[0]}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {monthClasses.length === 0 && (
                    <tr>
                      <td colSpan={roster.length + 1}>
                        <EmptyState compact icon="calendar" title="Brak zajęć w tym miesiącu" hint="Dodaj zajęcia lub przejdź do innego miesiąca." />
                      </td>
                    </tr>
                  )}
                  {monthClasses.map((c) => {
                    const future = !classHasStarted(c, nowIso)
                    return (
                      <tr key={c.id}>
                        <td>
                          {canEdit ? (
                            <button className="link tus-class-link" onClick={() => openTusClassForm({ cls: c })} title="Edytuj lub przenieś zajęcia">
                              <span><b>{fmtDayMonth(c.date)}</b> · {WEEKDAY_SHORT[parseISO(c.date).getDay()]} · {c.time}</span>
                              <span className={c.topic ? 'muted' : 'faint'}>
                                {c.topic || (future ? 'zaplanowane' : 'temat do uzupełnienia')}
                              </span>
                            </button>
                          ) : (
                            <span className="tus-class-link">
                              <span><b>{fmtDayMonth(c.date)}</b> · {WEEKDAY_SHORT[parseISO(c.date).getDay()]} · {c.time}</span>
                              <span className={c.topic ? 'muted' : 'faint'}>
                                {c.topic || (future ? 'zaplanowane' : 'temat do uzupełnienia')}
                              </span>
                            </span>
                          )}
                        </td>
                        {roster.map((k) => (
                          <td className="att-cell" key={k.id}>
                            <button
                              className="att"
                              aria-pressed={!!c.attendance[k.id]}
                              aria-label={`${k.name} — ${fmtDayMonth(c.date)}`}
                              title={future ? 'Zajęcia jeszcze się nie odbyły' : `${k.name} — obecność`}
                              disabled={future || !canEdit}
                              onClick={() => dispatch({ type: 'SET_TUS_ATTENDANCE', classId: c.id, kidId: k.id, present: !c.attendance[k.id] })}
                            >
                              {c.attendance[k.id] ? <Icon name="check" size={13} /> : '–'}
                            </button>
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
                {monthClasses.length > 0 && (
                  <tfoot>
                    <tr>
                      <td>Frekwencja</td>
                      {roster.map((k) => {
                        const rate = attendanceRate(monthClasses, k.id)
                        return <td className="att-cell num-cell" key={k.id}>{rate == null ? '—' : `${rate}%`}</td>
                      })}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </div>

        {centre && roster.length > 0 && (
          <div className="card" data-reveal style={{ overflow: 'hidden' }}>
            <div className="row row--between" style={{ padding: '20px 24px 0' }}>
              <h2 className="card-title">Płatności · {fmtMonthYear(ym)}</h2>
              <span className="faint" style={{ fontSize: 13 }}>{fmtMoney(group.fee)} / dziecko / mies.</span>
            </div>
            <div className="table-scroll" style={{ marginTop: 8 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Dziecko</th>
                    <th>Rodzic (płatnik)</th>
                    <th className="right">Kwota</th>
                    <th>Forma</th>
                    <th>Faktura</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((k) => {
                    const p = tusPaymentFor(state.tusPayments, k.id, ym)
                    const due = p.status !== 'paid'
                    return (
                      <tr key={k.id} className={due ? 'is-due' : ''}>
                        <td>
                          <span className="row" style={{ gap: 10 }}>
                            <Avatar name={k.name} size={30} />
                            <span style={{ fontWeight: 600 }}>{k.name}</span>
                          </span>
                        </td>
                        <td>
                          <div>{k.parentName}</div>
                          {p.note && <div className="faint" style={{ fontSize: 12 }}>{p.note}</div>}
                        </td>
                        <td className="right num-cell">{fmtMoney(p.amount ?? group.fee)}</td>
                        <td><MethodPick payment={p} onPick={(method) => patchPayment(k.id, { method })} /></td>
                        <td>
                          <Check checked={p.invoice} onChange={(invoice) => patchPayment(k.id, { invoice })}>
                            <span className="sr-only">Faktura — {k.parentName}</span>
                          </Check>
                        </td>
                        <td><TusPayPill payment={p} onPatch={(patch) => patchPayment(k.id, patch)} /></td>
                        <td className="right">
                          {due ? (
                            <Button variant="soft" size="sm" title="Oznacz miesiąc jako opłacony" onClick={() => bookPayment(k)}>Zaksięguj</Button>
                          ) : (
                            <Icon name="check" size={16} style={{ color: 'var(--sage-deep)' }} />
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {roster.length > 0 && (
          <div className="card card--pad" data-reveal>
            <h2 className="card-title">Dzieci</h2>
            <table className="table table--cards" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Dziecko</th>
                  <th>Rodzic</th>
                  <th>Regulamin</th>
                  <th className="right">Frekwencja</th>
                  {centre && <th></th>}
                </tr>
              </thead>
              <tbody>
                {roster.map((k) => {
                  const rate = attendanceRate(groupClasses, k.id)
                  return (
                    <tr
                      key={k.id}
                      data-kid-id={k.id}
                      className={params.focusKidId === k.id ? 'tus-kid-row is-highlighted' : 'tus-kid-row'}
                      tabIndex={params.focusKidId === k.id ? -1 : undefined}
                      aria-label={params.focusKidId === k.id ? `Wybrane dziecko — ${k.name}` : undefined}
                    >
                      <td>
                        <span className="row" style={{ gap: 10 }}>
                          <Avatar name={k.name} size={32} />
                          {k.clientId ? (
                            <button
                              type="button"
                              className="link tus-client-link"
                              aria-label={`Otwórz kartę klienta: ${k.name}`}
                              onClick={() => navigate('client', { id: k.clientId })}
                            >
                              <span>{k.name}</span>
                              {k.age != null ? <span className="faint">· {k.age} l.</span> : null}
                            </button>
                          ) : (
                            <span style={{ fontWeight: 600 }}>
                              {k.name}
                              {k.age != null ? <span className="faint" style={{ fontWeight: 400 }}> · {k.age} l.</span> : null}
                            </span>
                          )}
                        </span>
                      </td>
                      <td data-th="Rodzic">
                        <div>{k.parentName}</div>
                        <div className="faint" style={{ fontSize: 12.5 }}>{k.parentPhone}</div>
                      </td>
                      <td data-th="Regulamin">
                        {centre ? (
                          <Check
                            checked={k.regulationsSigned}
                            onChange={(regulationsSigned) => dispatch({ type: 'UPDATE_TUS_KID', id: k.id, patch: { regulationsSigned } })}
                          >
                            Podpisany
                          </Check>
                        ) : (
                          <Pill tone={k.regulationsSigned ? 'sage' : 'gold'} dot>
                            {k.regulationsSigned ? 'Podpisany' : 'Brak'}
                          </Pill>
                        )}
                      </td>
                      <td className="right num-cell" data-th="Frekwencja">{rate == null ? '—' : `${rate}%`}</td>
                      {centre && (
                        <td className="right td--actions">
                          <IconBtn name="edit" label={`Edytuj profil: ${k.name}`} onClick={() => openTusKidForm({ kid: k })} />
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
