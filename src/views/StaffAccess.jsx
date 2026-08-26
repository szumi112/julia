import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ApiError, apiClient } from '../api.js'
import { useDrawerFX } from '../anim.js'
import { useShell } from '../shell-ctx.js'
import { useApp } from '../store.jsx'
import { Button, DiscardConfirm, Field, IconBtn, Pill, useDiscardGuard } from '../ui.jsx'

const ROLE_OPTIONS = Object.freeze([
  Object.freeze({ label: 'Koordynator', value: 'coordinator' }),
  Object.freeze({ label: 'Specjalista', value: 'specialist' }),
  Object.freeze({ label: 'Właściciel', value: 'owner' }),
])
const ROLE_LABELS = Object.freeze(Object.fromEntries(
  ROLE_OPTIONS.map(({ label, value }) => [value, label])
))
const STAFF_STATUS_LABELS = Object.freeze({
  active: 'Aktywne',
  disabled: 'Wyłączone',
  pending: 'Oczekuje na aktywację',
})
const STAFF_STATUS_TONES = Object.freeze({
  active: 'sage',
  disabled: 'ink',
  pending: 'amber',
})
const INVITATION_STATUS_LABELS = Object.freeze({
  pending: 'Zaproszenie wysłane',
  provisioning: 'Konfiguracja dostępu w toku',
})
const UNKNOWN_ROLE = 'Rola niedostępna'
const UNKNOWN_STATE = 'Stan niedostępny'
const INVITATION_ERROR_LABELS = Object.freeze({
  CLIENT_INPUT_INVALID: 'Sprawdź dane zaproszenia i spróbuj ponownie.',
  FORBIDDEN: 'Nie masz już uprawnień do zarządzania personelem.',
  IDEMPOTENCY_CONFLICT: 'Nie można ponowić zmienionego zaproszenia.',
  LAST_ACTIVE_OWNER: 'Nie można zmienić dostępu ostatniego aktywnego właściciela.',
  NOT_FOUND: 'Nie można utworzyć tego zaproszenia.',
  RATE_LIMITED: 'Limit zaproszeń został wykorzystany. Spróbuj ponownie później.',
  STAFF_INVITATION_CONFLICT: 'Nie można utworzyć tego zaproszenia.',
  VALIDATION_FAILED: 'Sprawdź dane zaproszenia i spróbuj ponownie.',
})
const INVITATION_UNKNOWN_ERROR = 'Nie udało się utworzyć zaproszenia.'
const INVITATION_UNCERTAIN_ERROR = 'Nie wiadomo, czy zaproszenie zostało utworzone. Spróbuj ponownie bez zmiany danych.'
const DEACTIVATION_ERROR_LABELS = Object.freeze({
  CLIENT_INPUT_INVALID: 'Nie udało się przygotować zmiany dostępu.',
  FORBIDDEN: 'Nie masz już uprawnień do zarządzania personelem.',
  IDEMPOTENCY_CONFLICT: 'Nie można ponowić zmienionej operacji.',
  LAST_ACTIVE_OWNER: 'Nie można wyłączyć ostatniego aktywnego właściciela.',
  NOT_FOUND: 'Nie można odnaleźć tej osoby.',
  RATE_LIMITED: 'Limit operacji został wykorzystany. Spróbuj ponownie później.',
  VALIDATION_FAILED: 'Nie udało się przygotować zmiany dostępu.',
})
const DEACTIVATION_UNKNOWN_ERROR = 'Nie udało się wyłączyć dostępu.'
const DEACTIVATION_UNCERTAIN_ERROR = 'Nie wiadomo, czy dostęp został wyłączony. Spróbuj ponownie bez zmiany danych.'
const EMAIL = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+$/u
const INVALID_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const expiryFormat = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

const bytes = (value) => new TextEncoder().encode(value).byteLength
const canonicalEmail = (value) => {
  if (typeof value !== 'string' || INVALID_TEXT.test(value)) return null
  const email = value.trim().toLowerCase().normalize('NFC')
  if (bytes(email) > 254
    || !EMAIL.test(email)
    || email.startsWith('.')
    || email.includes('..')
    || email.includes('.@')
    || !email.endsWith('@example.test')) return null
  return email
}
const displayNameFor = (value) => value.trim().normalize('NFC')
const validDisplayName = (value) => value.length > 0
  && bytes(value) <= 120
  && !INVALID_TEXT.test(value)
const labelFor = (labels, value, fallback) => (
  typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : fallback
)
const expiryLabel = (value) => expiryFormat.format(new Date(value))

function useNativeModal(fallbackRef) {
  const dialogRef = useRef(null)

  useEffect(() => {
    const dialog = dialogRef.current
    const opener = document.activeElement
    dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
      requestAnimationFrame(() => {
        const target = opener?.isConnected ? opener : fallbackRef?.current
        target?.focus({ preventScroll: true })
      })
    }
  }, [fallbackRef])

  return dialogRef
}

function InvitationDrawer({ onChanged, onClose, onDirtyChange, onForbidden }) {
  const { toast } = useApp()
  const dialogRef = useNativeModal()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const [form, setForm] = useState({
    displayName: '',
    email: '',
    roleIndex: '0',
  })
  const [errors, setErrors] = useState({})
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const actionRef = useRef(null)
  const dirty = form.displayName !== '' || form.email !== '' || form.roleIndex !== '0'
  const discardGuard = useDiscardGuard(dirty)
  const { close, forceClose, shake } = useDrawerFX(
    drawerRef,
    backRef,
    onClose,
    discardGuard.guard,
  )

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const set = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: null }))
    actionRef.current = null
    setSaveStatus('idle')
    setSaveError(null)
  }
  const submit = async (event) => {
    event?.preventDefault()
    if (saveStatus === 'saving') return
    const displayName = displayNameFor(form.displayName)
    const email = canonicalEmail(form.email)
    const role = ROLE_OPTIONS[Number(form.roleIndex)]?.value
    const nextErrors = {
      displayName: validDisplayName(displayName) ? null : 'Podaj imię i nazwisko',
      email: email ? null : 'Podaj poprawny adres e-mail',
      role: role ? null : 'Wybierz rolę',
    }
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) {
      shake()
      requestAnimationFrame(() => drawerRef.current?.querySelector('[aria-invalid="true"]')?.focus())
      return
    }

    let action = actionRef.current
    if (!action) {
      try {
        action = {
          key: apiClient.createIdempotencyKey(),
          payload: { displayName, email, role },
        }
      } catch {
        setSaveError(INVITATION_UNKNOWN_ERROR)
        setSaveStatus('error')
        return
      }
      actionRef.current = action
    }

    setSaveStatus('saving')
    setSaveError(null)
    try {
      await apiClient.inviteStaff(action.payload, { idempotencyKey: action.key })
      await onChanged()
      toast('Zaproszenie zostało utworzone.')
      forceClose()
    } catch (error) {
      const uncertain = error instanceof ApiError && error.idempotencyKey === action.key
      if (uncertain) {
        setSaveError(INVITATION_UNCERTAIN_ERROR)
        setSaveStatus('uncertain')
        return
      }
      actionRef.current = null
      if (error instanceof ApiError && error.code === 'FORBIDDEN') onForbidden()
      setSaveError(error instanceof ApiError
        ? INVITATION_ERROR_LABELS[error.code] || INVITATION_UNKNOWN_ERROR
        : INVITATION_UNKNOWN_ERROR)
      setSaveStatus('error')
    }
  }

  return (
    <dialog
      className="modal-layer"
      ref={dialogRef}
      aria-label="Zaproś osobę"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside
        className="drawer"
        ref={drawerRef}
      >
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">Zaproś osobę</h2>
            <p className="drawer__sub">Dodaj dostęp do panelu personelu.</p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field label="Imię i nazwisko" error={errors.displayName}>
            <input
              className="input"
              name="staff-name"
              autoComplete="name"
              disabled={saveStatus === 'saving'}
              maxLength={120}
              value={form.displayName}
              onChange={(event) => set('displayName', event.target.value)}
            />
          </Field>
          <Field
            label="Adres e-mail"
            error={errors.email}
            hint="W środowisku testowym użyj adresu w domenie example.test."
          >
            <input
              className="input"
              type="email"
              name="staff-email"
              autoComplete="email"
              disabled={saveStatus === 'saving'}
              maxLength={254}
              spellCheck={false}
              value={form.email}
              onChange={(event) => set('email', event.target.value)}
            />
          </Field>
          <Field label="Rola" error={errors.role}>
            <select
              className="select"
              name="staff-role"
              autoComplete="off"
              disabled={saveStatus === 'saving'}
              value={form.roleIndex}
              onChange={(event) => set('roleIndex', event.target.value)}
            >
              {ROLE_OPTIONS.map(({ label }, index) => (
                <option key={label} value={String(index)}>{label}</option>
              ))}
            </select>
          </Field>
          {saveError && (
            <div className="form-warn form-warn--error" role="alert">
              <span>{saveError}</span>
            </div>
          )}
          {discardGuard.confirming && (
            <DiscardConfirm onStay={discardGuard.hide} onDiscard={forceClose} />
          )}
        </form>

        <div className="drawer__foot">
          <Button variant="primary" disabled={saveStatus === 'saving'} onClick={submit}>
            {saveStatus === 'uncertain'
              ? 'Spróbuj ponownie'
              : 'Wyślij zaproszenie'}
          </Button>
          <Button variant="ghost" disabled={saveStatus === 'saving'} onClick={close}>Anuluj</Button>
        </div>
      </aside>
    </dialog>
  )
}

function DeactivationConfirm({
  fallbackRef,
  onChanged,
  onClose,
  onForbidden,
  person,
}) {
  const { toast } = useApp()
  const titleId = useId()
  const dialogRef = useNativeModal(fallbackRef)
  const cardRef = useRef(null)
  const actionRef = useRef(null)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)

  useEffect(() => {
    const card = cardRef.current
    card?.querySelector('button')?.focus()
    const controls = () => [...(card?.querySelectorAll('button, [tabindex]:not([tabindex="-1"])') || [])]
      .filter((element) => !element.disabled && element.offsetParent !== null)
    const onKey = (event) => {
      if (event.key === 'Tab') {
        const elements = controls()
        if (!elements.length) return
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (event.shiftKey && (document.activeElement === first || !card?.contains(document.activeElement))) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !card?.contains(document.activeElement))) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const close = () => {
    if (saveStatus !== 'saving') onClose()
  }
  const submit = async () => {
    if (saveStatus === 'saving') return
    let action = actionRef.current
    if (!action) {
      try {
        action = {
          key: apiClient.createIdempotencyKey(),
          staffId: person.id,
          version: person.version,
        }
      } catch {
        setSaveError(DEACTIVATION_UNKNOWN_ERROR)
        setSaveStatus('error')
        return
      }
      actionRef.current = action
    }

    setSaveStatus('saving')
    setSaveError(null)
    try {
      await apiClient.deactivateStaff(action.staffId, action.version, {
        idempotencyKey: action.key,
      })
      await onChanged()
      toast('Dostęp został wyłączony.')
      onClose()
    } catch (error) {
      const uncertain = error instanceof ApiError && error.idempotencyKey === action.key
      if (uncertain) {
        setSaveError(DEACTIVATION_UNCERTAIN_ERROR)
        setSaveStatus('uncertain')
        return
      }
      actionRef.current = null
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        onClose()
        const refreshed = await onChanged()
        toast(
          refreshed
            ? 'Lista personelu została odświeżona.'
            : 'Nie udało się odświeżyć listy personelu. Użyj przycisku „Odśwież”.',
          'alert',
        )
        return
      }
      if (error instanceof ApiError && error.code === 'FORBIDDEN') {
        onForbidden()
        onClose()
        return
      }
      setSaveError(error instanceof ApiError
        ? DEACTIVATION_ERROR_LABELS[error.code] || DEACTIVATION_UNKNOWN_ERROR
        : DEACTIVATION_UNKNOWN_ERROR)
      setSaveStatus('error')
    }
  }

  return (
    <dialog
      className="modal-layer"
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="leave-confirm staff-deactivation-confirm">
        <div className="leave-confirm__backdrop" onClick={close} />
        <div
          className="leave-confirm__card"
          ref={cardRef}
        >
          <h2 className="display" id={titleId}>Wyłącz dostęp</h2>
          <p>
            {person.displayName} straci dostęp do panelu. Wpis pozostanie na liście personelu.
          </p>
          {saveError && (
            <div className="form-warn form-warn--error" role="alert">
              <span>{saveError}</span>
            </div>
          )}
          <div className="leave-confirm__actions">
            <Button variant="ghost" disabled={saveStatus === 'saving'} onClick={close}>Wróć</Button>
            <Button variant="danger" disabled={saveStatus === 'saving'} onClick={submit}>
              {saveStatus === 'uncertain' ? 'Spróbuj ponownie' : 'Wyłącz dostęp'}
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  )
}

export function StaffAccess({ sectionRef }) {
  const { toast } = useApp()
  const { registerLeaveGuard } = useShell()
  const [staff, setStaff] = useState([])
  const [loadStatus, setLoadStatus] = useState('loading')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [deactivation, setDeactivation] = useState(null)
  const requestRef = useRef(0)
  const inviteDirtyRef = useRef(false)
  const headingRef = useRef(null)
  const setInviteDirty = useCallback((dirty) => {
    inviteDirtyRef.current = dirty
  }, [])

  const loadStaff = useCallback(async () => {
    const requestId = ++requestRef.current
    setLoadStatus('loading')
    try {
      const result = await apiClient.listStaff()
      if (requestRef.current !== requestId) return false
      setStaff(result.staff)
      setLoadStatus('ready')
      return true
    } catch {
      if (requestRef.current !== requestId) return false
      setStaff([])
      setLoadStatus('error')
      return false
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStaff()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      requestRef.current += 1
    }
  }, [loadStaff])

  useEffect(
    () => registerLeaveGuard(() => inviteDirtyRef.current),
    [registerLeaveGuard],
  )

  const clearForbidden = () => {
    requestRef.current += 1
    setStaff([])
    setLoadStatus('error')
    toast('Uprawnienia do listy personelu uległy zmianie.', 'alert')
  }

  return (
    <>
      <section
        className="settings-section staff-access"
        aria-labelledby="staff-access-title"
        ref={sectionRef}
      >
        <div className="staff-access__head">
          <div>
            <h2
              className="settings-section__title"
              id="staff-access-title"
              ref={headingRef}
              tabIndex={-1}
            >
              Dostęp personelu
            </h2>
            <p>Zarządzaj dostępem osób pracujących w centrum.</p>
          </div>
          <Button icon="plus" size="sm" onClick={() => setInviteOpen(true)}>Zaproś osobę</Button>
        </div>

        {loadStatus === 'loading' && (
          <p className="staff-access__state" role="status">Pobieranie listy personelu…</p>
        )}
        {loadStatus === 'error' && (
          <div className="staff-access__state" role="alert">
            <span>Nie udało się pobrać listy personelu.</span>
            <Button size="sm" variant="ghost" onClick={loadStaff}>Odśwież</Button>
          </div>
        )}
        {loadStatus === 'ready' && (
          <ul className="staff-access__list" aria-label="Lista personelu">
            {staff.map((person) => (
              <li className="staff-access-row" key={person.id}>
                <div className="staff-access-row__identity">
                  <strong className="staff-access-row__name">{person.displayName}</strong>
                  <span className="staff-access-row__email">{person.email}</span>
                </div>
                <div className="staff-access-row__details">
                  <span>{labelFor(ROLE_LABELS, person.role, UNKNOWN_ROLE)}</span>
                  <Pill tone={STAFF_STATUS_TONES[person.status] || 'ink'}>
                    {labelFor(STAFF_STATUS_LABELS, person.status, UNKNOWN_STATE)}
                  </Pill>
                  {person.status !== 'disabled' && (
                    <IconBtn
                      name="logout"
                      label={`Wyłącz dostęp — ${person.displayName}`}
                      onClick={() => setDeactivation(person)}
                    />
                  )}
                </div>
                {person.invitation && (
                  <div className="staff-access-row__invitation">
                    <span>
                      {labelFor(
                        INVITATION_STATUS_LABELS,
                        person.invitation.status,
                        UNKNOWN_STATE,
                      )}
                    </span>
                    <span>Ważne do {expiryLabel(person.invitation.expiresAt)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {inviteOpen && (
        <InvitationDrawer
          onChanged={loadStaff}
          onClose={() => setInviteOpen(false)}
          onDirtyChange={setInviteDirty}
          onForbidden={clearForbidden}
        />
      )}
      {deactivation && (
        <DeactivationConfirm
          fallbackRef={headingRef}
          onChanged={loadStaff}
          onClose={() => setDeactivation(null)}
          onForbidden={clearForbidden}
          person={deactivation}
        />
      )}
    </>
  )
}
