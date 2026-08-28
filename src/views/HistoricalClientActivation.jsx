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

export function HistoricalClientActivation({ historicalClient, workspaceRange, onClose }) {
  const { state, toast, workspace } = useApp()
  const { locked: clientMutationLocked } = useClientMutationLock()
  const refreshWorkspace = useWorkspaceRefresh()
  const { capabilities, registerLeaveGuard, role } = useShell()
  const drawerRef = useRef(null)
  const backRef = useRef(null)
  const [specialistId, setSpecialistId] = useState('')
  const [fieldError, setFieldError] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [saving, setSaving] = useState(false)
  const current = state.historicalClients.find(({ id }) => id === historicalClient.id)
    ?? historicalClient
  const specialists = useMemo(
    () => sortProfessionalDirectory(state.psychologists.filter(({ status }) => status === 'active')),
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
    try {
      await workspace.activateHistoricalClient(current.id, {
        expectedVersion: current.version,
        specialistId,
      })
      commandAccepted = true
      await refreshWorkspace(workspaceRange)
    } catch (error) {
      if (error?.code === 'WORKSPACE_AUTHORITY_STALE'
        || error?.code === 'SESSION_AUTHORITY_STALE') return
      if (commandAccepted) {
        forceClose()
        toast('Aktywację przyjęto, ale nie udało się odświeżyć kartoteki.', 'alert')
        return
      }
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        try {
          await refreshWorkspace(workspaceRange)
          setSaveError('Profil zmienił się w innym oknie. Sprawdź odświeżone dane przed ponowieniem.')
        } catch {
          setSaveError('Wykryto konflikt wersji i nie udało się odświeżyć profilu.')
        }
      } else {
        setSaveError('Nie udało się aktywować klienta. Spróbuj ponownie.')
      }
      setSaving(false)
      return
    }
    toast('Klient historyczny został aktywowany')
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
        aria-label="Aktywuj klienta historycznego"
      >
        <div className="drawer__head">
          <div>
            <h2 className="drawer__title">Aktywuj klienta</h2>
            <p className="drawer__sub">
              {current.name} · profil ze skoroszytu pozostaje niezmieniony<br />
              Wersja źródła: {current.version}
            </p>
          </div>
          <IconBtn name="close" label="Zamknij" onClick={close} />
        </div>
        <form className="drawer__body" onSubmit={submit} noValidate>
          <p className="faint">
            Aktywacja tworzy odrębną bieżącą kartę. Wybierz osobę prowadzącą bez domyślnego przypisania z historii.
          </p>
          <Field label="Specjalistka prowadząca" error={fieldError}>
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
              <span>Profil został już aktywowany.</span>
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
            Aktywuj klienta
          </Button>
          <Button variant="ghost" onClick={close}>Anuluj</Button>
        </div>
      </aside>
    </>
  )
}
