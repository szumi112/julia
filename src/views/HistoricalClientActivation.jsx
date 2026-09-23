import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useApp,
  useClientMutationLock,
  useWorkspaceRefresh,
} from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useDrawerFX } from '../anim.js'
import {
  Button,
  DiscardConfirm,
  Field,
  IconBtn,
  useDiscardGuard,
} from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { ApiError } from '../api.js'
import { canPerformAction } from '../capability-access.js'
import { EntityLink } from '../ux-patterns.jsx'
import { sortProfessionalDirectory } from '../historical-workspace-view.js'
import { conflictCopy, loadFailureCopy, saveFailureCopy } from '../save-failure-copy.js'
import { isAssignableSpecialist } from '../specialist-eligibility.js'

export function HistoricalClientActivation({ historicalClient, workspaceRange, onClose }) {
  const { state, toast, workspace } = useApp()
  const { locked: clientMutationLocked } = useClientMutationLock()
  const refreshWorkspace = useWorkspaceRefresh()
  const { capabilities, navigate, registerLeaveGuard, role } = useShell()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const [specialistId, setSpecialistId] = useState('')
  const [fieldError, setFieldError] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [saving, setSaving] = useState(false)
  const current = state.historicalClients.find(({ id }) => id === historicalClient.id)
    ?? historicalClient
  const specialists = useMemo(
    () => sortProfessionalDirectory(state.psychologists.filter(isAssignableSpecialist)),
    [state.psychologists],
  )
  const dirty = specialistId !== ''
  const discardGuard = useDiscardGuard(dirty)
  const { close, forceClose, shake } = useDrawerFX(
    drawerRef, backRef, onClose, discardGuard.guard,
  )
  useEffect(
    () => registerLeaveGuard(discardGuard.check),
    [discardGuard.check, registerLeaveGuard],
  )

  const eligible = role.scope === 'centre'
    && ['owner', 'coordinator'].includes(role.id)
    && canPerformAction(capabilities, 'client.historical.activate')
  const alreadyActivated = current.status === 'activated' || current.activeClientId !== null

  const selectSpecialist = (value) => {
    setSpecialistId(value)
    setFieldError(null)
    setSaveError(null)
  }

  const submit = async (event) => {
    event?.preventDefault()
    if (!specialistId) {
      setFieldError('Wybierz specjalistkę')
      shake()
      return
    }
    if (!eligible || alreadyActivated || clientMutationLocked || saving) return
    setSaving(true)
    setSaveError(null)
    let commandAccepted = false
    let activeClientId = null
    try {
      const result = await workspace.activateHistoricalClient(current.id, {
        expectedVersion: current.version,
        specialistId,
      })
      commandAccepted = true
      activeClientId = result?.client?.id ?? null
      await refreshWorkspace(workspaceRange)
    } catch (error) {
      if (error?.code === 'WORKSPACE_AUTHORITY_STALE'
        || error?.code === 'SESSION_AUTHORITY_STALE') return
      if (commandAccepted) {
        forceClose()
        toast('Klient został dodany do kartoteki, ale nie udało się odświeżyć listy.', 'alert')
        return
      }
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        try {
          await refreshWorkspace(workspaceRange)
          setSaveError(`${conflictCopy('dane tego klienta')} Sprawdź aktualne dane i spróbuj ponownie.`)
        } catch {
          setSaveError(`${conflictCopy('dane tego klienta')} ${loadFailureCopy('aktualnych danych')}`)
        }
      } else {
        const copy = saveFailureCopy(error)
        setSaveError(copy.startsWith('Nie udało się zapisać')
          ? 'Nie udało się dodać klienta do kartoteki. Spróbuj ponownie za chwilę.'
          : copy)
      }
      setSaving(false)
      return
    }
    toast(`Klient został dodany do kartoteki · ${current.name}`, 'check', activeClientId ? {
      label: 'Otwórz kartę',
      onClick: () => navigate('client', { id: activeClientId }),
    } : undefined)
    forceClose()
  }

  return (
    <>
      <div className="drawer-backdrop" ref={backRef} onClick={close} />
      <aside
        className="drawer historical-activation"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Dodaj klienta z dawnego arkusza"
      >
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">Dodaj do bieżącej kartoteki</h2>
            <p className="drawer__sub">
              {current.name} · Utworzymy nową kartę klienta. Historia z arkusza zostanie bez zmian.
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>
        <form className="drawer__body" onSubmit={submit} noValidate>
          <Field
            label="Specjalistka prowadząca"
            error={fieldError}
            hint="Wybierz, kto będzie teraz prowadzić tę osobę."
          >
            <select
              className="select"
              value={specialistId}
              onChange={(event) => selectSpecialist(event.target.value)}
              disabled={alreadyActivated || saving}
            >
              <option value="">— wybierz specjalistkę —</option>
              {specialists.map((specialist) => (
                <option key={specialist.id} value={specialist.id}>{specialist.name}</option>
              ))}
            </select>
          </Field>
          {saveError && (
            <div className="form-warn form-warn--error" role="alert">
              <Icon name="alert" size={15} />
              <span>{saveError}</span>
            </div>
          )}
          {alreadyActivated && current.activeClientId && (
            <div className="form-warn" role="alert">
              <span>Klient został już dodany do bieżącej kartoteki.</span>
              <EntityLink route="client" params={{ id: current.activeClientId }} className="link">
                Otwórz aktywną kartę
              </EntityLink>
            </div>
          )}
        </form>
        {discardGuard.confirming && (
          <DiscardConfirm onStay={discardGuard.hide} onDiscard={forceClose} />
        )}
        <div className="drawer__foot">
          <Button
            variant="primary"
            onClick={submit}
            disabled={!eligible || alreadyActivated || clientMutationLocked || saving}
          >
            Dodaj do kartoteki
          </Button>
          <Button variant="ghost" onClick={close}>Anuluj</Button>
        </div>
      </aside>
    </>
  )
}
