import { useEffect, useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useDrawerFX } from '../anim.js'
import { Button, DiscardConfirm, Field, IconBtn, useDiscardGuard } from '../ui.jsx'
import { Icon } from '../icons.jsx'

const staleAuthority = (error) => ['SESSION_AUTHORITY_STALE', 'WORKSPACE_AUTHORITY_STALE']
  .includes(error?.code)

export function ActivityGroupDrawer({ opts, onClose }) {
  const { toast, workspace } = useApp()
  const { registerLeaveGuard } = useShell()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const editing = opts.group ?? null
  const [label, setLabel] = useState(editing?.label ?? '')
  const [details, setDetails] = useState(editing?.details ?? '')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const english = (editing?.programId ?? opts.programId) === 'apg_english'
  const initial = JSON.stringify({ label: editing?.label ?? '', details: editing?.details ?? '' })
  const dirty = JSON.stringify({ label, details }) !== initial
  const discard = useDiscardGuard(dirty)
  const { close, forceClose, shake } = useDrawerFX(
    drawerRef, backRef, onClose, discard.guard,
  )
  useEffect(() => registerLeaveGuard(discard.check), [discard.check, registerLeaveGuard])

  const submit = async (event) => {
    event?.preventDefault()
    const cleanLabel = label.trim().replace(/\s+/gu, ' ')
    const cleanDetails = details.trim().replace(/\s+/gu, ' ')
    if (!cleanLabel) {
      setError('Podaj nazwę grupy')
      shake()
      return
    }
    if (saving) return
    setSaving(true)
    setError(null)
    const reconciliation = { from: opts.month, to: opts.month }
    try {
      if (editing) {
        await workspace.activities.editGroup(editing.id, {
          expectedVersion: editing.version,
          label: cleanLabel,
          details: cleanDetails || null,
          status: editing.status,
          leaderSpecialistIds: opts.leaderSpecialistIds ?? [],
        }, reconciliation)
      } else {
        await workspace.activities.createGroup({
          programId: opts.programId,
          label: cleanLabel,
          details: cleanDetails || null,
          leaderSpecialistIds: opts.leaderSpecialistIds ?? [],
        }, reconciliation)
      }
    } catch (submitError) {
      if (staleAuthority(submitError)) return
      if (submitError?.code === 'VERSION_CONFLICT') {
        try { await workspace.activities.loadWindow(reconciliation) } catch { /* Keep draft open. */ }
      }
      setError(submitError?.code === 'VERSION_CONFLICT'
        ? 'Grupa zmieniła się w innym oknie. Sprawdź odświeżone dane przed ponowieniem.'
        : 'Nie udało się zapisać grupy. Spróbuj ponownie.')
      setSaving(false)
      return
    }
    toast(editing ? 'Grupa została zapisana' : 'Nowa grupa została utworzona')
    forceClose()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside
        className="drawer activity-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={editing
          ? english ? 'Edytuj grupę angielskiego' : 'Edytuj grupę TUS'
          : english ? 'Nowa grupa angielskiego' : 'Nowa grupa TUS'}
      >
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Edytuj grupę' : 'Nowa grupa'}</h2>
            <p className="drawer__sub">Zapisujemy wyłącznie potwierdzoną nazwę i opis.</p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>
        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Nazwa grupy" error={!label.trim() && error ? error : null}>
            <input className="input" value={label} maxLength={160} onChange={(event) => {
              setLabel(event.target.value)
              setError(null)
            }} />
          </Field>
          <Field label="Opis" hint="Opcjonalny; bez harmonogramu, wieku i opłat domyślnych.">
            <textarea className="textarea" value={details} maxLength={2000} onChange={(event) => setDetails(event.target.value)} />
          </Field>
          {error && label.trim() && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} /> <span>{error}</span>
            </div>
          )}
        </form>
        {discard.confirming && <DiscardConfirm onStay={discard.hide} onDiscard={forceClose} />}
        <div className="drawer__foot">
          <Button onClick={submit} disabled={saving}>{editing ? 'Zapisz grupę' : 'Utwórz grupę'}</Button>
          <Button variant="ghost" onClick={close}>Anuluj</Button>
        </div>
      </aside>
    </>
  )
}

export function ActivityParticipantDrawer({ opts, onClose }) {
  const { toast, workspace } = useApp()
  const { registerLeaveGuard } = useShell()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const editing = opts.participant ?? null
  const [name, setName] = useState(editing?.name ?? '')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const discard = useDiscardGuard(name !== (editing?.name ?? ''))
  const { close, forceClose, shake } = useDrawerFX(
    drawerRef, backRef, onClose, discard.guard,
  )
  useEffect(() => registerLeaveGuard(discard.check), [discard.check, registerLeaveGuard])

  const submit = async (event) => {
    event?.preventDefault()
    const cleanName = name.trim().replace(/\s+/gu, ' ')
    if (!cleanName) {
      setError('Podaj imię i nazwisko')
      shake()
      return
    }
    if (saving) return
    setSaving(true)
    setError(null)
    const reconciliation = { from: opts.month, to: opts.month }
    try {
      if (editing) {
        await workspace.activities.editParticipant(editing.id, {
          expectedVersion: editing.version,
          name: cleanName,
          clientId: editing.clientId,
          historicalClientId: editing.historicalClientId,
          status: editing.status,
        }, reconciliation)
      } else {
        await workspace.activities.createParticipant({
          programId: opts.programId,
          name: cleanName,
          clientId: null,
          historicalClientId: null,
        }, reconciliation)
      }
    } catch (submitError) {
      if (staleAuthority(submitError)) return
      if (submitError?.code === 'VERSION_CONFLICT') {
        try { await workspace.activities.loadWindow(reconciliation) } catch { /* Keep draft open. */ }
      }
      setError(submitError?.code === 'VERSION_CONFLICT'
        ? 'Uczestnik zmienił się w innym oknie. Sprawdź odświeżone dane przed ponowieniem.'
        : 'Nie udało się zapisać uczestnika. Spróbuj ponownie.')
      setSaving(false)
      return
    }
    toast(editing ? 'Uczestnik został zapisany' : 'Uczestnik został utworzony')
    forceClose()
  }

  const english = opts.programId === 'apg_english'
  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside
        className="drawer activity-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edytuj uczestnika' : english ? 'Nowy uczestnik angielskiego' : 'Nowy uczestnik TUS'}
      >
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Edytuj uczestnika' : 'Nowy uczestnik'}</h2>
            <p className="drawer__sub">Bez domyślnych danych kontaktowych, wieku i opłat.</p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>
        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Imię i nazwisko" error={error}>
            <input className="input" value={name} maxLength={160} onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }} />
          </Field>
        </form>
        {discard.confirming && <DiscardConfirm onStay={discard.hide} onDiscard={forceClose} />}
        <div className="drawer__foot">
          <Button onClick={submit} disabled={saving}>{editing ? 'Zapisz uczestnika' : 'Utwórz uczestnika'}</Button>
          <Button variant="ghost" onClick={close}>Anuluj</Button>
        </div>
      </aside>
    </>
  )
}

export function ActivityMembershipDrawer({ opts, onClose }) {
  const { toast, workspace } = useApp()
  const { registerLeaveGuard } = useShell()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const editing = opts.membership ?? null
  const [participantId, setParticipantId] = useState(editing?.participantId ?? '')
  const [startsOn, setStartsOn] = useState(editing?.startsOn ?? `${opts.month}-01`)
  const [endsOn, setEndsOn] = useState(editing?.endsOn ?? '')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const initial = JSON.stringify({
    participantId: editing?.participantId ?? '',
    startsOn: editing?.startsOn ?? `${opts.month}-01`, endsOn: editing?.endsOn ?? '',
  })
  const dirty = JSON.stringify({ participantId, startsOn, endsOn }) !== initial
  const discard = useDiscardGuard(dirty)
  const { close, forceClose, shake } = useDrawerFX(
    drawerRef, backRef, onClose, discard.guard,
  )
  useEffect(() => registerLeaveGuard(discard.check), [discard.check, registerLeaveGuard])

  const submit = async (event) => {
    event?.preventDefault()
    if (!participantId || !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)
      || (endsOn && endsOn < startsOn)) {
      setError('Wybierz uczestnika i poprawny zakres dat')
      shake()
      return
    }
    if (saving) return
    setSaving(true)
    setError(null)
    const reconciliation = { from: opts.month, to: opts.month }
    try {
      if (editing) {
        await workspace.activities.editMembership(editing.id, {
          expectedVersion: editing.version,
          startsOn,
          endsOn: endsOn || null,
          status: editing.status,
        }, reconciliation)
      } else {
        await workspace.activities.createMembership({
          participantId, groupId: opts.groupId, startsOn, endsOn: endsOn || null,
        }, reconciliation)
      }
    } catch (submitError) {
      if (staleAuthority(submitError)) return
      if (submitError?.code === 'VERSION_CONFLICT') {
        try { await workspace.activities.loadWindow(reconciliation) } catch { /* Keep draft open. */ }
      }
      setError(submitError?.code === 'VERSION_CONFLICT'
        ? 'Przypisanie zmieniło się w innym oknie. Sprawdź odświeżone dane przed ponowieniem.'
        : 'Nie udało się zapisać przypisania. Spróbuj ponownie.')
      setSaving(false)
      return
    }
    toast(editing ? 'Przypisanie zostało zapisane' : 'Uczestnik został przypisany do grupy')
    forceClose()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside
        className="drawer activity-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edytuj przypisanie do grupy' : 'Nowe przypisanie do grupy'}
      >
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Edytuj przypisanie' : 'Nowe przypisanie'}</h2>
            <p className="drawer__sub">Zakres dat jest zapisywany jako jawny fakt członkostwa.</p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>
        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Uczestnik">
            <select className="select" value={participantId} disabled={Boolean(editing)} onChange={(event) => setParticipantId(event.target.value)}>
              <option value="">— wybierz uczestnika —</option>
              {opts.participants.map((participant) => (
                <option key={participant.id} value={participant.id}>{participant.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Data rozpoczęcia">
            <input className="input" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
          </Field>
          <Field label="Data zakończenia" hint="Opcjonalnie.">
            <input className="input" type="date" value={endsOn} min={startsOn} onChange={(event) => setEndsOn(event.target.value)} />
          </Field>
          {error && <div className="form-warn form-warn--error" role="alert"><Icon name="alert" size={15} /> <span>{error}</span></div>}
        </form>
        {discard.confirming && <DiscardConfirm onStay={discard.hide} onDiscard={forceClose} />}
        <div className="drawer__foot">
          <Button onClick={submit} disabled={saving}>{editing ? 'Zapisz przypisanie' : 'Dodaj przypisanie'}</Button>
          <Button variant="ghost" onClick={close}>Anuluj</Button>
        </div>
      </aside>
    </>
  )
}

export function ActivityClassDrawer({ opts, onClose }) {
  const { toast, workspace } = useApp()
  const { registerLeaveGuard } = useShell()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const editing = opts.activityClass ?? null
  const [date, setDate] = useState(editing?.date ?? `${opts.month}-01`)
  const [time, setTime] = useState(editing?.time ?? '')
  const [duration, setDuration] = useState(editing?.durationMinutes ?? '')
  const [topic, setTopic] = useState(editing?.topic ?? '')
  const [status, setStatus] = useState(editing?.status ?? 'scheduled')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [initial] = useState(() => JSON.stringify({ date, time, duration, topic, status }))
  const current = JSON.stringify({ date, time, duration, topic, status })
  const discard = useDiscardGuard(current !== initial)
  const { close, forceClose, shake } = useDrawerFX(
    drawerRef, backRef, onClose, discard.guard,
  )
  useEffect(() => registerLeaveGuard(discard.check), [discard.check, registerLeaveGuard])

  const submit = async (event) => {
    event?.preventDefault()
    const durationMinutes = duration === '' ? null : Number(duration)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !(durationMinutes === null || (Number.isInteger(durationMinutes) && durationMinutes > 0))) {
      setError('Podaj poprawną datę i czas trwania')
      shake()
      return
    }
    if (saving) return
    setSaving(true)
    setError(null)
    const fields = {
      date,
      time: time || null,
      durationMinutes,
      topic: topic.trim().replace(/\s+/gu, ' ') || null,
      status,
    }
    const reconciliation = { from: opts.month, to: opts.month }
    try {
      if (editing) {
        await workspace.activities.editClass(editing.id, {
          expectedVersion: editing.version, ...fields,
        }, reconciliation)
      } else {
        await workspace.activities.createClass({ groupId: opts.groupId, ...fields }, reconciliation)
      }
    } catch (submitError) {
      if (staleAuthority(submitError)) return
      if (submitError?.code === 'VERSION_CONFLICT') {
        try { await workspace.activities.loadWindow(reconciliation) } catch { /* Keep draft open. */ }
      }
      setError(submitError?.code === 'VERSION_CONFLICT'
        ? 'Zajęcia zmieniły się w innym oknie. Sprawdź odświeżone dane przed ponowieniem.'
        : 'Nie udało się zapisać zajęć. Spróbuj ponownie.')
      setSaving(false)
      return
    }
    toast(editing ? 'Zajęcia zostały zapisane' : 'Zajęcia zostały dodane')
    forceClose()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer activity-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={editing ? 'Edytuj zajęcia TUS' : 'Nowe zajęcia TUS'}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Edytuj zajęcia' : 'Nowe zajęcia'}</h2>
            <p className="drawer__sub">Pojedynczy termin; bez tworzenia cyklu.</p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>
        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Data zajęć"><input className="input" type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field>
          <Field label="Godzina" hint="Opcjonalnie."><input className="input" type="time" value={time} onChange={(event) => setTime(event.target.value)} /></Field>
          <Field label="Czas trwania w minutach" hint="Opcjonalnie."><input className="input" type="number" min="1" max="1440" value={duration} onChange={(event) => setDuration(event.target.value)} /></Field>
          <Field label="Temat" hint="Opcjonalnie."><textarea className="textarea" maxLength={1000} value={topic} onChange={(event) => setTopic(event.target.value)} /></Field>
          <Field label="Status"><select className="select" value={status} onChange={(event) => setStatus(event.target.value)}><option value="scheduled">Zaplanowane</option><option value="completed">Odbyte</option><option value="cancelled">Odwołane</option></select></Field>
          {error && <div className="form-warn form-warn--error" role="alert"><Icon name="alert" size={15} /> <span>{error}</span></div>}
        </form>
        {discard.confirming && <DiscardConfirm onStay={discard.hide} onDiscard={forceClose} />}
        <div className="drawer__foot"><Button onClick={submit} disabled={saving}>{editing ? 'Zapisz zajęcia' : 'Dodaj zajęcia'}</Button><Button variant="ghost" onClick={close}>Anuluj</Button></div>
      </aside>
    </>
  )
}
