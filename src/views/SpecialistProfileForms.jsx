import { useEffect, useRef, useState } from 'react'
import { ApiError, apiClient } from '../api.js'
import { Button, DiscardConfirm, Field, IconBtn, useDiscardGuard } from '../ui.jsx'

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
        {children({ requestClose })}
        {discard.confirming ? (
          <DiscardConfirm onStay={discard.hide} onDiscard={onClose} />
        ) : null}
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
  const initialName = profile?.name ?? ''
  const initialProfessionalTitle = profile?.professionalTitle ?? 'Specjalistka'
  const initialRate = profile ? String(profile.rate).replace('.', ',') : '180'
  const [displayName, setDisplayName] = useState(initialName)
  const [professionalTitle, setProfessionalTitle] = useState(initialProfessionalTitle)
  const [rate, setRate] = useState(initialRate)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const dirty = displayName !== initialName
    || professionalTitle !== initialProfessionalTitle || rate !== initialRate
  const submit = async (event) => {
    event.preventDefault()
    const name = displayName.trim().normalize('NFC')
    const title = professionalTitle.trim().normalize('NFC')
    const canonicalRate = rate.trim().replace(',', '.')
    const amount = Number(canonicalRate)
    if (!name || !title || INVALID_TITLE.test(title)
      || TEXT_ENCODER.encode(title).byteLength > 120
      || !/^\d{1,5}(?:\.\d{1,2})?$/.test(canonicalRate)
      || !Number.isFinite(amount) || amount <= 0 || amount > 10000) {
      setError('Podaj imię i nazwisko, tytuł zawodowy oraz poprawną stawkę.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const input = {
        displayName: name,
        professionalTitle: title,
        standardRateGrosze: Math.round(amount * 100),
      }
      const options = { idempotencyKey: apiClient.createIdempotencyKey() }
      if (profile) await apiClient.updateSpecialistProfile(
        profile.id, profile.version, input, options,
      )
      else await apiClient.createSpecialistProfile(input, options)
      await onSaved()
      onClose()
    } catch (caught) {
      setError(errorText(caught))
      setSaving(false)
    }
  }
  return (
    <ModalShell dirty={dirty} label={profile ? 'Edytuj profil specjalistki' : 'Dodaj profil specjalistki'} onClose={onClose}>
      {({ requestClose }) => (
        <>
          <div className="drawer__head">
            <div>
              <h2 className="drawer__title">{profile ? 'Edytuj specjalistkę' : 'Dodaj specjalistkę'}</h2>
              <p className="drawer__sub">{profile
                ? 'Zmiana danych nie zmieni przypisanych klientów ani dostępu.'
                : 'Profil powstanie bez konta i adresu e-mail.'}</p>
            </div>
            <IconBtn name="close" label="Zamknij" onClick={requestClose} />
          </div>
          <form className="drawer__body" onSubmit={submit}>
            <Field label="Imię i nazwisko">
              <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoFocus />
            </Field>
            <Field label="Tytuł zawodowy">
              <input className="input" value={professionalTitle} onChange={(event) => setProfessionalTitle(event.target.value)} />
            </Field>
            <Field label="Stawka za sesję (zł)">
              <input className="input" inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
            </Field>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <div className="drawer__actions">
              <Button variant="ghost" onClick={requestClose} disabled={saving}>Anuluj</Button>
              <Button type="submit" disabled={saving}>{saving
                ? 'Zapisywanie…' : profile ? 'Zapisz zmiany' : 'Dodaj profil'}</Button>
            </div>
          </form>
        </>
      )}
    </ModalShell>
  )
}

export function SpecialistAccessForm({ profile, onClose, onSaved }) {
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState(null)
  const actionRef = useRef(null)
  const changeEmail = (value) => {
    setEmail(value)
    setError(null)
    setUncertain(false)
    actionRef.current = null
  }
  const submit = async (event) => {
    event.preventDefault()
    const canonical = email.trim().toLowerCase().normalize('NFC')
    if (!EMAIL.test(canonical)) {
      setError('Podaj poprawny adres e-mail.')
      return
    }
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
    try {
      await apiClient.inviteSpecialistProfile(
        profile.id,
        action.payload,
        { idempotencyKey: action.idempotencyKey },
      )
      await onSaved()
      onClose()
    } catch (caught) {
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
    <ModalShell dirty={email !== ''} label={`Aktywuj dostęp — ${profile.name}`} onClose={onClose}>
      {({ requestClose }) => (
        <>
          <div className="drawer__head">
            <div>
              <h2 className="drawer__title">Aktywuj dostęp</h2>
              <p className="drawer__sub">{profile.name} otrzyma zaproszenie na podany adres.</p>
            </div>
            <IconBtn name="close" label="Zamknij" onClick={requestClose} />
          </div>
          <form className="drawer__body" onSubmit={submit}>
            <Field label="Adres e-mail">
              <input className="input" type="email" value={email} onChange={(event) => changeEmail(event.target.value)} autoComplete="email" autoFocus />
            </Field>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <div className="drawer__actions">
              <Button variant="ghost" onClick={requestClose} disabled={saving}>Anuluj</Button>
              <Button type="submit" disabled={saving}>{saving
                ? 'Wysyłanie…' : uncertain ? 'Spróbuj ponownie' : 'Wyślij zaproszenie'}</Button>
            </div>
          </form>
        </>
      )}
    </ModalShell>
  )
}
