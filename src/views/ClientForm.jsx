// Add/Edit client — slide-over drawer with validation and delete-with-confirm.
import { useEffect, useRef, useState } from 'react'
import { useApp, clientOutstanding, useWorkspaceRefresh } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { clientsForRole } from '../workspace.js'
import { Button, Field, Segmented, IconBtn, DiscardConfirm, useDiscardGuard } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { useDrawerFX } from '../anim.js'
import { toISODate, plural, fmtMoney } from '../format.js'
import { ApiError } from '../api.js'
import { validateClientInput } from '../core-records.js'

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ClientDrawer({ opts, onClose }) {
  const { state, dispatch, toast, workspace } = useApp()
  const { appMode, capabilities, route, navigate, role, registerLeaveGuard } = useShell()
  const refreshWorkspace = useWorkspaceRefresh()
  const isApp = appMode === 'app'
  const editing = opts.client || null
  const drawerRef = useRef(null)
  const backRef = useRef(null)

  const [form, setForm] = useState({
    name: editing?.name || '',
    age: editing?.age ?? '',
    psychId: editing?.psychId || opts.psychId || '',
    email: editing?.email || '',
    phone: editing?.phone || '',
    status: editing?.status || 'active',
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
  const { close, forceClose, shake } = useDrawerFX(drawerRef, backRef, onClose, discardGuard.guard)
  useEffect(() => registerLeaveGuard(discardGuard.check), [registerLeaveGuard, discardGuard.check])

  // the drawer may unlink while open — read the live record, not the snapshot
  const current = editing ? state.clients.find((c) => c.id === editing.id) || editing : null
  const familyMembers = !isApp && current?.familyId
    ? state.clients.filter((c) => c.familyId === current.familyId && c.id !== current.id)
    : []
  // therapists may link only within their own client list
  const linkables = clientsForRole(state, role).filter(
    (c) => c.id !== editing?.id && !familyMembers.some((m) => m.id === c.id)
  )
  const availablePsychologists = role.scope === 'own'
    ? state.psychologists.filter((psych) => psych.id === role.psychId)
    : state.psychologists

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
    try {
      validateClientInput(payload)
      return {}
    } catch (error) {
      const field = error instanceof TypeError ? error.message.split('/').at(-1) : 'body'
      return {
        name: field === 'name' ? 'Podaj imię i nazwisko' : null,
        age: field === 'age' ? 'Podaj wiek od 1 do 26 lat' : null,
        psychId: field === 'specialistId' ? 'Wybierz specjalistkę' : null,
        status: field === 'status' ? 'Wybierz status klienta' : null,
        body: ['name', 'age', 'specialistId', 'status'].includes(field)
          ? null
          : 'Sprawdź dane klienta',
      }
    }
  }

  const appPayload = () => ({
    name: form.name.trim().normalize('NFC'),
    age: String(form.age).trim() === '' ? null : Number(form.age),
    status: form.status,
    specialistId: form.psychId,
  })

  const submitApp = async () => {
    if (saveStatus === 'saving' || !capabilities.includes('client.manage')
      || editing?.readOnly || editing?.status === 'archived') return
    const payload = appPayload()
    const nextErrors = appErrors(payload)
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) {
      focusFirstError()
      return
    }
    setSaveStatus('saving')
    setSaveError(null)
    try {
      if (editing) await workspace.editClient(editing.id, editing.version, payload)
      else await workspace.createClient(payload)
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
      setSaveError('Nie udało się zapisać danych klienta.')
      return
    }
    try {
      await refreshWorkspace(opts.workspaceRange)
    } catch {
      setSaveStatus('error')
      setSaveError('Dane zapisano, ale nie udało się odświeżyć kartoteki.')
      return
    }
    toast(editing ? 'Dane klienta zapisane' : 'Nowy klient dodany do kartoteki')
    forceClose()
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
      dispatch({
        type: 'ADD_CLIENT',
        client: {
          ...payload,
          since: toISODate(new Date()),
          notes: note ? [{ date: toISODate(new Date()), text: note }] : [],
        },
        familyLink: form.familyOtherId
          ? { otherId: form.familyOtherId, role: form.familyRole || null }
          : undefined,
      })
      toast('Nowy klient dodany do kartoteki')
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
    if (!isApp || saveStatus === 'saving' || !capabilities.includes('client.manage')
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
    try {
      await refreshWorkspace(opts.workspaceRange)
    } catch {
      setSaveStatus('error')
      setSaveError('Klienta zarchiwizowano, ale nie udało się odświeżyć kartoteki.')
      return
    }
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
          </div>

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
