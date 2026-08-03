import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ApiError, apiClient } from '../api.js'
import { useShell } from '../shell-ctx.js'
import { useApp } from '../store.jsx'
import { Button, IconBtn, Pill } from '../ui.jsx'

const timeFormat = new Intl.DateTimeFormat('pl-PL', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Warsaw',
})

const HEALTH_STATUS = Object.freeze({
  ok: Object.freeze({ label: 'Działa prawidłowo', tone: 'sage' }),
  warning: Object.freeze({ label: 'Wymaga uwagi', tone: 'amber' }),
  critical: Object.freeze({ label: 'Wymaga działania', tone: 'error' }),
})

const HEALTH_DETAILS = Object.freeze({
  ACCESS_CURRENT: 'Dostęp personelu jest zsynchronizowany.',
  ACCESS_RECONCILIATION_LAG: 'Synchronizacja dostępu personelu jest opóźniona.',
  BACKUP_NOT_DUE: 'Pierwsza kopia zapasowa nie jest jeszcze wymagana.',
  BACKUP_FRESH: 'Ostatnia kopia zapasowa jest aktualna.',
  BACKUP_PENDING: 'Kopia zapasowa oczekuje na utworzenie.',
  BACKUP_FAILED: 'Ostatnia próba utworzenia kopii zapasowej nie powiodła się.',
  BACKUP_STALE: 'Brakuje aktualnej kopii zapasowej.',
  OUTBOX_HEALTHY: 'Kolejka zadań działa prawidłowo.',
  OUTBOX_DEAD: 'Co najmniej jedno zadanie wymaga interwencji.',
  OUTBOX_DRAIN_FAILED: 'Ostatnia próba obsługi kolejki nie powiodła się.',
  OUTBOX_DRAIN_STALE: 'Kolejka zadań nie została obsłużona w oczekiwanym czasie.',
  SCHEDULER_STARTING: 'Zadania cykliczne oczekują na pierwsze zakończenie.',
  SCHEDULER_HEALTHY: 'Zadania cykliczne działają prawidłowo.',
  SCHEDULER_STALE: 'Zadania cykliczne nie zakończyły się w oczekiwanym czasie.',
})

const ACTION_COPY = Object.freeze({
  access_reconciliation_lag: Object.freeze({
    label: 'Opóźniona synchronizacja dostępu',
    description: 'Stan dostępu personelu wymaga ponownej synchronizacji.',
  }),
  authorization_denial_spike: Object.freeze({
    label: 'Wzrost odmów dostępu',
    description: 'Liczba odmów dostępu przekroczyła próg bezpieczeństwa.',
  }),
  backup_failed: Object.freeze({
    label: 'Nieudana kopia zapasowa',
    description: 'Ostatnia próba utworzenia kopii zapasowej nie powiodła się.',
  }),
  backup_stale: Object.freeze({
    label: 'Nieaktualna kopia zapasowa',
    description: 'Brakuje aktualnej kopii zapasowej.',
  }),
  outbox_job_failed: Object.freeze({
    label: 'Nieudane zadanie',
    description: 'Zadanie w kolejce zakończyło się trwałym błędem.',
  }),
  scheduler_stale: Object.freeze({
    label: 'Nieaktualne zadania cykliczne',
    description: 'Zadania cykliczne nie zakończyły się w oczekiwanym czasie.',
  }),
})

const AUDIT_ACTIONS = Object.freeze({
  'authorization.denied': 'Odmowa autoryzacji',
  'backup.pruned': 'Usunięcie wygasłej kopii zapasowej',
  'data_key.rewrapped': 'Ponowne zabezpieczenie klucza danych',
  'identity.activation': 'Aktywacja tożsamości',
  'identity.denied': 'Odmowa aktywacji tożsamości',
  'identity.reindex': 'Aktualizacja indeksu tożsamości',
  'operational_action.resolved': 'Rozwiązanie działania operacyjnego',
  'staff.access.reconciled': 'Synchronizacja dostępu personelu',
  'staff.bootstrap': 'Utworzenie konta właściciela',
  'staff.deactivated': 'Wyłączenie dostępu personelu',
  'staff.invitation.email_accepted': 'Przyjęcie wiadomości z zaproszeniem',
  'staff.invitation.expired': 'Wygaśnięcie zaproszenia',
  'staff.invited': 'Zaproszenie personelu',
})

const AUDIT_RESULTS = Object.freeze({
  denied: Object.freeze({ label: 'Odmowa', tone: 'error' }),
  success: Object.freeze({ label: 'Powodzenie', tone: 'sage' }),
})

const GENERIC_ERROR = 'Nie udało się pobrać danych.'
const FORBIDDEN_ERROR = 'Uprawnienia do tych danych uległy zmianie.'
const STALE_ERROR = 'Nie udało się odświeżyć. Wyświetlane dane mogą być nieaktualne.'
const UNCERTAIN_RECONCILIATION_ERROR = 'Nie udało się potwierdzić wyniku. Odśwież listę działań przed ponowieniem.'
const SUCCESS_RECONCILIATION_ERROR = 'Działanie zapisano, ale lista może być nieaktualna.'

const initialResource = (status = 'loading') => ({
  data: null,
  error: null,
  loadingMore: false,
  refreshing: false,
  resolutionBlocked: false,
  staleMessage: null,
  status,
})

const initialAnnouncements = () => ({
  actions: { message: '', sequence: 0 },
  audit: { message: '', sequence: 0 },
  health: { message: '', sequence: 0 },
})

const failureCopy = (error) => error instanceof ApiError && error.code === 'FORBIDDEN'
  ? FORBIDDEN_ERROR
  : GENERIC_ERROR

const formatTime = (instant) => timeFormat.format(new Date(instant))

const combinedAuditPage = (current, next) => {
  const events = [...current.events, ...next.events]
  const ids = new Set()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (ids.has(event.id)) return null
    ids.add(event.id)
    if (index === 0) continue
    const previous = events[index - 1]
    if (previous.occurredAt < event.occurredAt
      || (previous.occurredAt === event.occurredAt && previous.id <= event.id)) return null
  }
  return { events, nextCursor: next.nextCursor }
}

function ResourceError({ copy, onRetry }) {
  return (
    <div className="operations-state operations-state--error" role="alert">
      <span>{copy}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>Spróbuj ponownie</Button>
    </div>
  )
}

function StaleNotice({ copy, onRetry }) {
  return (
    <div className="operations-state operations-state--stale" role="alert">
      <span>{copy}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>Spróbuj ponownie</Button>
    </div>
  )
}

function PanelHeader({ title, refreshLabel, refreshing, onRefresh, titleRef }) {
  return (
    <div className="operations-panel__head">
      <h3 ref={titleRef}>{title}</h3>
      <IconBtn
        name="refresh"
        label={refreshLabel}
        disabled={refreshing}
        aria-busy={refreshing ? 'true' : undefined}
        onClick={onRefresh}
      />
    </div>
  )
}

function ResolutionConfirm({ action, fallbackRef, opener, onClose, onReconcile }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const cardRef = useRef(null)
  const activeRef = useRef(true)
  const submitLockRef = useRef(false)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const busy = saveStatus === 'submitting' || saveStatus === 'reconciling'

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
      if (!elements.length) {
        event.preventDefault()
        return
      }
      const first = elements[0]
      const last = elements[elements.length - 1]
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
      await apiClient.resolveOperationalAction(action.id, action.version, {
        idempotencyKey: key,
      })
      if (!activeRef.current) return
      key = null
      setSaveStatus('reconciling')
      const result = await onReconcile(action, 'success')
      if (activeRef.current && result.active) onClose()
    } catch (error) {
      if (!activeRef.current) return
      const conflict = error instanceof ApiError && error.code === 'VERSION_CONFLICT'
      const uncertain = error instanceof ApiError && error.idempotencyKey === key
      key = null
      if (conflict || uncertain) {
        setSaveStatus('reconciling')
        const result = await onReconcile(action, conflict ? 'conflict' : 'uncertain')
        if (activeRef.current && result.active) onClose()
        return
      }
      setSaveStatus('error')
      setSaveError('Nie udało się oznaczyć działania jako rozwiązanego.')
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
          <h2 className="display" id={titleId}>Oznacz działanie jako rozwiązane</h2>
          <p>Potwierdź, że działanie zostało sprawdzone i nie wymaga dalszej interwencji.</p>
          {saveError ? (
            <div className="form-warn form-warn--error" role="alert">
              <span>{saveError}</span>
            </div>
          ) : null}
          <div className="leave-confirm__actions">
            <Button variant="ghost" disabled={busy} onClick={close}>Wróć</Button>
            <Button disabled={busy} onClick={submit}>Oznacz jako rozwiązane</Button>
          </div>
        </div>
      </div>
    </dialog>
  )
}

export function OperationsPanel({ sectionRef }) {
  const { toast } = useApp()
  const { appMode, capabilities } = useShell()
  const canReadAudit = appMode === 'app' && capabilities.includes('security.audit.read')
  const tabs = useMemo(() => [
    { id: 'health', label: 'Stan systemu' },
    { id: 'actions', label: 'Działania' },
    ...(canReadAudit ? [{ id: 'security', label: 'Bezpieczeństwo' }] : []),
  ], [canReadAudit])
  const [activeTab, setActiveTab] = useState('health')
  const [health, setHealth] = useState(() => initialResource())
  const [actions, setActions] = useState(() => initialResource())
  const [audit, setAudit] = useState(() => initialResource('idle'))
  const [confirmation, setConfirmation] = useState(null)
  const [announcements, setAnnouncements] = useState(initialAnnouncements)
  const healthRequestRef = useRef(0)
  const actionsRequestRef = useRef(0)
  const auditRequestRef = useRef(0)
  const auditRequestLockRef = useRef(null)
  const activeRef = useRef(false)
  const tabRefs = useRef({})
  const actionsTabRef = useRef(null)

  const announce = useCallback((resource, message) => {
    setAnnouncements((current) => ({
      ...current,
      [resource]: {
        message,
        sequence: current[resource].sequence + 1,
      },
    }))
  }, [])

  const loadHealth = useCallback(async ({ staleMessage = STALE_ERROR } = {}) => {
    const requestId = ++healthRequestRef.current
    setHealth((current) => ({
      ...current,
      error: null,
      refreshing: Boolean(current.data),
      staleMessage: current.data ? current.staleMessage : null,
      status: current.data ? 'ready' : 'loading',
    }))
    try {
      const data = await apiClient.getOperationsHealth()
      if (healthRequestRef.current !== requestId) return { ok: false }
      setHealth({ ...initialResource('ready'), data })
      announce('health', 'Stan systemu został odświeżony.')
      return { data, ok: true }
    } catch (error) {
      if (healthRequestRef.current !== requestId) return { ok: false }
      setHealth((current) => current.data
        ? { ...current, refreshing: false, staleMessage, status: 'ready' }
        : { ...initialResource('error'), error: failureCopy(error) })
      return { ok: false }
    }
  }, [announce])

  const loadActions = useCallback(async ({
    blockResolutionOnFailure = false,
    staleMessage = STALE_ERROR,
  } = {}) => {
    const requestId = ++actionsRequestRef.current
    setActions((current) => ({
      ...current,
      error: null,
      refreshing: Boolean(current.data),
      staleMessage: current.data ? current.staleMessage : null,
      status: current.data ? 'ready' : 'loading',
    }))
    try {
      const result = await apiClient.getOperationalActions()
      if (actionsRequestRef.current !== requestId) return { ok: false }
      const visibleActions = canReadAudit
        ? result.actions
        : result.actions.filter((action) => action.kind !== 'authorization_denial_spike')
      const data = {
        actions: visibleActions,
        truncated: result.truncated && visibleActions.length === 100,
      }
      setActions({ ...initialResource('ready'), data })
      announce('actions', 'Lista działań została odświeżona.')
      return { data, ok: true }
    } catch (error) {
      if (actionsRequestRef.current !== requestId) return { ok: false }
      setActions((current) => current.data
        ? {
            ...current,
            refreshing: false,
            resolutionBlocked: current.resolutionBlocked || blockResolutionOnFailure,
            staleMessage,
            status: 'ready',
          }
        : { ...initialResource('error'), error: failureCopy(error) })
      return { ok: false }
    }
  }, [announce, canReadAudit])

  const loadAudit = useCallback(async ({ mode = 'initial' } = {}) => {
    const pending = auditRequestLockRef.current
    if (pending && (mode === 'older' || pending.mode === mode)) return { ok: false }
    const requestId = ++auditRequestRef.current
    auditRequestLockRef.current = { mode, requestId }
    const cursor = mode === 'older' ? audit.data?.nextCursor : null
    setAudit((current) => {
      return {
        ...current,
        error: null,
        loadingMore: mode === 'older',
        refreshing: mode === 'refresh' && Boolean(current.data),
        staleMessage: mode === 'refresh' && current.data ? current.staleMessage : null,
        status: current.data ? 'ready' : 'loading',
      }
    })
    try {
      const page = await apiClient.getSecurityAudit({
        ...(mode === 'older' ? { cursor } : {}),
        limit: 50,
      })
      if (auditRequestRef.current !== requestId) return { ok: false }
      let data = page
      if (mode === 'older') {
        const current = audit.data
        data = current ? combinedAuditPage(current, page) : null
        if (!data) throw new Error('invalid combined page')
      }
      setAudit({ ...initialResource('ready'), data })
      announce('audit', 'Zdarzenia bezpieczeństwa zostały odświeżone.')
      return { data, ok: true }
    } catch (error) {
      if (auditRequestRef.current !== requestId) return { ok: false }
      setAudit((current) => {
        if (!current.data) return { ...initialResource('error'), error: failureCopy(error) }
        if (mode === 'refresh') {
          return { ...current, refreshing: false, staleMessage: STALE_ERROR, status: 'ready' }
        }
        return { ...current, error: failureCopy(error), loadingMore: false, status: 'ready' }
      })
      return { ok: false }
    } finally {
      if (auditRequestLockRef.current?.requestId === requestId) {
        auditRequestLockRef.current = null
      }
    }
  }, [announce, audit.data])

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadHealth()
      void loadActions()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      healthRequestRef.current += 1
      actionsRequestRef.current += 1
      auditRequestRef.current += 1
      auditRequestLockRef.current = null
    }
  }, [loadActions, loadHealth])

  useEffect(() => {
    if (activeTab === 'security' && audit.status === 'idle') void loadAudit()
  }, [activeTab, audit.status, loadAudit])

  const activateTab = (id, focus = false) => {
    setActiveTab(id)
    if (focus) requestAnimationFrame(() => tabRefs.current[id]?.focus())
  }

  const onTabKeyDown = (event, index) => {
    let nextIndex
    if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % tabs.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + tabs.length) % tabs.length
    } else return
    event.preventDefault()
    activateTab(tabs[nextIndex].id, true)
  }

  const reconcileAction = useCallback(async (action, outcome) => {
    if (!activeRef.current) return { active: false, ok: false }
    const result = await loadActions({
      blockResolutionOnFailure: outcome === 'uncertain',
      staleMessage: outcome === 'success'
        ? SUCCESS_RECONCILIATION_ERROR
        : outcome === 'uncertain' ? UNCERTAIN_RECONCILIATION_ERROR : STALE_ERROR,
    })
    if (!activeRef.current) return { active: false, ok: false }
    if (outcome === 'success') {
      toast('Działanie zostało oznaczone jako rozwiązane.')
      return { ...result, active: true }
    }
    if (result.ok) {
      const stillOpen = result.data.actions.some((item) => item.id === action.id)
      toast(stillOpen ? 'Działanie nadal jest otwarte.' : 'Lista działań została odświeżona.', 'alert')
    }
    return { ...result, active: true }
  }, [loadActions, toast])

  const closeConfirmation = useCallback(() => setConfirmation(null), [])

  return (
    <>
      <section
        className="settings-section operations"
        aria-labelledby="operations-title"
        ref={sectionRef}
      >
        <h2 className="settings-section__title" id="operations-title" tabIndex={-1}>
          Stan i bezpieczeństwo
        </h2>
        <p className="operations__intro">
          Monitoruj stan usług, otwarte działania i zdarzenia bezpieczeństwa.
        </p>
        <div className="operations-tabs" role="tablist" aria-label="Obszary stanu i bezpieczeństwa">
          {tabs.map((tab, index) => (
            <button
              type="button"
              role="tab"
              id={`operations-tab-${tab.id}`}
              key={tab.id}
              ref={(element) => {
                tabRefs.current[tab.id] = element
                if (tab.id === 'actions') actionsTabRef.current = element
              }}
              className={`operations-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              aria-controls={`operations-panel-${tab.id}`}
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => activateTab(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div
          className="operations-panel"
          id="operations-panel-health"
          role="tabpanel"
          aria-labelledby="operations-tab-health"
          hidden={activeTab !== 'health'}
        >
          <PanelHeader
            title="Stan systemu"
            refreshLabel="Odśwież stan systemu"
            refreshing={health.refreshing}
            onRefresh={() => loadHealth()}
          />
          {health.status === 'loading' ? (
            <p className="operations-state" role="status" aria-live="polite">Pobieranie stanu systemu…</p>
          ) : null}
          {health.status === 'error' ? <ResourceError copy={health.error} onRetry={() => loadHealth()} /> : null}
          {health.data ? (
            <>
              {health.staleMessage ? <StaleNotice copy={health.staleMessage} onRetry={() => loadHealth()} /> : null}
              <p className="operations-snapshot">
                Stan z <time dateTime={health.data.generatedAt}>{formatTime(health.data.generatedAt)}</time>
              </p>
              <ul className="operations-list" aria-label="Stan systemu">
                {health.data.checks.map((check) => {
                  const status = HEALTH_STATUS[check.status]
                  return (
                    <li className="operations-row" key={check.id}>
                      <div className="operations-row__content">
                        <strong className="operations-row__title">{check.label}</strong>
                        <p>{HEALTH_DETAILS[check.detailCode]}</p>
                        <p className="operations-row__meta">
                          {check.lastSuccessAt ? (
                            <>Ostatnie powodzenie: <time dateTime={check.lastSuccessAt}>{formatTime(check.lastSuccessAt)}</time></>
                          ) : 'Brak zapisanego powodzenia.'}
                        </p>
                      </div>
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : null}
        </div>

        <div
          className="operations-panel"
          id="operations-panel-actions"
          role="tabpanel"
          aria-labelledby="operations-tab-actions"
          hidden={activeTab !== 'actions'}
        >
          <PanelHeader
            title="Działania"
            refreshLabel="Odśwież działania"
            refreshing={actions.refreshing}
            onRefresh={() => loadActions()}
          />
          {actions.status === 'loading' ? (
            <p className="operations-state" role="status" aria-live="polite">Pobieranie działań…</p>
          ) : null}
          {actions.status === 'error' ? <ResourceError copy={actions.error} onRetry={() => loadActions()} /> : null}
          {actions.data ? (
            <>
              {actions.staleMessage ? <StaleNotice copy={actions.staleMessage} onRetry={() => loadActions()} /> : null}
              {actions.data.actions.length === 0 ? (
                <p className="operations-state">Brak otwartych działań.</p>
              ) : (
                <ul className="operations-list" aria-label="Otwarte działania">
                  {actions.data.actions.map((action) => {
                    const copy = ACTION_COPY[action.kind]
                    const severity = action.severity === 'warning'
                      ? { label: 'Ostrzeżenie', tone: 'amber' }
                      : { label: 'Krytyczne', tone: 'error' }
                    return (
                      <li className="operations-row operations-action-row" key={action.id}>
                        <div className="operations-row__content">
                          <strong className="operations-row__title">{copy.label}</strong>
                          <p>{copy.description}</p>
                          <p className="operations-row__meta">
                            Utworzono <time dateTime={action.createdAt}>{formatTime(action.createdAt)}</time>
                          </p>
                        </div>
                        <div className="operations-row__commands">
                          <Pill tone={severity.tone}>{severity.label}</Pill>
                          <Button
                            size="sm"
                            variant="soft"
                            disabled={actions.resolutionBlocked}
                            onClick={(event) => setConfirmation({
                              action,
                              opener: event.currentTarget,
                            })}
                          >
                            Oznacz jako rozwiązane
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {actions.data.truncated ? (
                <p className="operations-limit-note">Wyświetlono 100 najnowszych działań.</p>
              ) : null}
            </>
          ) : null}
        </div>

        {canReadAudit ? (
          <div
            className="operations-panel"
            id="operations-panel-security"
            role="tabpanel"
            aria-labelledby="operations-tab-security"
            hidden={activeTab !== 'security'}
          >
            <PanelHeader
              title="Bezpieczeństwo"
              refreshLabel="Odśwież bezpieczeństwo"
              refreshing={audit.refreshing}
              onRefresh={() => loadAudit({ mode: 'refresh' })}
            />
            {audit.status === 'loading' ? (
              <p className="operations-state" role="status" aria-live="polite">Pobieranie zdarzeń bezpieczeństwa…</p>
            ) : null}
            {audit.status === 'error' ? <ResourceError copy={audit.error} onRetry={() => loadAudit()} /> : null}
            {audit.data ? (
              <>
                {audit.staleMessage ? (
                  <StaleNotice copy={audit.staleMessage} onRetry={() => loadAudit({ mode: 'refresh' })} />
                ) : null}
                {audit.error ? (
                  <div className="operations-state operations-state--error" role="alert">
                    <span>{audit.error}</span>
                  </div>
                ) : null}
                {audit.data.events.length === 0 ? (
                  <p className="operations-state">Brak zdarzeń bezpieczeństwa.</p>
                ) : (
                  <ul className="operations-list" aria-label="Zdarzenia bezpieczeństwa">
                    {audit.data.events.map((event) => {
                      const result = AUDIT_RESULTS[event.result]
                      return (
                        <li className="operations-row operations-audit-row" key={event.id}>
                          <div className="operations-row__content">
                            <strong className="operations-row__title">{AUDIT_ACTIONS[event.action]}</strong>
                            <p>{event.actorStaffId === null ? 'Zdarzenie systemowe' : 'Działanie personelu'}</p>
                            <p className="operations-row__meta">
                              <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
                            </p>
                          </div>
                          <Pill tone={result.tone}>{result.label}</Pill>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {audit.data.nextCursor ? (
                  <div className="operations-audit-pager">
                    <Button
                      variant="ghost"
                      disabled={audit.loadingMore}
                      aria-busy={audit.loadingMore ? 'true' : undefined}
                      onClick={() => loadAudit({ mode: 'older' })}
                    >
                      Pokaż starsze
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        <p
          className="sr-only"
          role="status"
          aria-label="Komunikaty stanu systemu"
          aria-live="polite"
        >
          {announcements.health.message ? (
            <span key={announcements.health.sequence}>{announcements.health.message}</span>
          ) : null}
        </p>
        <p
          className="sr-only"
          role="status"
          aria-label="Komunikaty działań"
          aria-live="polite"
        >
          {announcements.actions.message ? (
            <span key={announcements.actions.sequence}>{announcements.actions.message}</span>
          ) : null}
        </p>
        {canReadAudit ? (
          <p
            className="sr-only"
            role="status"
            aria-label="Komunikaty bezpieczeństwa"
            aria-live="polite"
          >
            {announcements.audit.message ? (
              <span key={announcements.audit.sequence}>{announcements.audit.message}</span>
            ) : null}
          </p>
        ) : null}
      </section>
      {confirmation ? (
        <ResolutionConfirm
          action={confirmation.action}
          fallbackRef={actionsTabRef}
          opener={confirmation.opener}
          onClose={closeConfirmation}
          onReconcile={reconcileAction}
        />
      ) : null}
    </>
  )
}
