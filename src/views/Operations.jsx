import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ApiError, apiClient } from '../api.js'
import { canPerformAction } from '../capability-access.js'
import {
  backupFreshnessState,
  currentOperationalActions,
  operationalActionCommand,
  operationsSummary,
  relInstantLabel,
} from '../operations-view.js'
import { useShell } from '../shell-ctx.js'
import { useApp } from '../store.jsx'
import { Button } from '../ui.jsx'
import { EntityLink } from '../ux-patterns.jsx'
import { BACKUP_FAILURE_COPY } from '../operations-diagnostics.js'

const STATUS_COPY = Object.freeze({
  critical: 'wymaga działania',
  ok: 'działa',
  warning: 'wymaga uwagi',
})

const INITIAL_SNAPSHOT = Object.freeze({
  actions: null,
  error: null,
  health: null,
  resolutionBlocked: false,
  staleMessage: null,
  status: 'loading',
})

const GENERIC_ERROR = 'Nie udało się sprawdzić, czy wszystko działa. Spróbuj ponownie za chwilę.'
const FORBIDDEN_ERROR = 'Nie masz już dostępu do bezpieczeństwa danych.'
const STALE_ERROR = 'Nie udało się odświeżyć listy problemów. Pokazujemy ostatnio wczytany stan.'
const UNCERTAIN_ERROR = 'Nie udało się potwierdzić wyniku. Sprawdź listę przed ponowieniem.'
const SUCCESS_STALE_ERROR = 'Działanie przyjęto, ale nie udało się odświeżyć listy problemów.'

const formatTime = (instant) => relInstantLabel(instant) ?? ''
const failureCopy = (error) => error instanceof ApiError && error.code === 'FORBIDDEN'
  ? FORBIDDEN_ERROR
  : GENERIC_ERROR

function problemCopy(action) {
  if (action.kind === 'authorization_denial_spike') return {
    title: 'System zablokował więcej działań niż zwykle',
    description: 'Ktoś próbował wykonać czynności bez wymaganych uprawnień. Sam alarm nie oznacza włamania.',
  }
  if (action.kind === 'access_reconciliation_lag') return {
    title: 'Zmiany dostępu jeszcze nie działają wszędzie',
    description: 'Przyznanie lub odebranie dostępu mogło jeszcze nie zostać zastosowane.',
  }
  if (action.kind === 'backup_stale') return {
    title: 'Brakuje aktualnej kopii zapasowej',
    description: 'Po awarii można byłoby odtworzyć tylko starszy stan danych.',
  }
  if (action.kind === 'scheduler_stale') return {
    title: 'Automatyczne kontrole są opóźnione',
    description: 'Kopie i inne zadania mogą wykonać się później niż zwykle.',
  }
  if (action.kind === 'outbox_job_failed') {
    if (action.details.outboxType === 'staff.invitation.email') return {
      title: 'Nie udało się wysłać zaproszenia',
      description: action.recovery?.status === 'unsafe'
        ? 'Zaproszenie mogło już zostać wysłane. Sprawdź w Zespół › Dostęp, czy zaproszona osoba ma już dostęp. Jeśli nie, zapytaj ją, czy dostała e-mail.'
        : 'Zaproszenie nie zostało wysłane automatycznie.',
      staffAccessLink: action.recovery?.status === 'unsafe',
    }
    if (action.details.outboxType === 'staff.access.reconcile') return {
      title: 'Nie udało się zaktualizować dostępu',
      description: 'Ostatnia zmiana dostępu personelu mogła jeszcze nie zostać zastosowana.',
    }
    if (action.details.outboxType === 'staff.invitation.expire') return {
      title: 'Nie udało się zamknąć wygasłego zaproszenia',
      description: 'Status zaproszenia może odświeżyć się z opóźnieniem.',
    }
  }
  return {
    title: 'Nie udało się wykonać automatycznego zadania',
    description: 'Jedna czynność w tle wymaga sprawdzenia.',
  }
}

function ResourceError({ copy, onRetry, stale = false }) {
  return (
    <div className={`operations-state operations-state--${stale ? 'stale' : 'error'}`} role="alert">
      <span>{copy}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>Spróbuj ponownie</Button>
    </div>
  )
}

function ActionConfirm({ action, fallbackRef, mode, opener, onClose, onReconcile }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const cardRef = useRef(null)
  const activeRef = useRef(true)
  const submitLockRef = useRef(false)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const busy = saveStatus === 'submitting' || saveStatus === 'reconciling'
  const recovering = mode === 'recover'

  useEffect(() => {
    activeRef.current = true
    const dialog = dialogRef.current
    dialog?.showModal()
    cardRef.current?.querySelector('button')?.focus()
    const controls = () => [...(cardRef.current?.querySelectorAll('button') || [])]
      .filter((element) => !element.disabled && element.offsetParent !== null)
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        return
      }
      if (event.key !== 'Tab') return
      const elements = controls()
      if (!elements.length) return
      const first = elements[0]
      const last = elements.at(-1)
      if (event.shiftKey && (document.activeElement === first
        || !cardRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last
        || !cardRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      activeRef.current = false
      document.removeEventListener('keydown', onKeyDown, true)
      if (dialog?.open) dialog.close()
      requestAnimationFrame(() => {
        const target = opener?.isConnected ? opener : fallbackRef.current
        target?.focus({ preventScroll: true })
      })
    }
  }, [fallbackRef, opener])

  const close = () => {
    if (!submitLockRef.current && !busy) onClose()
  }

  const submit = async () => {
    if (submitLockRef.current || busy) return
    submitLockRef.current = true
    setSaveStatus('submitting')
    setSaveError(null)
    let key
    try {
      key = apiClient.createIdempotencyKey()
      const command = recovering
        ? apiClient.recoverOperationalAction
        : apiClient.resolveOperationalAction
      await command(action.id, action.version, { idempotencyKey: key })
      if (!activeRef.current) return
      key = null
      setSaveStatus('reconciling')
      const result = await onReconcile(action, 'success', mode)
      if (activeRef.current && result.active) onClose()
    } catch (error) {
      if (!activeRef.current) return
      const conflict = error instanceof ApiError
        && (error.code === 'VERSION_CONFLICT'
          || (recovering && error.code === 'OUTBOX_RECOVERY_CONFLICT'))
      const uncertain = error instanceof ApiError && error.idempotencyKey === key
      key = null
      if (conflict || uncertain) {
        setSaveStatus('reconciling')
        const result = await onReconcile(action, conflict ? 'conflict' : 'uncertain', mode)
        if (activeRef.current && result.active) onClose()
        return
      }
      setSaveStatus('error')
      setSaveError(recovering
        ? error instanceof ApiError && error.code === 'OUTBOX_RECOVERY_UNSAFE'
          ? 'Tego zadania nie można bezpiecznie ponowić.'
          : 'Nie udało się zlecić ponowienia zadania.'
        : 'Nie udało się ukryć powiadomienia.')
    } finally {
      submitLockRef.current = false
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
      <div className="leave-confirm operations-confirm">
        <div className="leave-confirm__backdrop" onClick={close} />
        <div className="leave-confirm__card" ref={cardRef} aria-busy={busy ? 'true' : undefined}>
          <h2 className="display" id={titleId}>
            {recovering ? 'Ponowić zadanie?' : 'Ukryć powiadomienie?'}
          </h2>
          <p>{recovering
            ? 'System utworzy nową próbę i zachowa historię wcześniejszego zadania.'
            : 'Powiadomienie zniknie z listy. Ta czynność nie naprawia przyczyny problemu.'}</p>
          {saveError ? <div className="form-warn form-warn--error" role="alert">{saveError}</div> : null}
          <div className="leave-confirm__actions">
            <Button variant="ghost" disabled={busy} onClick={close}>Wróć</Button>
            <Button disabled={busy} onClick={submit}>
              {recovering ? 'Ponów zadanie' : 'Ukryj powiadomienie'}
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  )
}

function TechnicalDetails({ actions, health }) {
  return (
    <details className="operations-technical">
      <summary>Pokaż szczegóły techniczne</summary>
      <div className="operations-technical__body">
        {health.generatedAt ? <p>Stan wygenerowano: <time dateTime={health.generatedAt}>{formatTime(health.generatedAt)}</time>.</p> : (
          <p>Nie ma jeszcze wygenerowanego stanu.</p>
        )}
        <ul>
          {health.checks.map((check) => (
            <li key={check.id}>
              <strong>{check.label}</strong>
              <span>{STATUS_COPY[check.status] || check.status}</span>
              <code>{check.detailCode}</code>
              <span>{check.lastSuccessAt
                ? <>Ostatnie powodzenie: <time dateTime={check.lastSuccessAt}>{formatTime(check.lastSuccessAt)}</time></>
                : 'Brak zapisanego powodzenia'}</span>
            </li>
          ))}
        </ul>
        {actions.length ? (
          <>
            <p>Otwarte numery powiadomień:</p>
            <ul>
              {actions.map((action) => (
                <li key={action.id}>
                  <code>{action.id}</code>
                  <code>{action.details.backupErrorCode || action.details.errorCode}</code>
                  {action.details.backupErrorCode ? (
                    <span>{BACKUP_FAILURE_COPY[action.details.backupErrorCode]}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </details>
  )
}

function ProblemAction({ action, blocked, canRecover, onConfirm }) {
  if (action.kind === 'authorization_denial_spike'
    || action.kind === 'access_reconciliation_lag') {
    return (
      <EntityLink route="team" params={{ section: 'permissions' }} className="btn btn--soft btn--sm">
        Sprawdź uprawnienia
      </EntityLink>
    )
  }
  const recoveryPending = action.recovery?.status === 'queued'
    || action.recovery?.status === 'processing'
  if (recoveryPending) return <span className="operations-problem__note">Ponowienie jest w toku.</span>
  const command = operationalActionCommand(action, canRecover)
  if (command === null) return null
  return (
    <Button size="sm" variant="soft" disabled={blocked} onClick={(event) => onConfirm({
      action, mode: command, opener: event.currentTarget,
    })}>
      {command === 'recover' ? 'Ponów zadanie' : 'Ukryj powiadomienie'}
    </Button>
  )
}

export function OperationsPanel({ sectionRef }) {
  const { toast } = useApp()
  const { actor, appMode, capabilities } = useShell()
  const canView = appMode === 'app' && actor?.role === 'owner'
    && canPerformAction(capabilities, 'operations.health.read')
  const canRecover = canView && canPerformAction(capabilities, 'staff.invite')
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT)
  const [confirmation, setConfirmation] = useState(null)
  const requestRef = useRef(0)
  const actionsRequestRef = useRef(0)
  const activeRef = useRef(false)
  const fallbackRef = useRef(null)

  const loadSnapshot = useCallback(async () => {
    const requestId = ++requestRef.current
    setSnapshot((current) => ({
      ...current,
      error: null,
      staleMessage: null,
      status: current.health && current.actions ? 'ready' : 'loading',
    }))
    try {
      const [health, actions] = await Promise.all([
        apiClient.getOperationsHealth(),
        apiClient.getOperationalActions(),
      ])
      if (!activeRef.current || requestRef.current !== requestId) return { ok: false }
      setSnapshot({ ...INITIAL_SNAPSHOT, actions, health, status: 'ready' })
      return { actions, health, ok: true }
    } catch (error) {
      if (!activeRef.current || requestRef.current !== requestId) return { ok: false }
      setSnapshot((current) => current.health && current.actions
        ? { ...current, error: null, staleMessage: STALE_ERROR, status: 'ready' }
        : { ...INITIAL_SNAPSHOT, error: failureCopy(error), status: 'error' })
      return { ok: false }
    }
  }, [])

  const loadActions = useCallback(async ({ blockResolutionOnFailure = false, staleMessage = STALE_ERROR } = {}) => {
    const requestId = ++actionsRequestRef.current
    try {
      const actions = await apiClient.getOperationalActions()
      if (!activeRef.current || actionsRequestRef.current !== requestId) return { ok: false }
      setSnapshot((current) => ({
        ...current, actions, error: null, resolutionBlocked: false, staleMessage: null, status: 'ready',
      }))
      return { actions, ok: true }
    } catch {
      if (!activeRef.current || actionsRequestRef.current !== requestId) return { ok: false }
      setSnapshot((current) => ({
        ...current,
        resolutionBlocked: current.resolutionBlocked || blockResolutionOnFailure,
        staleMessage,
      }))
      return { ok: false }
    }
  }, [])

  useEffect(() => {
    if (!canView) return undefined
    activeRef.current = true
    const timer = window.setTimeout(() => { void loadSnapshot() }, 0)
    return () => {
      activeRef.current = false
      window.clearTimeout(timer)
      requestRef.current += 1
      actionsRequestRef.current += 1
    }
  }, [canView, loadSnapshot])

  const reconcileAction = useCallback(async (action, outcome, mode) => {
    if (!activeRef.current) return { active: false, ok: false }
    const result = await loadActions({
      blockResolutionOnFailure: outcome === 'uncertain',
      staleMessage: outcome === 'success'
        ? SUCCESS_STALE_ERROR
        : outcome === 'uncertain' ? UNCERTAIN_ERROR : STALE_ERROR,
    })
    if (!activeRef.current) return { active: false, ok: false }
    if (outcome === 'success') {
      toast(mode === 'recover'
        ? 'Ponowienie zadania zostało zlecone.'
        : 'Powiadomienie zostało ukryte.')
      return { ...result, active: true }
    }
    if (result.ok) {
      const stillOpen = result.actions.actions.some((item) => item.id === action.id)
      toast(stillOpen ? 'Powiadomienie nadal jest widoczne.' : 'Lista problemów została odświeżona.', 'alert')
    }
    return { ...result, active: true }
  }, [loadActions, toast])

  useEffect(() => {
    if (confirmation && (
      !canView
      || operationalActionCommand(confirmation.action, canRecover) !== confirmation.mode
    )) setConfirmation(null)
  }, [canRecover, canView, confirmation])

  if (!canView) return null

  const health = snapshot.health
  const actions = snapshot.actions?.actions ?? []
  const currentActions = health ? currentOperationalActions(health, actions) : []
  const summary = health ? operationsSummary(health, actions) : null
  const lastBackupAt = health ? backupFreshnessState(health).lastSuccessAt : null

  return (
    <>
      <section
        className="settings-section operations"
        aria-labelledby="operations-title"
        ref={sectionRef}
      >
        <h2
          className="settings-section__title"
          id="operations-title"
          ref={fallbackRef}
          tabIndex={-1}
        >
          Bezpieczeństwo danych
        </h2>
        <p className="operations__intro">Kopie zapasowe są wykonywane automatycznie każdej nocy.</p>

        {snapshot.status === 'loading' ? (
          <p className="operations-state" role="status" aria-live="polite">Sprawdzam, czy wszystko działa…</p>
        ) : null}
        {snapshot.status === 'error' ? <ResourceError copy={snapshot.error} onRetry={loadSnapshot} /> : null}

        {health && summary ? (
          <>
            {snapshot.staleMessage ? (
              <ResourceError copy={snapshot.staleMessage} onRetry={loadActions} stale />
            ) : null}
            <div className="card card--pad operations-summary" data-status={summary.status}>
              <strong className="operations-summary__title">{summary.title}</strong>
              <p>{summary.description}</p>
              {lastBackupAt ? (
                <p className="operations-summary__time">
                  Ostatnia kopia zapasowa: <time dateTime={lastBackupAt}>{formatTime(lastBackupAt)}</time>
                </p>
              ) : null}
            </div>

            {currentActions.length ? (
              <section className="operations-problems" aria-labelledby="operations-problems-title">
                <h3 id="operations-problems-title">Co wymaga uwagi ({currentActions.length})</h3>
                <div className="operations-problems__list">
                  {currentActions.map((action) => {
                    const copy = problemCopy(action)
                    return (
                      <article className="card card--pad operations-problem" key={action.id}>
                        <div>
                          <strong>{copy.title}</strong>
                          <p>{copy.description}</p>
                          {copy.staffAccessLink ? (
                            <EntityLink route="team" params={{ section: 'access' }}>Otwórz Zespół › Dostęp</EntityLink>
                          ) : null}
                          <p className="operations-problem__time">
                            Zgłoszono <time dateTime={action.createdAt}>{formatTime(action.createdAt)}</time>
                          </p>
                        </div>
                        <ProblemAction
                          action={action}
                          blocked={snapshot.resolutionBlocked}
                          canRecover={canRecover}
                          onConfirm={setConfirmation}
                        />
                      </article>
                    )
                  })}
                </div>
                {snapshot.actions.truncated ? (
                  <p className="operations-limit-note">Pokazujemy 100 najnowszych powiadomień.</p>
                ) : null}
              </section>
            ) : null}

            <TechnicalDetails actions={actions} health={health} />
          </>
        ) : null}
      </section>

      {confirmation ? (
        <ActionConfirm
          action={confirmation.action}
          fallbackRef={fallbackRef}
          mode={confirmation.mode}
          opener={confirmation.opener}
          onClose={() => setConfirmation(null)}
          onReconcile={reconcileAction}
        />
      ) : null}
    </>
  )
}
