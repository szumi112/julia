import { useEffect, useRef, useState } from 'react'
import { ApiError, apiClient } from '../api.js'
import { useApp } from '../store.jsx'
import { Button, DiscardConfirm, Field, IconBtn, SpecialistAvatarPicker, useDiscardGuard } from '../ui.jsx'
import { DEFAULT_SPECIALIST_AVATAR_KEY } from '../specialist-avatars.js'
import { rolePresentationFor } from '../auth-role.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const INVALID_TITLE = /[\p{Cc}\p{Cf}]/u
const TEXT_ENCODER = new TextEncoder()

function ModalShell({ children, dirty, label, onClose }) {
  const dialogRef = useRef(null)
  const discard = useDiscardGuard(dirty)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])
  const requestClose = () => {
    if (discard.guard()) onClose()
  }
  return (
    <dialog
      className="modal-layer"
      ref={dialogRef}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault()
        requestClose()
      }}
    >
      <div className="drawer-backdrop" onClick={requestClose} />
      <aside className="drawer">
        {children({ discard, requestClose })}
      </aside>
    </dialog>
  )
}

const errorText = (error) => error instanceof ApiError && error.code === 'FORBIDDEN'
  ? 'Nie masz uprawnień do tej operacji.'
  : error instanceof ApiError && error.code === 'STAFF_INVITATION_CONFLICT'
    ? 'Ten profil ma już przypisane zaproszenie lub konto.'
    : 'Nie udało się zapisać zmian. Spróbuj ponownie.'
const SPECIALIST_INVITATION_UNCERTAIN = 'Nie wiadomo, czy zaproszenie zostało utworzone. Spróbuj ponownie bez zmiany adresu e-mail.'

export function SpecialistProfileForm({ onClose, onSaved, profile = null }) {
  const { toast } = useApp()
  const initialName = profile?.name ?? ''
  const initialProfessionalTitle = profile?.professionalTitle ?? 'Specjalistka'
  const initialRate = profile ? String(profile.rate).replace('.', ',') : '180'
  const initialAvatarKey = profile?.avatarKey ?? DEFAULT_SPECIALIST_AVATAR_KEY
  const [displayName, setDisplayName] = useState(initialName)
  const [professionalTitle, setProfessionalTitle] = useState(initialProfessionalTitle)
  const [rate, setRate] = useState(initialRate)
  const [avatarKey, setAvatarKey] = useState(initialAvatarKey)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [errors, setErrors] = useState({})
  const dirty = displayName !== initialName
    || professionalTitle !== initialProfessionalTitle || rate !== initialRate
    || avatarKey !== initialAvatarKey
  const submit = async (event) => {
    event.preventDefault()
    const name = displayName.trim().normalize('NFC')
    const title = professionalTitle.trim().normalize('NFC')
    const canonicalRate = rate.trim().replace(',', '.')
    const amount = Number(canonicalRate)
    const nextErrors = {
      displayName: name ? null : 'Wpisz imię i nazwisko.',
      professionalTitle: title && !INVALID_TITLE.test(title)
        && TEXT_ENCODER.encode(title).byteLength <= 120
        ? null : 'Wpisz tytuł, np. psycholożka.',
      rate: /^\d{1,5}(?:\.\d{1,2})?$/.test(canonicalRate)
        && Number.isFinite(amount) && amount > 0 && amount <= 10000
        ? null : 'Wpisz stawkę, np. 180.',
    }
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) {
      return
    }
    setSaving(true)
    setError(null)
    let accepted = false
    try {
      const input = {
        displayName: name,
        professionalTitle: title,
        standardRateGrosze: Math.round(amount * 100),
        avatarKey,
      }
      const options = { idempotencyKey: apiClient.createIdempotencyKey() }
      if (profile) await apiClient.updateSpecialistProfile(
        profile.id, profile.version, input, options,
      )
      else await apiClient.createSpecialistProfile(input, options)
      accepted = true
      await onSaved()
      toast(profile ? `Dane specjalistki zostały zapisane: ${name}` : `${name} dodana do zespołu`)
      onClose()
    } catch (caught) {
      if (accepted) {
        toast(profile ? `Dane specjalistki zostały zapisane: ${name}` : `${name} dodana do zespołu`)
        toast('Nie udało się odświeżyć listy zespołu. Odśwież stronę.', 'alert')
        onClose()
        return
      }
      setError(errorText(caught))
      setSaving(false)
    }
  }
  return (
    <ModalShell dirty={dirty} label={profile ? 'Edytuj profil specjalistki' : 'Dodaj profil specjalistki'} onClose={onClose}>
      {({ discard, requestClose }) => (
        <>
          <div className="drawer__head">
            <div>
              <h2 className="drawer__title">{profile ? 'Edytuj specjalistkę' : 'Dodaj specjalistkę'}</h2>
              <p className="drawer__sub">{profile
                ? 'Klienci i dostęp do panelu pozostaną bez zmian.'
                : 'Klientów i sesje przypiszesz jej, gdy przyjmie zaproszenie do panelu.'}</p>
            </div>
            <IconBtn name="close" label="Zamknij" onClick={requestClose} />
          </div>
          <form className="drawer__body" id="specialist-profile-form" onSubmit={submit} noValidate>
            <Field label="Imię i nazwisko" error={errors.displayName}>
              <input className="input" value={displayName} onChange={(event) => {
                setDisplayName(event.target.value)
                setErrors((current) => ({ ...current, displayName: null }))
              }} autoFocus />
            </Field>
            <Field label="Tytuł zawodowy" error={errors.professionalTitle}>
              <input className="input" value={professionalTitle} onChange={(event) => {
                setProfessionalTitle(event.target.value)
                setErrors((current) => ({ ...current, professionalTitle: null }))
              }} />
            </Field>
            <Field label="Stawka za sesję (zł)" error={errors.rate}>
              <input className="input" inputMode="decimal" value={rate} onChange={(event) => {
                setRate(event.target.value)
                setErrors((current) => ({ ...current, rate: null }))
              }} />
            </Field>
            <SpecialistAvatarPicker value={avatarKey} onChange={setAvatarKey} />
            {error ? <div className="form-warn form-warn--error" role="alert"><span>{error}</span></div> : null}
          </form>
          {discard.confirming ? (
            <DiscardConfirm onStay={discard.hide} onDiscard={onClose} />
          ) : null}
          <div className="drawer__foot">
            <Button type="submit" form="specialist-profile-form" disabled={saving}>{saving
              ? 'Zapisywanie…' : profile ? 'Zapisz zmiany' : 'Dodaj specjalistkę'}</Button>
            <Button variant="ghost" onClick={requestClose} disabled={saving}>Zamknij</Button>
          </div>
        </>
      )}
    </ModalShell>
  )
}

export function SpecialistAccessForm({ profile, onClose, onSaved }) {
  const { toast } = useApp()
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState(null)
  const actionRef = useRef(null)
  const changeEmail = (value) => {
    setEmail(value)
    setEmailError(null)
    setError(null)
    setUncertain(false)
    actionRef.current = null
  }
  const submit = async (event) => {
    event.preventDefault()
    const canonical = email.trim().toLowerCase().normalize('NFC')
    if (!EMAIL.test(canonical)) {
      setEmailError('Podaj poprawny adres e-mail.')
      return
    }
    setEmailError(null)
    let action = actionRef.current
    if (!action) {
      try {
        action = Object.freeze({
          idempotencyKey: apiClient.createIdempotencyKey(),
          payload: Object.freeze({
            email: canonical,
            expectedVersion: profile.version,
          }),
        })
      } catch (caught) {
        setError(errorText(caught))
        return
      }
      actionRef.current = action
    }
    setSaving(true)
    setUncertain(false)
    setError(null)
    let accepted = false
    try {
      await apiClient.inviteSpecialistProfile(
        profile.id,
        action.payload,
        { idempotencyKey: action.idempotencyKey },
      )
      accepted = true
      await onSaved()
      toast(`Zaproszenie wysłane na ${canonical}`)
      onClose()
    } catch (caught) {
      if (accepted) {
        toast(`Zaproszenie wysłane na ${canonical}`)
        toast('Nie udało się odświeżyć listy zespołu. Odśwież stronę.', 'alert')
        onClose()
        return
      }
      if (caught instanceof ApiError
        && caught.idempotencyKey === action.idempotencyKey) {
        setError(SPECIALIST_INVITATION_UNCERTAIN)
        setUncertain(true)
        setSaving(false)
        return
      }
      actionRef.current = null
      setError(errorText(caught))
      setSaving(false)
    }
  }
  return (
    <ModalShell dirty={email !== ''} label={`Zaproś do panelu — ${profile.name}`} onClose={onClose}>
      {({ discard, requestClose }) => (
        <>
          <div className="drawer__head">
            <div>
              <h2 className="drawer__title">Zaproś do panelu</h2>
              <p className="drawer__sub">{profile.name} · {rolePresentationFor({
                role: 'specialist', professionalTitle: profile.professionalTitle,
              })}</p>
            </div>
            <IconBtn name="close" label="Zamknij" onClick={requestClose} />
          </div>
          <form className="drawer__body" id="specialist-access-form" onSubmit={submit} noValidate>
            <Field label="Adres e-mail" error={emailError} hint="Na ten adres wyślemy link do panelu.">
              <input className="input" type="email" value={email} onChange={(event) => changeEmail(event.target.value)} autoComplete="email" autoFocus />
            </Field>
            {error ? <div className="form-warn form-warn--error" role="alert"><span>{error}</span></div> : null}
          </form>
          {discard.confirming ? (
            <DiscardConfirm onStay={discard.hide} onDiscard={onClose} />
          ) : null}
          <div className="drawer__foot">
            <Button type="submit" form="specialist-access-form" disabled={saving}>{saving
              ? 'Wysyłanie…' : uncertain ? 'Spróbuj ponownie' : 'Zaproś do panelu'}</Button>
            <Button variant="ghost" onClick={requestClose} disabled={saving}>Zamknij</Button>
          </div>
        </>
      )}
    </ModalShell>
  )
}
