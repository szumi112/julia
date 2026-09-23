// Add/Edit client — slide-over drawer with validation and delete-with-confirm.
import { useEffect, useRef, useState } from 'react'
import { allocateDemoClientId, useApp, clientOutstanding, useClientMutationLock, useWorkspaceRefresh } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { clientsForRole } from '../workspace.js'
import { Button, Check, Field, Segmented, IconBtn, DiscardConfirm, useDiscardGuard } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX } from '../anim.js'
import { toISODate, plural, fmtMoney, warsawDateTimeFromUtc } from '../format.js'
import { ApiError } from '../api.js'
import { assertClientContactFields, validateClientInput, warsawDateTimeToUtc } from '../core-records.js'
import { canPerformAction } from '../capability-access.js'
import { conflictCopy, loadFailureCopy, saveFailureCopy } from '../save-failure-copy.js'
import { hasActivePanelAccess, isAssignableSpecialist, NO_PANEL_ACCESS_COPY } from '../specialist-eligibility.js'

const PARENTAL_RIGHTS_OPTIONS = [
  { value: '', label: 'Nie ustalono' },
  { value: 'both', label: 'Tak' },
  { value: 'not_both', label: 'Nie' },
]
const AGE_ERROR = 'Wiek wpisujemy dzieciom i młodzieży (1-26 lat). Dorosłej osobie zostaw to pole puste.'
const ARCHIVE_BLOCKED_COPY = 'Ten klient ma zaplanowane sesje. Odwołaj je, zanim zarchiwizujesz klienta.'

export function ClientDrawer({ opts, onClose }) {
  const { state, dispatch, toast, workspace } = useApp()
  const { locked: clientMutationLocked } = useClientMutationLock()
  const { appMode, capabilities, route, navigate, role, registerLeaveGuard } = useShell()
  const refreshWorkspace = useWorkspaceRefresh()
  const isApp = appMode === 'app'
  // The record whose version the next save sends. It changes only when the
  // user explicitly reloads the latest data after a version conflict.
  const [editing, setEditing] = useState(opts.client || null)
  const today = warsawDateTimeFromUtc(new Date().toISOString()).date
  const assignmentDateOf = (record) => isApp && record?.assignmentStartsAt
    ? warsawDateTimeFromUtc(record.assignmentStartsAt).date
    : record?.since || today
  const initialAssignmentDate = assignmentDateOf(editing)
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const availablePsychologists = state.psychologists.filter((psych) => (
    (!isApp || isAssignableSpecialist(psych))
    && (role.scope !== 'own' || psych.id === role.psychId)
  ))
  const defaultPsych = editing?.psychId || opts.psychId || (role.scope === 'own' ? role.psychId : '')
    || (availablePsychologists.length === 1 ? availablePsychologists[0].id : '')

  const formFrom = (record, psychId) => ({
    name: record?.name || '',
    age: record?.age ?? '',
    psychId,
    email: record?.guardianEmail ?? record?.email ?? '',
    phone: record?.guardianPhone ?? record?.phone ?? '',
    receptionNotes: record?.receptionNotes || '',
    intakeReason: record?.intakeReason || '',
    guardianClientId: record?.guardianClientId || '',
    secondGuardianClientId: record?.secondGuardianClientId || '',
    parentalRights: record?.parentalRights || '',
    therapyConsent: record?.therapyConsent === 'signed',
    status: record?.status || 'active',
    assignmentDate: assignmentDateOf(record),
    familyOtherId: '',
    familyRole: record?.familyRole || '',
    note: '',
  })
  const [form, setForm] = useState(() => formFrom(editing, defaultPsych))
  const [errors, setErrors] = useState({})
  const [confirmDel, setConfirmDel] = useState(false)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const [conflict, setConflict] = useState(false)
  const [reloadStatus, setReloadStatus] = useState('idle')
  const [initialForm, setInitialForm] = useState(form)
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
  // A child's parents who are clients too: adults (no age) the user can see,
  // listed alphabetically.
  const isChild = String(form.age).trim() !== ''
  const guardianCandidates = clientsForRole(state, role)
    .filter((c) => c.id !== editing?.id && c.age === null && !c.readOnly)
    .toSorted((a, b) => a.name.localeCompare(b.name, 'pl'))
  const guardianOptions = (value) => {
    const selected = state.clients.find((c) => c.id === value)
    return selected && !guardianCandidates.includes(selected)
      ? [selected, ...guardianCandidates] : guardianCandidates
  }
  const reassigned = isApp && Boolean(editing && form.psychId !== editing.psychId)
  const assignmentMax = editing && !reassigned ? initialAssignmentDate : today

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: null }))
    setSaveStatus('idle')
    setSaveError(null)
  }

  // Clearing the first guardian moves the second one up, so the form never
  // holds a hidden second link.
  const setGuardian = (key, value) => {
    if (key === 'guardianClientId' && !value) {
      setForm((f) => ({ ...f, guardianClientId: f.secondGuardianClientId, secondGuardianClientId: '' }))
      setErrors((e) => ({ ...e, guardians: null }))
      return
    }
    set(key, value)
    setErrors((e) => ({ ...e, guardians: null }))
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
      else if (field === 'age') errors.age = AGE_ERROR
      else if (field === 'specialistId') errors.psychId ||= 'Wybierz specjalistkę'
      else if (field === 'status') errors.status ||= 'Wybierz status klienta'
      else if (field === 'assignmentStartsAt') errors.assignmentDate ||= 'Podaj prawidłową datę rozpoczęcia opieki'
      else if (field === 'guardianEmail') errors.email = 'Podaj poprawny adres e-mail opiekuna'
      else if (field === 'guardianPhone') errors.phone = 'Podaj poprawny telefon opiekuna'
      else if (field === 'receptionNotes') errors.receptionNotes = 'Skróć uwagi lub usuń niedozwolone znaki'
      else if (field === 'intakeReason') errors.intakeReason = 'Skróć opis lub usuń niedozwolone znaki'
      else if (field === 'guardianClientId' || field === 'secondGuardianClientId') {
        errors.guardians = 'Wybierz dwie różne osoby albo zostaw drugie pole puste'
      } else errors.body = 'Sprawdź dane klienta'
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
      ...(form.phone.trim() || (editing?.guardianPhone ?? editing?.phone)
        ? { guardianPhone: form.phone.trim().normalize('NFC') } : {}),
      ...(form.email.trim() || (editing?.guardianEmail ?? editing?.email)
        ? { guardianEmail: form.email.trim().normalize('NFC') } : {}),
      ...(form.receptionNotes.trim() || editing?.receptionNotes
        ? { receptionNotes: form.receptionNotes.trim().normalize('NFC') } : {}),
      ...cardFields(),
    }
  }

  // Card fields travel only when set now or set before (to clear them). The
  // guardian, rights and consent fields describe a child, so an adult record
  // clears them.
  const cardFields = () => {
    const values = {
      intakeReason: form.intakeReason.trim().normalize('NFC'),
      guardianClientId: isChild ? form.guardianClientId : '',
      secondGuardianClientId: isChild ? form.secondGuardianClientId : '',
      parentalRights: isChild ? form.parentalRights : '',
      therapyConsent: isChild && form.therapyConsent ? 'signed' : '',
    }
    return Object.fromEntries(Object.entries(values)
      .filter(([key, value]) => value || editing?.[key]))
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

  const selectedPsych = state.psychologists.find((psych) => psych.id === form.psychId)
  const selectedLacksAccess = isApp && Boolean(selectedPsych) && !hasActivePanelAccess(selectedPsych)

  const showConflict = () => {
    setSaveStatus('error')
    setConflict(true)
    setSaveError(null)
  }

  // After a conflict the draft stays on screen; only this explicit reload
  // swaps in the latest record (and its version) for the next save.
  const [adoptLatest, setAdoptLatest] = useState(false)
  const reloadLatest = async () => {
    if (reloadStatus === 'loading') return
    setReloadStatus('loading')
    try {
      await refreshWorkspace(opts.workspaceRange)
    } catch {
      setReloadStatus('error')
      return
    }
    setAdoptLatest(true)
  }
  useEffect(() => {
    if (!adoptLatest) return
    setAdoptLatest(false)
    const latest = state.clients.find((client) => client.id === editing?.id)
    if (!latest) {
      setReloadStatus('error')
      return
    }
    const next = formFrom(latest, latest.psychId)
    setEditing(latest)
    setForm(next)
    setInitialForm(next)
    setErrors({})
    setConfirmDel(false)
    setConflict(false)
    setReloadStatus('idle')
    setSaveStatus('idle')
    setSaveError(null)
  }, [adoptLatest, state.clients, editing?.id])

  const submitApp = async () => {
    if (conflict) {
      shake()
      return
    }
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
      nextErrors.psychId = selectedLacksAccess
        ? NO_PANEL_ACCESS_COPY
        : role.scope === 'own'
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
        showConflict()
        return
      }
      if (selectedLacksAccess) {
        // the server answers a generic NOT_FOUND here; the loaded team data
        // tells us the real reason
        setSaveStatus('error')
        setErrors({ psychId: NO_PANEL_ACCESS_COPY })
        focusFirstError()
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
      setSaveError(saveFailureCopy(error, { subject: 'danych klienta' }))
      return
    }
    if (!await refreshAfterAppMutation('Dane zapisano, ale nie udało się odświeżyć kartoteki.')) return
    if (editing) {
      forceClose()
      toast(`Dane klienta zostały zapisane · ${payload.name}`)
      return
    }
    allowCreatedClientNavigation.current = true
    forceClose()
    navigate('client', { id: createdClient.id })
    setTimeout(() => toast(`Klient został dodany · ${payload.name}`), 0)
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
    for (const [field, value, error] of [
      ['guardianEmail', form.email, 'Podaj poprawny adres e-mail opiekuna'],
      ['guardianPhone', form.phone, 'Podaj poprawny telefon opiekuna'],
      ['receptionNotes', form.receptionNotes, 'Skróć uwagi lub usuń niedozwolone znaki'],
      ['intakeReason', form.intakeReason, 'Skróć opis lub usuń niedozwolone znaki'],
    ]) {
      try { assertClientContactFields({ [field]: value.trim().normalize('NFC') }) }
      catch { errs[field === 'guardianEmail' ? 'email' : field === 'guardianPhone' ? 'phone' : field] = error }
    }
    const dateError = assignmentDateError()
    if (dateError) errs.assignmentDate = dateError
    if (String(form.age).trim()) {
      const age = Number(form.age)
      if (!Number.isInteger(age) || age < 1 || age > 26) errs.age = AGE_ERROR
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
      guardianPhone: form.phone.trim(),
      guardianEmail: form.email.trim(),
      receptionNotes: form.receptionNotes.trim(),
      intakeReason: form.intakeReason.trim(),
      parentalRights: isChild ? form.parentalRights : '',
      therapyConsent: isChild && form.therapyConsent ? 'signed' : '',
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
      toast(`Dane klienta zostały zapisane · ${payload.name}`)
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
      setTimeout(() => toast(`Klient został dodany · ${payload.name}`), 0)
      return
    }
    forceClose()
  }

  const sessionCount = editing ? state.sessions.filter((s) => s.clientId === editing.id).length : 0
  const debt = editing ? clientOutstanding(state.sessions, editing.id) : 0

  const remove = () => {
    if (isApp) return
    dispatch({ type: 'DELETE_CLIENT', id: editing.id })
    toast(`Klient został usunięty · ${editing.name}`)
    if (route.name === 'client' && route.params?.id === editing.id) navigate('clients')
    forceClose()
  }

  const canArchive = isApp && Boolean(editing) && !editing.readOnly && editing.status !== 'archived'
    && canPerformAction(capabilities, 'client.archive')
  const archive = async () => {
    if (conflict) {
      shake()
      return
    }
    if (!isApp || saveStatus === 'saving' || clientMutationLocked
      || !canPerformAction(capabilities, 'client.archive')
      || !editing || editing.readOnly || editing.status === 'archived') return
    setSaveStatus('saving')
    setSaveError(null)
    try {
      await workspace.archiveClient(editing.id, editing.version)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        showConflict()
        return
      }
      setSaveStatus('error')
      if (error instanceof ApiError && error.code === 'CLIENT_ARCHIVE_CONFLICT') {
        setSaveError(ARCHIVE_BLOCKED_COPY)
      } else {
        const copy = saveFailureCopy(error)
        setSaveError(copy.startsWith('Nie udało się zapisać')
          ? 'Nie udało się zarchiwizować klienta. Spróbuj ponownie za chwilę.'
          : copy)
      }
      return
    }
    if (!await refreshAfterAppMutation('Klienta zarchiwizowano, ale nie udało się odświeżyć kartoteki.')) return
    toast(`Klient został zarchiwizowany · ${editing.name}`)
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

          <Field label="Wiek (opcjonalnie)" error={errors.age} hint="Tylko dla dzieci i młodzieży do 26 lat. Dorosłym zostaw puste.">
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

          <Field label="Z czym przychodzi" error={errors.intakeReason}
            hint="Krótko, z czym osoba zgłasza się na pierwszą wizytę.">
            <textarea
              name="client-intake-reason"
              autoComplete="off"
              className="textarea"
              value={form.intakeReason}
              placeholder="np. Trudności w szkole, lęk przed rozstaniem"
              onChange={(e) => set('intakeReason', e.target.value)}
            />
          </Field>

          {isChild && isApp && (
            <Field label="Rodzic / opiekun" error={errors.guardians}
              hint="Powiąż kartę dziecka z kartą rodzica, jeśli rodzic też jest klientem.">
              <div className="stack client-form__guardians">
                {[['guardianClientId', 'Pierwszy rodzic lub opiekun'], ['secondGuardianClientId', 'Drugi rodzic lub opiekun']]
                  .filter(([key]) => key === 'guardianClientId' || form.guardianClientId)
                  .map(([key, label]) => (
                    <select
                      key={key}
                      name={`client-${key}`}
                      autoComplete="off"
                      className="select"
                      aria-label={label}
                      value={form[key]}
                      onChange={(e) => setGuardian(key, e.target.value)}
                    >
                      <option value="">— brak —</option>
                      {guardianOptions(form[key]).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  ))}
              </div>
            </Field>
          )}

          {isChild && (
            <>
              <Field label="Oboje rodzice mają pełnię praw rodzicielskich">
                <Segmented
                  ariaLabel="Oboje rodzice mają pełnię praw rodzicielskich"
                  value={form.parentalRights}
                  onChange={(v) => set('parentalRights', v)}
                  options={PARENTAL_RIGHTS_OPTIONS}
                />
              </Field>
              <Check checked={form.therapyConsent} onChange={(v) => set('therapyConsent', v)}>
                Zgoda na terapię małoletniego podpisana
              </Check>
            </>
          )}

          <div className="form-grid">
            <Field label="E-mail opiekuna" error={errors.email}>
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
            <Field label="Telefon opiekuna" error={errors.phone}>
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
          </div>

          <Field label="Uwagi recepcji" error={errors.receptionNotes}
            hint="Tylko informacje organizacyjne, bez notatek klinicznych.">
            <textarea
              name="client-reception-notes"
              autoComplete="off"
              className="textarea"
              value={form.receptionNotes}
              placeholder="np. Preferowany kontakt po 15:00"
              onChange={(e) => set('receptionNotes', e.target.value)}
            />
          </Field>

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
                      toast('Powiązanie rodzinne zostało usunięte')
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

          {editing && !confirmDel && (!isApp || canArchive) && (
            <button
              type="button"
              className="link client-form__archive"
              onClick={() => setConfirmDel(true)}
              disabled={saveStatus === 'saving'}
            >
              {isApp ? 'Archiwizuj klienta' : 'Usuń klienta'}
            </button>
          )}

          {isApp && editing && confirmDel && (
            <div className="form-warn">
              <Icon name="alert" size={15} />
              <span>
                <b>{editing.name}</b> zniknie z listy klientów. Karta, historia sesji i płatności zostaną zachowane.
              </span>
            </div>
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
          {conflict && (
            <div className="form-warn form-warn--error client-form__conflict" role="alert">
              <Icon name="alert" size={15} />
              <span>
                {conflictCopy('dane klienta')} Wczytaj aktualne dane i wprowadź zmianę jeszcze raz.
                {reloadStatus === 'error' && <> {loadFailureCopy('danych klienta')}</>}
              </span>
              <Button size="sm" variant="soft" onClick={reloadLatest} disabled={reloadStatus === 'loading'}>
                {reloadStatus === 'loading' ? 'Wczytuję dane klienta…' : reloadStatus === 'error' ? 'Spróbuj ponownie' : 'Wczytaj aktualne dane'}
              </Button>
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

        <div className={`drawer__foot${confirmDel ? ' client-form__confirm-foot' : ''}`}>
          {confirmDel ? (
            <>
              <Button variant="ghost" onClick={() => setConfirmDel(false)} disabled={saveStatus === 'saving'}>Wróć</Button>
              {isApp ? (
                <Button variant="danger" onClick={archive} disabled={saveStatus === 'saving'}>
                  {saveStatus === 'saving' ? 'Archiwizowanie…' : 'Tak, archiwizuj klienta'}
                </Button>
              ) : (
                <Button variant="danger" onClick={remove}>Tak, usuń klienta</Button>
              )}
            </>
          ) : (
            <>
              <Button variant="primary" onClick={submit} disabled={isApp && saveStatus === 'saving'}>
                {isApp && saveStatus === 'saving' ? 'Zapisywanie…' : editing ? 'Zapisz zmiany' : 'Dodaj klienta'}
              </Button>
              <Button variant="ghost" onClick={close} disabled={isApp && saveStatus === 'saving'}>Anuluj</Button>
            </>
          )}
        </div>
      </aside>
    </>
  )
}
