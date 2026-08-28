import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ApiError, apiClient } from '../api.js'
import { useDrawerFX } from '../anim.js'
import { canPerformAction } from '../capability-access.js'
import {
  permissionChoicesFor,
  setPermissionEnabled,
} from '../permission-overrides.js'
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
const sameOrdered = (left, right) => left.length === right.length
  && left.every((value, index) => value === right[index])
const targetLabel = (person) => (
  `${person.displayName} — ${labelFor(ROLE_LABELS, person.role, UNKNOWN_ROLE)}`
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
          <Field
            label="Rola"
            hint="Zmiana roli może natychmiast zmienić zakres dostępu tej osoby."
          >
            <select
              className="select"
              autoFocus
              disabled={saveStatus === 'saving'}
              value={role}
              onChange={(event) => changeRole(event.target.value)}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
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

export function PermissionsAccess({ sectionRef }) {
  const { toast } = useApp()
  const { actor, capabilities, registerLeaveGuard } = useShell()
  const canRead = canPerformAction(capabilities, 'permissions.read')
  const canEdit = canPerformAction(capabilities, 'permissions.edit')
  const [targets, setTargets] = useState([])
  const [targetsStatus, setTargetsStatus] = useState('loading')
  const [selectedIndex, setSelectedIndex] = useState(0)
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
  const selected = targets[selectedIndex] ?? null
  const choices = useMemo(
    () => draft ? permissionChoicesFor(draft) : [],
    [draft],
  )
  const dirty = Boolean(authority && draft && (
    !sameOrdered(authority.allow, draft.allow)
    || !sameOrdered(authority.deny, draft.deny)
  ))

  const loadTargets = useCallback(async () => {
    if (!canRead) return false
    const requestId = ++listRequestRef.current
    detailRequestRef.current += 1
    actionRef.current = null
    setTargetsStatus('loading')
    setTargets([])
    setSelectedIndex(0)
    setAuthority(null)
    setDraft(null)
    setDetailStatus('idle')
    setSaveStatus('idle')
    setSaveError(null)
    setSaveNotice(null)
    try {
      const result = await apiClient.listCapabilityTargets()
      if (listRequestRef.current !== requestId) return false
      setTargets(result.targets)
      setTargetsStatus('ready')
      return true
    } catch {
      if (listRequestRef.current !== requestId) return false
      setTargetsStatus('error')
      return false
    }
  }, [canRead])

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
    if (targetsStatus !== 'ready' || !selected) return undefined
    const timer = window.setTimeout(() => { void loadAuthority(selected.staffId) }, 0)
    return () => {
      window.clearTimeout(timer)
      detailRequestRef.current += 1
    }
  }, [loadAuthority, selected, targetsStatus])

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
      if (saveRequestRef.current !== requestId) return
      actionRef.current = null
      // A self-target mutation changes the mounted actor authority. The API
      // refresh/remount is the only safe publisher for that result.
      if (action.staffId === actor.id) return
      setAuthority(result.authority)
      setDraft(permissionDraftFor(result.authority))
      setSaveStatus('saved')
      toast('Uprawnienia zostały zapisane.')
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
              value={String(selectedIndex)}
              onChange={(event) => {
                actionRef.current = null
                setSelectedIndex(Number(event.target.value))
              }}
            >
              {targets.map((person, index) => (
                <option key={person.staffId} value={String(index)}>{targetLabel(person)}</option>
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
                <span>{labelFor(ROLE_LABELS, authority.role, UNKNOWN_ROLE)}</span>
                <Pill tone={STAFF_STATUS_TONES[authority.status] || 'ink'}>
                  {labelFor(STAFF_STATUS_LABELS, authority.status, UNKNOWN_STATE)}
                </Pill>
              </div>
              {targetDisabled && (
                <div className="form-warn" role="status">
                  Dostęp tej osoby jest wyłączony. Uprawnienia są tylko do odczytu.
                </div>
              )}
              <fieldset className="permissions-access__choices" disabled={saveStatus === 'saving'}>
                <legend>Zakres dostępu</legend>
                {choices.map((choice) => (
                  <label className="permissions-choice" key={choice.capability}>
                    <span>
                      <strong>{choice.label}</strong>
                      <small>
                        {choice.locked
                          ? 'Wymagane dla aktywnego właściciela'
                          : choice.defaultEnabled ? 'Domyślne dla tej roli' : 'Dodatkowe dla tej roli'}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      aria-label={choice.label}
                      checked={choice.enabled}
                      disabled={controlsDisabled || choice.locked}
                      onChange={(event) => changePermission(choice.capability, event.target.checked)}
                    />
                  </label>
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
                    : saveStatus === 'saved' ? 'Zapisano' : dirty ? 'Niezapisane zmiany' : ''}
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
            </form>
          )}
        </div>
      )}
    </section>
  )
}

export function StaffAccess({ sectionRef }) {
  const { toast } = useApp()
  const { actor, capabilities, registerLeaveGuard } = useShell()
  const canInvite = canPerformAction(capabilities, 'staff.invite')
  const canChangeRole = actor?.role === 'owner'
    && canPerformAction(capabilities, 'staff.role.edit')
  const canDeactivate = canPerformAction(capabilities, 'staff.deactivate')
  const [staff, setStaff] = useState([])
  const [loadStatus, setLoadStatus] = useState('loading')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [roleChange, setRoleChange] = useState(null)
  const [deactivation, setDeactivation] = useState(null)
  const requestRef = useRef(0)
  const inviteDirtyRef = useRef(false)
  const roleDirtyRef = useRef(false)
  const headingRef = useRef(null)
  const setInviteDirty = useCallback((dirty) => {
    inviteDirtyRef.current = dirty
  }, [])
  const setRoleDirty = useCallback((dirty) => {
    roleDirtyRef.current = dirty
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
    () => registerLeaveGuard(() => inviteDirtyRef.current || roleDirtyRef.current),
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
          {canInvite && (
            <Button icon="plus" size="sm" onClick={() => setInviteOpen(true)}>Zaproś osobę</Button>
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
                  {canChangeRole && (
                    <IconBtn
                      name="edit"
                      label={`Zmień rolę — ${person.displayName}`}
                      onClick={() => setRoleChange(person)}
                    />
                  )}
                  {canDeactivate && person.status !== 'disabled' && (
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
      {canInvite && inviteOpen && (
        <InvitationDrawer
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
