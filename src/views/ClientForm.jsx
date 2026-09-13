// Add/Edit client — slide-over drawer with validation and delete-with-confirm.
import { useEffect, useRef, useState } from 'react'
import { allocateDemoClientId, useApp, clientOutstanding, useClientMutationLock, useWorkspaceRefresh } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { clientsForRole } from '../workspace.js'
import { Button, Field, Segmented, IconBtn, DiscardConfirm, useDiscardGuard } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX } from '../anim.js'
import { toISODate, plural, fmtMoney, warsawDateTimeFromUtc } from '../format.js'
import { ApiError } from '../api.js'
import { validateClientInput, warsawDateTimeToUtc } from '../core-records.js'
import { canPerformAction } from '../capability-access.js'

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ClientDrawer({ opts, onClose }) {
  const { state, dispatch, toast, workspace } = useApp()
  const { locked: clientMutationLocked } = useClientMutationLock()
  const { appMode, capabilities, route, navigate, role, registerLeaveGuard } = useShell()
  const refreshWorkspace = useWorkspaceRefresh()
  const isApp = appMode === 'app'
  const editing = opts.client || null
  const today = warsawDateTimeFromUtc(new Date().toISOString()).date
  const initialAssignmentDate = isApp && editing?.assignmentStartsAt
    ? warsawDateTimeFromUtc(editing.assignmentStartsAt).date
    : editing?.since || today
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const availablePsychologists = state.psychologists.filter((psych) => (
    (!isApp || psych.status === 'active')
    && (role.scope !== 'own' || psych.id === role.psychId)
  ))
  const defaultPsych = editing?.psychId || opts.psychId || (role.scope === 'own' ? role.psychId : '')
    || (availablePsychologists.length === 1 ? availablePsychologists[0].id : '')

  const [form, setForm] = useState({
    name: editing?.name || '',
    age: editing?.age ?? '',
    psychId: defaultPsych,
    email: editing?.email || '',
    phone: editing?.phone || '',
    status: editing?.status || 'active',
    assignmentDate: initialAssignmentDate,
    familyOtherId: '',
    familyRole: editing?.familyRole || '',
    note: '',
  })
  const [errors, setErrors] = useState({})
  const [confirmDel, setConfirmDel] = useState(false)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const [initialForm] = useState(form)
  const discardGuard = useDiscardGuard(JSON.stringify(form) !== JSON.stringify(initialForm))
  const allowCreatedClientNavigation = useRef(false)
  const { close, forceClose, shake } = useDrawerFX(drawerRef, backRef, onClose, discardGuard.guard)
  useEffect(() => registerLeaveGuard(() => (
    allowCreatedClientNavigation.current ? false : discardGuard.check()
  )), [registerLeaveGuard, discardGuard.check])

  // the drawer may unlink while open — read the live record, not the snapshot
  const current = editing ? state.clients.find((c) => c.id === editing.id) || editing : null
  const familyMembers = !isApp && current?.familyId
    ? state.clients.filter((c) => c.familyId === current.familyId && c.id !== current.id)
    : []
  // therapists may link only within their own client list
  const linkables = clientsForRole(state, role).filter(
    (c) => c.id !== editing?.id && !familyMembers.some((m) => m.id === c.id)
  )
  const reassigned = isApp && Boolean(editing && form.psychId !== editing.psychId)
  const assignmentMax = editing && !reassigned ? initialAssignmentDate : today

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: null }))
    setSaveStatus('idle')
    setSaveError(null)
  }

  const focusFirstError = () => {
    shake()
    requestAnimationFrame(() =>
      drawerRef.current?.querySelector('.has-error input, .has-error select, .has-error textarea')?.focus()
    )
  }

  const appErrors = (payload) => {
    const errors = {
      name: form.name.trim() ? null : 'Podaj imię i nazwisko',
      age: null,
      psychId: form.psychId ? null : 'Wybierz specjalistkę',
      status: form.status ? null : 'Wybierz status klienta',
      assignmentDate: form.assignmentDate ? null : 'Podaj datę rozpoczęcia opieki',
      body: null,
    }
    try {
      validateClientInput(payload)
      return errors
    } catch (error) {
      const field = error instanceof TypeError ? error.message.split('/').at(-1) : 'body'
      if (field === 'name') errors.name ||= 'Podaj imię i nazwisko'
      else if (field === 'age') errors.age = 'Podaj wiek od 1 do 26 lat'
      else if (field === 'specialistId') errors.psychId ||= 'Wybierz specjalistkę'
      else if (field === 'status') errors.status ||= 'Wybierz status klienta'
      else if (field === 'assignmentStartsAt') errors.assignmentDate ||= 'Podaj prawidłową datę rozpoczęcia opieki'
      else errors.body = 'Sprawdź dane klienta'
      return errors
    }
  }

  const appPayload = () => {
    const assignmentStartsAt = reassigned
      ? null
      : editing && form.assignmentDate === initialAssignmentDate
        ? editing.assignmentStartsAt
        : warsawDateTimeToUtc(form.assignmentDate, '00:00')
    return {
      name: form.name.trim().normalize('NFC'),
      age: String(form.age).trim() === '' ? null : Number(form.age),
      status: form.status,
      specialistId: form.psychId,
      assignmentStartsAt,
    }
  }

  const assignmentDateError = () => {
    if (!form.assignmentDate) return 'Podaj datę rozpoczęcia opieki'
    if (form.assignmentDate > today) return 'Data rozpoczęcia opieki nie może być w przyszłości'
    if (editing && !reassigned && form.assignmentDate > initialAssignmentDate) {
      return 'Datę rozpoczęcia opieki można tylko cofnąć'
    }
    return null
  }

  const refreshAfterAppMutation = async (failureMessage) => {
    try {
      await refreshWorkspace(opts.workspaceRange)
    } catch {
      // The write has already succeeded, so this drawer must never offer it again.
      forceClose()
      toast(failureMessage, 'alert')
      return false
    }
    return true
  }

  const submitApp = async () => {
    if (saveStatus === 'saving' || clientMutationLocked
      || !canPerformAction(capabilities, editing ? 'client.edit' : 'client.create')
      || editing?.readOnly || editing?.status === 'archived') return
    let payload
    let nextErrors
    try {
      payload = appPayload()
      nextErrors = appErrors(payload)
    } catch {
      payload = null
      nextErrors = {
        name: form.name.trim() ? null : 'Podaj imię i nazwisko',
        psychId: form.psychId ? null : 'Wybierz specjalistkę',
        assignmentDate: 'Podaj prawidłową datę rozpoczęcia opieki',
      }
    }
    nextErrors.assignmentDate = assignmentDateError() || nextErrors.assignmentDate
    if (form.psychId && !availablePsychologists.some((psychologist) => psychologist.id === form.psychId)) {
      nextErrors.psychId = role.scope === 'own'
        ? 'Klient musi pozostać pod opieką aktywnej specjalistki'
        : 'Wybierz aktywną specjalistkę'
    }
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) {
      focusFirstError()
      return
    }
    setSaveStatus('saving')
    setSaveError(null)
    let createdClient = null
    try {
      createdClient = editing
        ? await workspace.editClient(editing.id, editing.version, payload)
        : await workspace.createClient(payload)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        forceClose()
        try {
          await refreshWorkspace(opts.workspaceRange)
          toast('Dane klienta zostały odświeżone', 'alert')
        } catch {
          toast('Nie udało się odświeżyć danych klienta', 'alert')
        }
        return
      }
      if (error instanceof ApiError && (error.code === 'CLIENT_ASSIGNMENT_CONFLICT'
        || (error.code === 'VALIDATION_FAILED' && error.details?.field === 'assignmentStartsAt'))) {
        setSaveStatus('error')
        setErrors({ assignmentDate: 'Nie można zapisać tej daty rozpoczęcia opieki' })
        focusFirstError()
        return
      }
      setSaveStatus('error')
      setSaveError('Nie udało się zapisać danych klienta.')
      return
    }
    if (!await refreshAfterAppMutation('Dane zapisano, ale nie udało się odświeżyć kartoteki.')) return
    if (editing) {
      forceClose()
      toast('Dane klienta zapisane')
      return
    }
    allowCreatedClientNavigation.current = true
    forceClose()
    navigate('client', { id: createdClient.id })
    setTimeout(() => toast('Nowy klient dodany. Otworzono kartę.'), 0)
  }

  const submit = (e) => {
    e?.preventDefault()
    if (isApp) return submitApp()
    const errs = {}
    if (!form.name.trim()) errs.name = 'Podaj imię i nazwisko'
    if (!form.psychId) errs.psychId = 'Wybierz specjalistkę'
    if (role.scope === 'own' && form.psychId !== role.psychId) {
      errs.psychId = 'Klient musi pozostać pod opieką aktywnej specjalistki'
    }
    if (form.email.trim() && !EMAIL_SHAPE.test(form.email.trim())) errs.email = 'Podaj poprawny adres e-mail'
    const dateError = assignmentDateError()
    if (dateError) errs.assignmentDate = dateError
    if (String(form.age).trim()) {
      const age = Number(form.age)
      if (!Number.isInteger(age) || age < 1 || age > 26) errs.age = 'Podaj wiek od 1 do 26 lat'
    }
    setErrors(errs)
    if (Object.keys(errs).length) {
      focusFirstError()
      return
    }
    const payload = {
      name: form.name.trim(),
      // dorośli (rodzice na konsultacji) zostają bez wieku
      age: String(form.age).trim() ? Number(form.age) : null,
      psychId: form.psychId,
      email: form.email.trim(),
      phone: form.phone.trim(),
      status: form.status,
      since: form.assignmentDate,
    }
    if (editing) {
      const patch = { ...payload }
      if (current?.familyId && !form.familyOtherId) patch.familyRole = form.familyRole || null
      dispatch({ type: 'UPDATE_CLIENT', id: editing.id, patch })
      if (form.familyOtherId) {
        dispatch({ type: 'LINK_FAMILY', clientId: editing.id, otherId: form.familyOtherId, role: form.familyRole || null })
      }
      toast('Dane klienta zapisane')
    } else {
      const note = form.note.trim()
      const createdClientId = allocateDemoClientId()
      dispatch({
        type: 'ADD_CLIENT',
        client: {
          id: createdClientId,
          ...payload,
          since: form.assignmentDate,
          notes: note ? [{ date: toISODate(new Date()), text: note }] : [],
        },
        familyLink: form.familyOtherId
          ? { otherId: form.familyOtherId, role: form.familyRole || null }
          : undefined,
      })
      allowCreatedClientNavigation.current = true
      forceClose()
      navigate('client', { id: createdClientId })
      setTimeout(() => toast('Nowy klient dodany. Otworzono kartę.'), 0)
      return
    }
    forceClose()
  }

  const sessionCount = editing ? state.sessions.filter((s) => s.clientId === editing.id).length : 0
  const debt = editing ? clientOutstanding(state.sessions, editing.id) : 0

  const remove = () => {
    if (isApp) return
    dispatch({ type: 'DELETE_CLIENT', id: editing.id })
    toast('Klient usunięty z kartoteki', 'close')
    if (route.name === 'client' && route.params?.id === editing.id) navigate('clients')
    forceClose()
  }

  const archive = async () => {
    if (!isApp || saveStatus === 'saving' || clientMutationLocked
      || !canPerformAction(capabilities, 'client.archive')
      || !editing || editing.readOnly || editing.status === 'archived') return
    setSaveStatus('saving')
    setSaveError(null)
    try {
      await workspace.archiveClient(editing.id, editing.version)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        forceClose()
        try {
          await refreshWorkspace(opts.workspaceRange)
          toast('Dane klienta zostały odświeżone', 'alert')
        } catch {
          toast('Nie udało się odświeżyć danych klienta', 'alert')
        }
        return
      }
      setSaveStatus('error')
      setSaveError('Nie udało się zarchiwizować klienta.')
      return
    }
    if (!await refreshAfterAppMutation('Klienta zarchiwizowano, ale nie udało się odświeżyć kartoteki.')) return
    toast('Klient zarchiwizowany', 'close')
    if (route.name === 'client' && route.params?.id === editing.id) navigate('clients')
    forceClose()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={editing ? 'Edycja klienta' : 'Nowy klient'}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">{editing ? 'Edycja klienta' : 'Nowy klient'}</h2>
            <p className="drawer__sub">
              {editing ? editing.name : 'Dodaj osobę do kartoteki centrum.'}
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Imię i nazwisko" error={errors.name}>
            <input
              name="client-name"
              autoComplete="off"
              className="input"
              value={form.name}
              placeholder="np. Zofia Mazur"
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          <div className="form-grid">
            <Field label="Specjalistka prowadząca" error={errors.psychId}>
              <select name="client-psych" autoComplete="off" className="select" value={form.psychId} onChange={(e) => set('psychId', e.target.value)}>
                <option value="">— wybierz —</option>
                {availablePsychologists.map((p) => (
                  <option key={p.id} value={p.id}>{p.title ? `${p.title} ` : ''}{p.name}</option>
                ))}
              </select>
            </Field>
            <Field
              label="Pod opieką od"
              error={errors.assignmentDate}
              hint={reassigned ? 'Nowe przypisanie zacznie się przy zapisie.' : undefined}
            >
              <input
                type="date"
                name="client-assignment-date"
                autoComplete="off"
                className="input"
                value={form.assignmentDate}
                max={assignmentMax}
                required
                disabled={reassigned}
                onChange={(e) => set('assignmentDate', e.target.value)}
              />
            </Field>
          </div>

          <Field label="Wiek" error={errors.age} hint="Zostaw puste dla osoby dorosłej.">
            <input
              type="number"
              min="1"
              max="26"
              step="1"
              inputMode="numeric"
              name="client-age"
              autoComplete="off"
              className="input"
              value={form.age}
              placeholder="np. 9"
              onChange={(e) => set('age', e.target.value)}
            />
          </Field>

          {!isApp && <div className="form-grid">
            <Field label="E-mail" error={errors.email} hint="Kontakt do rodzica lub opiekuna.">
              <input
                type="email"
                name="client-email"
                autoComplete="off"
                spellCheck={false}
                className="input"
                value={form.email}
                placeholder="np. rodzic@gmail.com"
                onChange={(e) => set('email', e.target.value)}
              />
            </Field>
            <Field label="Telefon">
              <input
                type="tel"
                name="client-phone"
                autoComplete="off"
                className="input"
                value={form.phone}
                placeholder="+48 600 000 000"
                onChange={(e) => set('phone', e.target.value)}
              />
            </Field>
          </div>}

          <Field
            label="Status"
            error={errors.status || errors.body}
            hint="Wstrzymani klienci pozostają w kartotece, ale nie planujesz im nowych sesji."
          >
            <Segmented
              ariaLabel="Status klienta"
              value={form.status}
              onChange={(v) => set('status', v)}
              options={[
                { value: 'active', label: 'Aktywny' },
                { value: 'paused', label: 'Wstrzymany' },
              ]}
            />
          </Field>

          {!isApp && <Field
            label="Rodzina"
            hint="Rodzic i dziecko bywają zapisani pod różnymi nazwiskami — powiązanie łączy ich karty."
          >
            <div className="stack" style={{ gap: 10, paddingTop: 2 }}>
              {familyMembers.length > 0 && (
                <div className="stack" style={{ gap: 6 }}>
                  {familyMembers.map((m) => (
                    <div key={m.id} style={{ fontSize: 14 }}>
                      {m.name}
                      <span className="faint"> · {m.familyRole || 'rodzina'}</span>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="link"
                    style={{ alignSelf: 'flex-start', fontSize: 13 }}
                    onClick={() => {
                      dispatch({ type: 'UNLINK_FAMILY', clientId: editing.id })
                      set('familyRole', '')
                      toast('Powiązanie rodzinne usunięte', 'close')
                    }}
                  >
                    Usuń powiązanie z rodziną
                  </button>
                </div>
              )}
              <select
                name="client-family"
                autoComplete="off"
                className="select"
                aria-label="Powiąż z klientem"
                value={form.familyOtherId}
                onChange={(e) => set('familyOtherId', e.target.value)}
              >
                <option value="">— powiąż z klientem —</option>
                {linkables.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </Field>}

          {!isApp && (current?.familyId || form.familyOtherId) && (
            <Field label="Rola w rodzinie">
              <Segmented
                ariaLabel="Rola w rodzinie"
                value={form.familyRole}
                onChange={(v) => set('familyRole', v)}
                options={[
                  { value: '', label: '—' },
                  { value: 'rodzic', label: 'Rodzic' },
                  { value: 'dziecko', label: 'Dziecko' },
                ]}
              />
            </Field>
          )}

          {!isApp && !editing && (
            <Field label="Pierwsza notatka (opcjonalnie)">
              <textarea
                name="client-note"
                autoComplete="off"
                className="textarea"
                value={form.note}
                placeholder="Powód zgłoszenia, pierwsze obserwacje…"
                onChange={(e) => set('note', e.target.value)}
              />
            </Field>
          )}

          {!isApp && editing && confirmDel && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} />
              <span>
                Usunięcie klienta <b>{editing.name}</b> jest nieodwracalne
                {sessionCount > 0 && (
                  <> i usunie też <b>{sessionCount} {plural(sessionCount, 'sesję', 'sesje', 'sesji')}</b> z historii i rozliczeń
                  {debt > 0 && <>, w tym nierozliczoną zaległość <b>{fmtMoney(debt)}</b></>}</>
                )}
                .
              </span>
            </div>
          )}
          {saveError && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} />
              <span>{saveError}</span>
            </div>
          )}
        </form>

        {discardGuard.confirming && (
          <DiscardConfirm onStay={discardGuard.hide} onDiscard={forceClose} />
        )}

        <div className="drawer__foot">
          {isApp && confirmDel ? (
            <>
              <Button variant="danger" onClick={archive} disabled={saveStatus === 'saving'}>
                Tak, archiwizuj klienta
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDel(false)} disabled={saveStatus === 'saving'}>Wróć</Button>
            </>
          ) : !isApp && confirmDel ? (
            <>
              <Button variant="danger" onClick={remove}>
                Tak, usuń klienta
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDel(false)}>Wróć</Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={submit} disabled={isApp && saveStatus === 'saving'}>
                {editing ? 'Zapisz zmiany' : 'Dodaj klienta'}
              </Button>
              {editing && isApp && (
                <Button variant="danger" onClick={() => setConfirmDel(true)} disabled={saveStatus === 'saving'}>
                  Archiwizuj klienta
                </Button>
              )}
              {editing && !isApp && (
                <Button variant="danger" onClick={() => setConfirmDel(true)}>
                  Usuń
                </Button>
              )}
              <Button variant="ghost" onClick={close} disabled={isApp && saveStatus === 'saving'}>Anuluj</Button>
            </>
          )}
        </div>
      </aside>
    </>
  )
}
