import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ApiError, apiClient } from '../api.js'
import { useDrawerFX } from '../anim.js'
import { useAuth } from '../auth.jsx'
import { accessPresentationFor, roleLabelFor, rolePresentationFor } from '../auth-role.js'
import { canPerformAction } from '../capability-access.js'
import {
  permissionDefaultsFor,
  permissionGroupsFor,
  setPermissionEnabled,
} from '../permission-overrides.js'
import { useShell } from '../shell-ctx.js'
import { useApp } from '../store.jsx'
import { Button, DiscardConfirm, Field, IconBtn, Pill, Toggle, useDiscardGuard } from '../ui.jsx'
import { EntityLink } from '../ux-patterns.jsx'

const ROLE_OPTIONS = Object.freeze([
  Object.freeze({
    label: roleLabelFor('specialist'),
    value: 'specialist',
    effect: 'Własny Grafik, przypisani klienci i własne rozliczenia.',
  }),
  Object.freeze({
    label: roleLabelFor('coordinator'),
    value: 'coordinator',
    effect: 'Grafik i klienci całej poradni oraz finanse całej poradni.',
  }),
  Object.freeze({
    label: roleLabelFor('owner'),
    value: 'owner',
    effect: 'Zarządza całą poradnią, zespołem i dostępem.',
  }),
])
const INVITATION_ERROR_LABELS = Object.freeze({
  CLIENT_INPUT_INVALID: 'Sprawdź dane zaproszenia i spróbuj ponownie.',
  FORBIDDEN: 'Nie masz już uprawnień do zarządzania personelem.',
  IDEMPOTENCY_CONFLICT: 'Nie można ponowić zmienionego zaproszenia.',
  LAST_ACTIVE_OWNER: 'Nie można zmienić dostępu ostatniego aktywnego właściciela.',
  NOT_FOUND: 'Nie można utworzyć tego zaproszenia.',
  RATE_LIMITED: 'Możesz wysłać maksymalnie 5 zaproszeń w ciągu godziny. Spróbuj ponownie później.',
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
const ROLE_CHANGE_ERROR_LABELS = Object.freeze({
  CLIENT_INPUT_INVALID: 'Nie udało się przygotować zmiany roli.',
  FORBIDDEN: 'Nie masz już uprawnień do zarządzania personelem.',
  IDEMPOTENCY_CONFLICT: 'Nie można ponowić zmienionej operacji.',
  LAST_ACTIVE_OWNER: 'Nie można zmienić roli ostatniego aktywnego właściciela.',
  NOT_FOUND: 'Nie można odnaleźć tej osoby.',
  RATE_LIMITED: 'Limit operacji został wykorzystany. Spróbuj ponownie później.',
  VALIDATION_FAILED: 'Nie udało się przygotować zmiany roli.',
})
const ROLE_CHANGE_UNKNOWN_ERROR = 'Nie udało się zmienić roli.'
const ROLE_CHANGE_UNCERTAIN_ERROR = 'Nie wiadomo, czy rola została zmieniona. Spróbuj ponownie bez zmiany wyboru.'
const PERMISSION_SAVE_ERROR_LABELS = Object.freeze({
  CLIENT_INPUT_INVALID: 'Nie udało się przygotować zmiany uprawnień.',
  FORBIDDEN: 'Nie masz już uprawnień do zarządzania uprawnieniami.',
  IDEMPOTENCY_CONFLICT: 'Nie można ponowić zmienionej operacji.',
  NOT_FOUND: 'Nie można odnaleźć tej osoby.',
  RATE_LIMITED: 'Limit operacji został wykorzystany. Spróbuj ponownie później.',
  VALIDATION_FAILED: 'Nie udało się przygotować zmiany uprawnień.',
})
const PERMISSION_UNKNOWN_ERROR = 'Nie udało się zapisać uprawnień.'
const PERMISSION_UNCERTAIN_ERROR = 'Nie wiadomo, czy uprawnienia zostały zapisane. Spróbuj ponownie bez zmiany ustawień.'
const PERMISSION_COPY = Object.freeze({
  'appointment.manage': Object.freeze({ label: 'Może zarządzać sesjami', effect: 'Umawia, zmienia i odwołuje sesje.' }),
  'client.manage': Object.freeze({ label: 'Może zarządzać klientami', effect: 'Dodaje i aktualizuje dane klientów.' }),
  'finance.centre.manage': Object.freeze({ label: 'Może zarządzać finansami centrum', effect: 'Dodaje i zmienia pozycje finansowe całej poradni.' }),
  'finance.centre.read': Object.freeze({ label: 'Widzi finanse całej poradni', effect: 'Widoczna jest lista płatności, przychodów i zaległości całej poradni.' }),
  'finance.import': Object.freeze({ label: 'Może importować dane finansowe', effect: 'Wgrywa dane finansowe z arkusza.' }),
  'operations.health.read': Object.freeze({ label: 'Może sprawdzać stan systemu', effect: 'Widoczny jest stan kopii zapasowych i usług.' }),
  'payment.manage': Object.freeze({ label: 'Może rejestrować płatności', effect: 'Oznacza wpłaty za sesje.' }),
  'permissions.manage': Object.freeze({ label: 'Może zarządzać uprawnieniami', effect: 'Zmienia zakres dostępu innych osób.' }),
  'security.audit.read': Object.freeze({ label: 'Może przeglądać dziennik bezpieczeństwa', effect: 'Widoczna jest historia zdarzeń bezpieczeństwa.' }),
  'staff.manage': Object.freeze({ label: 'Może zarządzać personelem', effect: 'Zaprasza osoby i zmienia ich dostęp.' }),
  'workbook.centre.export': Object.freeze({ label: 'Może pobierać skoroszyt centrum', effect: 'Pobiera dane całej poradni do arkusza.' }),
  'workbook.own.export': Object.freeze({ label: 'Może pobierać własny skoroszyt', effect: 'Pobiera dane własnych sesji do arkusza.' }),
})
const EMAIL = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+$/u
const INVALID_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const expiryFormat = new Intl.DateTimeFormat('pl-PL', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

const bytes = (value) => new TextEncoder().encode(value).byteLength
const canonicalEmail = (value, environment) => {
  if (typeof value !== 'string' || INVALID_TEXT.test(value)) return null
  const email = value.trim().toLowerCase().normalize('NFC')
  if (bytes(email) > 254
    || !EMAIL.test(email)
    || email.startsWith('.')
    || email.includes('..')
    || email.includes('.@')
    || (environment !== 'staging' && !email.endsWith('@example.test'))) return null
  return email
}
const displayNameFor = (value) => value.trim().normalize('NFC')
const validDisplayName = (value) => value.length > 0
  && bytes(value) <= 120
  && !INVALID_TEXT.test(value)
const expiryLabel = (value) => expiryFormat.format(new Date(value))
const sameOrdered = (left, right) => left.length === right.length
  && left.every((value, index) => value === right[index])
const targetLabel = (person) => (
  `${person.displayName} — ${rolePresentationFor(person)}${person.status === 'disabled' ? ' (bez dostępu)' : ''}`
)
const permissionCopyFor = (choice) => (
  PERMISSION_COPY[choice.capability] || Object.freeze({
    label: `Może: ${choice.label}`,
    effect: choice.defaultEnabled ? 'Włączone w tej roli.' : 'Dostępne dla tej roli.',
  })
)
const permissionDraftFor = (authority) => Object.freeze({
  role: authority.role,
  allow: authority.allow,
  deny: authority.deny,
  effectiveCapabilities: authority.effectiveCapabilities,
})

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

function RoleCards({ disabled, error, onChange, value }) {
  const errorId = useId()
  const legendId = useId()
  return (
    <fieldset
      className={`role-cards ${error ? 'has-error' : ''}`}
      disabled={disabled}
      role="radiogroup"
      aria-labelledby={legendId}
      aria-describedby={error ? errorId : undefined}
    >
      <legend id={legendId}>Rola</legend>
      <div className="role-cards__options">
        {ROLE_OPTIONS.map((option) => (
          <label
            className={`role-cards__option ${value === option.value ? 'is-selected' : ''}`}
            key={option.value}
          >
            <input
              type="radio"
              name="staff-role"
              value={option.value}
              checked={value === option.value}
              aria-invalid={error ? true : undefined}
              onChange={(event) => onChange(event.target.value)}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.effect}</small>
            </span>
          </label>
        ))}
      </div>
      {error && <span className="field__error" id={errorId} role="alert">{error}</span>}
    </fieldset>
  )
}

function InvitationDrawer({ environment, initialPerson = null, onChanged, onClose, onDirtyChange, onForbidden }) {
  const { toast } = useApp()
  const dialogRef = useNativeModal()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const [initialForm] = useState(() => Object.freeze({
    displayName: initialPerson?.displayName ?? '',
    email: initialPerson?.email ?? '',
    role: initialPerson?.role ?? '',
  }))
  const [form, setForm] = useState(initialForm)
  const [errors, setErrors] = useState({})
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const actionRef = useRef(null)
  const reinvite = initialPerson !== null
  const dirty = form.displayName !== initialForm.displayName
    || form.email !== initialForm.email || form.role !== initialForm.role
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
    const email = canonicalEmail(form.email, environment)
    const role = form.role
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
    let accepted = false
    try {
      await apiClient.inviteStaff(action.payload, { idempotencyKey: action.key })
      accepted = true
      const refreshed = await onChanged()
      if (refreshed === false) {
        toast(`Wysyłamy zaproszenie do ${action.payload.email}`)
        toast('Nie udało się odświeżyć listy personelu. Odśwież stronę.', 'alert')
        forceClose()
        return
      }
      toast(`Wysyłamy zaproszenie do ${action.payload.email}`)
      forceClose()
    } catch (error) {
      if (accepted) {
        toast(`Wysyłamy zaproszenie do ${action.payload.email}`)
        toast('Nie udało się odświeżyć listy personelu. Odśwież stronę.', 'alert')
        forceClose()
        return
      }
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
      aria-label={reinvite ? 'Zaproś ponownie' : 'Zaproś do panelu'}
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
            <h2 className="drawer__title">{reinvite ? 'Zaproś ponownie' : 'Zaproś do panelu'}</h2>
            <p className="drawer__sub">{reinvite
              ? 'Wyślemy nowe zaproszenie do panelu tej osobie.'
              : 'Dodaj dostęp do panelu personelu.'}</p>
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
            hint={environment === 'staging'
              ? 'Na ten adres wyślemy zaproszenie do chronionego panelu.'
              : 'W środowisku testowym użyj adresu w domenie example.test.'}
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
          <RoleCards
            disabled={saveStatus === 'saving'}
            error={errors.role}
            value={form.role}
            onChange={(role) => set('role', role)}
          />
          {!reinvite && <p className="field__hint">Profil zawodowy i powiązanie terapeutki pozostają osobnym krokiem w Zespole.</p>}
          <p className="field__hint">Możesz wysłać maksymalnie 5 zaproszeń w ciągu godziny. Każde zaproszenie jest ważne przez 7 dni.</p>
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
              : reinvite ? 'Zaproś ponownie' : 'Wyślij zaproszenie'}
          </Button>
          <Button variant="ghost" disabled={saveStatus === 'saving'} onClick={close}>Zamknij</Button>
        </div>
      </aside>
    </dialog>
  )
}

function RoleChangeDrawer({
  fallbackRef,
  onChanged,
  onClose,
  onDirtyChange,
  onForbidden,
  person,
}) {
  const { toast } = useApp()
  const dialogRef = useNativeModal(fallbackRef)
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const [role, setRole] = useState(person.role)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const actionRef = useRef(null)
  const dirty = role !== person.role
  const discardGuard = useDiscardGuard(dirty)
  const { close, forceClose } = useDrawerFX(
    drawerRef,
    backRef,
    onClose,
    discardGuard.guard,
  )

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const changeRole = (value) => {
    setRole(value)
    actionRef.current = null
    setSaveStatus('idle')
    setSaveError(null)
  }

  const submit = async (event) => {
    event?.preventDefault()
    if (!dirty || saveStatus === 'saving') return
    let action = actionRef.current
    if (!action) {
      try {
        action = Object.freeze({
          key: apiClient.createIdempotencyKey(),
          staffId: person.id,
          expectedVersion: person.version,
          role,
        })
      } catch {
        setSaveError(ROLE_CHANGE_UNKNOWN_ERROR)
        setSaveStatus('error')
        return
      }
      actionRef.current = action
    }

    setSaveStatus('saving')
    setSaveError(null)
    try {
      await apiClient.changeStaffRole(
        action.staffId,
        action.expectedVersion,
        action.role,
        { idempotencyKey: action.key },
      )
      await onChanged()
      toast('Rola została zmieniona.')
      forceClose()
    } catch (error) {
      const uncertain = error instanceof ApiError && error.idempotencyKey === action.key
      if (uncertain) {
        setSaveError(ROLE_CHANGE_UNCERTAIN_ERROR)
        setSaveStatus('uncertain')
        return
      }
      actionRef.current = null
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        forceClose()
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
        forceClose()
        return
      }
      setSaveError(error instanceof ApiError
        ? ROLE_CHANGE_ERROR_LABELS[error.code] || ROLE_CHANGE_UNKNOWN_ERROR
        : ROLE_CHANGE_UNKNOWN_ERROR)
      setSaveStatus('error')
    }
  }

  return (
    <dialog
      className="modal-layer"
      ref={dialogRef}
      aria-label={`Zmień rolę — ${person.displayName}`}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside className="drawer" ref={drawerRef}>
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">Zmień rolę</h2>
            <p className="drawer__sub">{person.displayName}</p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>

        <form className="drawer__body" onSubmit={submit}>
          <RoleCards
            disabled={saveStatus === 'saving'}
            value={role}
            onChange={changeRole}
          />
          <p className="field__hint">
            Po zapisaniu roli „{roleLabelFor(role)}” indywidualne wyjątki uprawnień zostaną usunięte, a domyślne uprawnienia tej roli zaczną obowiązywać.
          </p>
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
          <Button
            variant="primary"
            disabled={!dirty || saveStatus === 'saving'}
            onClick={submit}
          >
            {saveStatus === 'uncertain' ? 'Spróbuj ponownie' : 'Zapisz rolę'}
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
  const cancellingInvitation = person.status === 'pending'

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
      toast(cancellingInvitation ? 'Zaproszenie zostało anulowane.' : 'Dostęp został wyłączony.')
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
          <h2 className="display" id={titleId}>{cancellingInvitation ? 'Anuluj zaproszenie' : 'Wyłącz dostęp'}</h2>
          <p>{cancellingInvitation
            ? 'Osoba nie otrzyma już dostępu na podstawie tego zaproszenia. Późniejszy dostęp będzie wymagał nowego zaproszenia.'
            : 'Po wyłączeniu dostępu ta osoba nie będzie mogła zalogować się do panelu. Sesje, klienci i historia pozostaną bez zmian. Indywidualne wyjątki uprawnień zostaną usunięte. Przyszły dostęp będzie wymagał nowego zaproszenia.'}</p>
          {saveError && (
            <div className="form-warn form-warn--error" role="alert">
              <span>{saveError}</span>
            </div>
          )}
          <div className="leave-confirm__actions">
            <Button variant="ghost" disabled={saveStatus === 'saving'} onClick={close}>Wróć</Button>
            <Button variant="danger" disabled={saveStatus === 'saving'} onClick={submit}>
              {saveStatus === 'uncertain' ? 'Spróbuj ponownie' : cancellingInvitation ? 'Anuluj zaproszenie' : 'Wyłącz dostęp'}
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  )
}

export function PermissionsAccess({ sectionRef, selectedStaffId, onSelectedStaffIdChange }) {
  const { toast } = useApp()
  const { actor, capabilities, registerLeaveGuard } = useShell()
  const canRead = canPerformAction(capabilities, 'permissions.read')
  const canEdit = canPerformAction(capabilities, 'permissions.edit')
  const [targets, setTargets] = useState([])
  const [targetsStatus, setTargetsStatus] = useState('loading')
  const [authority, setAuthority] = useState(null)
  const [draft, setDraft] = useState(null)
  const [detailStatus, setDetailStatus] = useState('idle')
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const [saveNotice, setSaveNotice] = useState(null)
  const listRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const saveRequestRef = useRef(0)
  const actionRef = useRef(null)
  const selectedStaffIdRef = useRef(selectedStaffId)
  selectedStaffIdRef.current = selectedStaffId
  const selected = targets.find((person) => person.staffId === selectedStaffId) ?? targets[0] ?? null
  const groups = useMemo(
    () => draft ? permissionGroupsFor(draft) : [],
    [draft],
  )
  const dirty = Boolean(authority && draft && (
    !sameOrdered(authority.allow, draft.allow)
    || !sameOrdered(authority.deny, draft.deny)
  ))
  const hasRoleOverrides = Boolean(draft && (draft.allow.length || draft.deny.length))

  const loadTargets = useCallback(async ({ background = false } = {}) => {
    if (!canRead) return false
    const requestId = ++listRequestRef.current
    if (!background) {
      detailRequestRef.current += 1
      actionRef.current = null
      setTargetsStatus('loading')
      setTargets([])
      setAuthority(null)
      setDraft(null)
      setDetailStatus('idle')
      setSaveStatus('idle')
      setSaveError(null)
      setSaveNotice(null)
    }
    try {
      const result = await apiClient.listCapabilityTargets()
      if (listRequestRef.current !== requestId) return false
      setTargets(result.targets)
      setTargetsStatus('ready')
      const nextSelected = result.targets.find((person) => person.staffId === selectedStaffIdRef.current)
        ?? result.targets[0]
      if (nextSelected && nextSelected.staffId !== selectedStaffIdRef.current) {
        onSelectedStaffIdChange(nextSelected.staffId)
      }
      return true
    } catch {
      if (listRequestRef.current !== requestId) return false
      if (!background) setTargetsStatus('error')
      return false
    }
  }, [canRead, onSelectedStaffIdChange])

  const loadAuthority = useCallback(async (staffId) => {
    if (!canRead) return false
    const requestId = ++detailRequestRef.current
    actionRef.current = null
    setAuthority(null)
    setDraft(null)
    setDetailStatus('loading')
    setSaveStatus('idle')
    setSaveError(null)
    setSaveNotice(null)
    try {
      const result = await apiClient.getCapabilityOverrides(staffId)
      if (detailRequestRef.current !== requestId) return false
      if (result.authority.staffId !== staffId) throw new Error('INVALID_RESPONSE')
      setAuthority(result.authority)
      setDraft(permissionDraftFor(result.authority))
      setDetailStatus('ready')
      return true
    } catch {
      if (detailRequestRef.current !== requestId) return false
      setDetailStatus('error')
      return false
    }
  }, [canRead])

  useEffect(() => {
    if (!canRead) return undefined
    const timer = window.setTimeout(() => { void loadTargets() }, 0)
    return () => {
      window.clearTimeout(timer)
      listRequestRef.current += 1
      detailRequestRef.current += 1
      saveRequestRef.current += 1
    }
  }, [canRead, loadTargets])

  useEffect(() => {
    const staffId = selected?.staffId
    if (targetsStatus !== 'ready' || !staffId) return undefined
    const timer = window.setTimeout(() => { void loadAuthority(staffId) }, 0)
    return () => {
      window.clearTimeout(timer)
      detailRequestRef.current += 1
    }
  }, [loadAuthority, selected?.staffId, targetsStatus])

  useEffect(
    () => registerLeaveGuard(() => dirty),
    [dirty, registerLeaveGuard],
  )

  if (!canRead) return null

  const changePermission = (capability, enabled) => {
    if (!draft || saveStatus === 'saving') return
    try {
      setDraft(setPermissionEnabled(draft, capability, enabled))
      actionRef.current = null
      setSaveStatus('idle')
      setSaveError(null)
      setSaveNotice(null)
    } catch {
      setSaveError(PERMISSION_UNKNOWN_ERROR)
      setSaveStatus('error')
    }
  }

  const resetDraft = () => {
    if (!authority || saveStatus === 'saving') return
    actionRef.current = null
    setDraft(permissionDraftFor(authority))
    setSaveStatus('idle')
    setSaveError(null)
    setSaveNotice(null)
  }

  const restoreRoleDefaults = () => {
    if (!draft || saveStatus === 'saving' || !canEdit || targetDisabled) return
    try {
      setDraft(permissionDefaultsFor(draft))
      actionRef.current = null
      setSaveStatus('idle')
      setSaveError(null)
      setSaveNotice(null)
    } catch {
      setSaveError(PERMISSION_UNKNOWN_ERROR)
      setSaveStatus('error')
    }
  }

  const submit = async (event) => {
    event?.preventDefault()
    if (!authority || !draft || !dirty || !canEdit || saveStatus === 'saving'
      || authority.status === 'disabled') return
    let action = actionRef.current
    if (!action) {
      try {
        action = Object.freeze({
          key: apiClient.createIdempotencyKey(),
          staffId: authority.staffId,
          payload: Object.freeze({
            expectedAuthorityRevision: authority.authorityRevision,
            allow: draft.allow,
            deny: draft.deny,
          }),
        })
      } catch {
        setSaveError(PERMISSION_UNKNOWN_ERROR)
        setSaveStatus('error')
        return
      }
      actionRef.current = action
    }

    const requestId = ++saveRequestRef.current
    setSaveStatus('saving')
    setSaveError(null)
    setSaveNotice(null)
    try {
      const result = await apiClient.replaceCapabilityOverrides(
        action.staffId,
        action.payload,
        { idempotencyKey: action.key },
      )
      const selfTarget = action.staffId === actor.id
      if (saveRequestRef.current !== requestId && !selfTarget) return
      actionRef.current = null
      // A self-target mutation changes the mounted actor authority. The API
      // refresh/remount is the only safe publisher for that result.
      toast(`Uprawnienia zostały zapisane · ${result.authority.displayName}`)
      if (selfTarget) return
      setAuthority(result.authority)
      setDraft(permissionDraftFor(result.authority))
      setSaveStatus('saved')
      void loadTargets({ background: true })
    } catch (error) {
      if (saveRequestRef.current !== requestId) return
      const uncertain = error instanceof ApiError && error.idempotencyKey === action.key
      if (uncertain) {
        setSaveError(PERMISSION_UNCERTAIN_ERROR)
        setSaveStatus('uncertain')
        return
      }
      actionRef.current = null
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        const refreshed = await loadAuthority(action.staffId)
        if (refreshed) {
          setSaveNotice('Uprawnienia zmieniły się w międzyczasie. Pobraliśmy aktualną wersję.')
        }
        return
      }
      setSaveError(error instanceof ApiError
        ? PERMISSION_SAVE_ERROR_LABELS[error.code] || PERMISSION_UNKNOWN_ERROR
        : PERMISSION_UNKNOWN_ERROR)
      setSaveStatus('error')
    }
  }

  const targetDisabled = authority?.status === 'disabled'
  const controlsDisabled = !canEdit || targetDisabled || saveStatus === 'saving'

  return (
    <section
      className="settings-section permissions-access"
      aria-labelledby="permissions-access-title"
      ref={sectionRef}
    >
      <div className="staff-access__head">
        <div>
          <h2
            className="settings-section__title"
            id="permissions-access-title"
            tabIndex={-1}
          >
            Uprawnienia personelu
          </h2>
          <p>Zarządzaj zakresem dostępu bez ujawniania danych logowania i zaproszeń.</p>
        </div>
      </div>

      {targetsStatus === 'loading' && (
        <p className="staff-access__state" role="status">Pobieranie listy osób…</p>
      )}
      {targetsStatus === 'error' && (
        <div className="staff-access__state" role="alert">
          <span>Nie udało się pobrać listy osób.</span>
          <Button size="sm" variant="ghost" onClick={loadTargets}>Odśwież listę osób</Button>
        </div>
      )}
      {targetsStatus === 'ready' && targets.length === 0 && (
        <p className="staff-access__state">Brak osób, którym można nadać uprawnienia.</p>
      )}
      {targetsStatus === 'ready' && targets.length > 0 && (
        <div className="card card--pad permissions-access__panel">
          <Field
            label="Osoba"
            hint={dirty ? 'Najpierw zapisz albo odrzuć zmiany, aby wybrać inną osobę.' : undefined}
          >
            <select
              className="select"
              aria-label="Osoba"
              disabled={dirty || saveStatus === 'saving'}
              value={selected?.staffId || ''}
              onChange={(event) => {
                actionRef.current = null
                onSelectedStaffIdChange(event.target.value)
              }}
            >
              {targets.map((person) => (
                <option key={person.staffId} value={person.staffId}>{targetLabel(person)}</option>
              ))}
            </select>
          </Field>

          {detailStatus === 'loading' && (
            <p className="permissions-access__state" role="status">Pobieranie uprawnień…</p>
          )}
          {detailStatus === 'error' && selected && (
            <div className="permissions-access__state" role="alert">
              <span>Nie udało się pobrać uprawnień tej osoby.</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => loadAuthority(selected.staffId)}
              >
                Spróbuj ponownie
              </Button>
            </div>
          )}
          {detailStatus === 'ready' && authority && draft && (
            <form className="permissions-access__editor" onSubmit={submit}>
              <div className="permissions-access__identity">
                <strong>{authority.displayName}</strong>
                <span>{rolePresentationFor(authority)}</span>
                {authority.staffId === actor?.id && (
                  <span>Zmieniasz własne uprawnienia</span>
                )}
                <Pill tone={accessPresentationFor(authority).tone}>
                  {accessPresentationFor(authority).label}
                </Pill>
              </div>
              {targetDisabled && (
                <div className="form-warn" role="status">
                  Ta osoba nie ma dostępu do panelu. Może otrzymać nowe zaproszenie.
                </div>
              )}
              {!targetDisabled && (
                <>
                  <fieldset className="permissions-access__choices" disabled={saveStatus === 'saving'}>
                    <legend>Zakres dostępu</legend>
                    <div className="permissions-choice">
                      <span>
                        <strong>Dostęp podstawowy: grafik, klienci i sesje</strong>
                        <small>
                          {authority.role === 'specialist'
                            ? 'Ta osoba widzi tylko własny Grafik, klientów i sesje.'
                            : 'Ta osoba widzi Grafik, klientów i sesje całej poradni.'}
                        </small>
                      </span>
                    </div>
                    {hasRoleOverrides && (
                      <div className="form-warn permissions-access__role-warning" role="status">
                        <span>
                          <strong>Uprawnienia odbiegają od roli</strong>
                          <small>Przywrócenie usunie dodatkowe wyjątki dla tej osoby.</small>
                        </span>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          disabled={controlsDisabled}
                          onClick={restoreRoleDefaults}
                        >
                          Przywróć ustawienia roli
                        </Button>
                      </div>
                    )}
                    {groups.filter((group) => group.choices.length > 0).map((group) => (
                      <fieldset className="permissions-access__group" key={group.title}>
                        <legend>Może: {group.title}</legend>
                        {group.choices.map((choice) => {
                          const copy = permissionCopyFor(choice)
                          return (
                            <div className="permissions-choice" key={choice.capability}>
                              <span>
                                <strong>{copy.label}</strong>
                                <small>
                                  {choice.locked
                                    ? 'Wymagane dla aktywnej właścicielki'
                                    : copy.effect}
                                </small>
                              </span>
                              <Toggle
                                label={copy.label}
                                on={choice.enabled}
                                disabled={controlsDisabled || choice.locked}
                                onChange={(enabled) => changePermission(choice.capability, enabled)}
                              />
                            </div>
                          )
                        })}
                      </fieldset>
                    ))}
                  </fieldset>
                  {saveError && (
                    <div className="form-warn form-warn--error" role="alert">{saveError}</div>
                  )}
                  {saveNotice && (
                    <div className="form-warn" role="status">{saveNotice}</div>
                  )}
                  <div className="permissions-access__actions">
                    <span className="settings-save__status" role="status" aria-live="polite">
                      {saveStatus === 'saving'
                        ? 'Zapisywanie…'
                        : dirty ? 'Niezapisane zmiany' : ''}
                    </span>
                    {dirty && (
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        disabled={saveStatus === 'saving'}
                        onClick={resetDraft}
                      >
                        Odrzuć zmiany
                      </Button>
                    )}
                    <Button
                      size="sm"
                      type="submit"
                      disabled={!dirty || controlsDisabled}
                    >
                      {saveStatus === 'uncertain' ? 'Spróbuj ponownie' : 'Zapisz uprawnienia'}
                    </Button>
                  </div>
                </>
              )}
            </form>
          )}
        </div>
      )}
    </section>
  )
}

export function StaffAccess({ sectionRef }) {
  const { toast } = useApp()
  const { session } = useAuth()
  const { actor, capabilities, registerLeaveGuard } = useShell()
  const canInvite = canPerformAction(capabilities, 'staff.invite')
  const canChangeRole = actor?.role === 'owner'
    && canPerformAction(capabilities, 'staff.role.edit')
  const canDeactivate = canPerformAction(capabilities, 'staff.deactivate')
  const canManagePermissions = canPerformAction(capabilities, 'permissions.read')
  const [staff, setStaff] = useState([])
  const [loadStatus, setLoadStatus] = useState('loading')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [roleChange, setRoleChange] = useState(null)
  const [deactivation, setDeactivation] = useState(null)
  const requestRef = useRef(0)
  const requestInFlightRef = useRef(null)
  const inviteDirtyRef = useRef(false)
  const roleDirtyRef = useRef(false)
  const headingRef = useRef(null)
  const setInviteDirty = useCallback((dirty) => {
    inviteDirtyRef.current = dirty
  }, [])
  const setRoleDirty = useCallback((dirty) => {
    roleDirtyRef.current = dirty
  }, [])

  const loadStaff = useCallback(async ({ background = false } = {}) => {
    if (background && requestInFlightRef.current !== null) return false
    const requestId = ++requestRef.current
    requestInFlightRef.current = requestId
    if (!background) setLoadStatus('loading')
    try {
      const result = await apiClient.listStaff()
      if (requestRef.current !== requestId) return false
      setStaff(result.staff)
      setLoadStatus('ready')
      return true
    } catch {
      if (requestRef.current !== requestId) return false
      if (background) return false
      setStaff([])
      setLoadStatus('error')
      return false
    } finally {
      if (requestInFlightRef.current === requestId) requestInFlightRef.current = null
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStaff()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      requestRef.current += 1
      requestInFlightRef.current = null
    }
  }, [loadStaff])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadStaff({ background: true })
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const interval = window.setInterval(refresh, 15_000)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.clearInterval(interval)
    }
  }, [loadStaff])

  useEffect(
    () => registerLeaveGuard(() => inviteDirtyRef.current || roleDirtyRef.current),
    [registerLeaveGuard],
  )

  const clearForbidden = () => {
    requestRef.current += 1
    requestInFlightRef.current = null
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
          {canInvite && (
            <Button icon="plus" size="sm" onClick={() => setInviteOpen(true)}>Zaproś do panelu</Button>
          )}
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
            {staff.map((person) => {
              const access = accessPresentationFor(person)
              return (
                <li className="staff-access-row" key={person.id}>
                <div className="staff-access-row__identity">
                  <strong className="staff-access-row__name">{person.displayName}</strong>
                  <span className="staff-access-row__email">{person.email}</span>
                </div>
                <div className="staff-access-row__details">
                  <span>{rolePresentationFor(person)}</span>
                  <Pill tone={access.tone}>
                    {access.label}
                  </Pill>
                  {person.id === actor?.id ? (
                    <span>To Ty</span>
                  ) : canChangeRole && (
                    <Button
                      icon="edit"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRoleChange(person)}
                    >Zmień rolę</Button>
                  )}
                  {canManagePermissions && (
                    <EntityLink
                      route="team"
                      params={{ section: 'permissions', staffId: person.id }}
                      className="btn btn--ghost btn--sm"
                    >
                      Uprawnienia
                    </EntityLink>
                  )}
                  {person.id !== actor?.id && canDeactivate && access.action === 'deactivate' && (
                    <Button
                      icon="logout"
                      size="sm"
                      variant="danger"
                      onClick={() => setDeactivation(person)}
                    >Wyłącz dostęp</Button>
                  )}
                  {person.id !== actor?.id && canDeactivate && access.action === 'cancel' && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setDeactivation(person)}
                    >Anuluj zaproszenie</Button>
                  )}
                  {person.id !== actor?.id && canInvite && access.action === 'reinvite' && (
                    <Button
                      size="sm"
                      variant="soft"
                      onClick={() => setInviteOpen(person)}
                    >Zaproś ponownie</Button>
                  )}
                </div>
                {person.invitation && (
                  <div className="staff-access-row__invitation">
                    <span>Ważne do {expiryLabel(person.invitation.expiresAt)}</span>
                  </div>
                )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      {canInvite && inviteOpen && (
        <InvitationDrawer
          environment={session.environment}
          initialPerson={inviteOpen === true ? null : inviteOpen}
          onChanged={loadStaff}
          onClose={() => setInviteOpen(false)}
          onDirtyChange={setInviteDirty}
          onForbidden={clearForbidden}
        />
      )}
      {canChangeRole && roleChange && (
        <RoleChangeDrawer
          fallbackRef={headingRef}
          onChanged={loadStaff}
          onClose={() => setRoleChange(null)}
          onDirtyChange={setRoleDirty}
          onForbidden={clearForbidden}
          person={roleChange}
        />
      )}
      {canDeactivate && deactivation && (
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
