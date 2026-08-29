import { useEffect, useReducer, useRef, useState } from 'react'

import { canPerformAction } from '../capability-access.js'
import { ApiError } from '../api.js'
import { fmtMoney, fmtMonthYear, plural } from '../format.js'
import { financeRepository } from '../finance-repository.js'
import { serviceLabel } from '../services.js'
import { useShell } from '../shell-ctx.js'
import { Button, EmptyState, Field, Pill, TableScroll, Tabs } from '../ui.jsx'
import { useRouteParamsSync } from '../ux-patterns.jsx'
import {
  WORKBOOK_FLOW_ACTIONS,
  createWorkbookFlowState,
  matchesWorkbookContinuationImport,
  matchesWorkbookResolutionResult,
  specialistOptionsForSelect,
  workbookFlowReducer,
} from '../workbook-flow.js'
import { WorkbookExport } from './WorkbookExport.jsx'
import { WorkbookImport } from './WorkbookImport.jsx'

const MAIN_SECTIONS = Object.freeze([
  Object.freeze({ value: 'imports', label: 'Importy' }),
  Object.freeze({ value: 'exports', label: 'Eksporty' }),
  Object.freeze({ value: 'entries', label: 'Pozycje rejestru' }),
  Object.freeze({ value: 'unknown', label: 'Okres nieustalony' }),
])
const DETAIL_SECTIONS = Object.freeze([
  Object.freeze({ value: 'source', label: 'Źródło' }),
  Object.freeze({ value: 'quarantine', label: 'Kwarantanna' }),
  Object.freeze({ value: 'conflicts', label: 'Konflikty' }),
  Object.freeze({ value: 'duplicates', label: 'Duplikaty' }),
  Object.freeze({ value: 'resolutions', label: 'Rozstrzygnięcia' }),
  Object.freeze({ value: 'entries', label: 'Pozycje' }),
])
const statusLabel = Object.freeze({
  uploading: 'Przesyłanie', ready: 'Gotowy', materializing: 'Przetwarzanie',
  conflicts: 'Wymaga rozstrzygnięcia', complete: 'Zakończony', failed: 'Niepowodzenie',
})
const statusClass = (status) => (
  Object.hasOwn(statusLabel, status) ? status : 'unknown'
)
const kindLabel = Object.freeze({ expense: 'Wydatek', income: 'Przychód' })
const reasonLabel = Object.freeze({
  SERVICE_DATE_INVALID: 'Niepoprawna data usługi',
  SERVICE_DATE_MISSING: 'Brak daty usługi',
  ORPHAN_AMOUNT: 'Kwota bez przypisanej pozycji',
})
const decisionLabel = Object.freeze({
  recorded: 'Zapisano zestaw przypisań',
  explicit_match: 'Jawnie przypisano specjalistkę',
  blank_assigned_to_julia: 'Przypisano pustą wartość źródłową',
  accepted: 'Przyjęto pozycję z kwarantanny',
  rejected: 'Odrzucono pozycję z kwarantanny',
  person: 'Rozpoznano osobę', counterparty: 'Rozpoznano kontrahenta',
  exclude: 'Wyłączono z projekcji historycznej',
})
const continuationKey = () => `workbook-continue-${crypto.randomUUID()}`
const voidKey = () => `finance-void-${crypto.randomUUID()}`
const dateTime = (value) => new Intl.DateTimeFormat('pl-PL', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw',
}).format(new Date(value))

function ImportList({
  values, onSelect, onContinue, continuing, canContinue, currentActorId, operationBusy,
}) {
  if (values.length === 0) return <EmptyState icon="ledger" title="Brak importów" />
  return <div className="registry-list">{values.map((item) => (
    <article
      className={`registry-list__item registry-list__item--${statusClass(item.status)}`}
      key={item.id}
    >
      <div>
        <h3>Import z {dateTime(item.createdAt)}</h3>
        <Pill tone={item.status === 'complete' ? 'sage' : item.status === 'failed' ? 'error' : 'amber'}>
          {statusLabel[item.status] ?? 'Stan nieustalony'}
        </Pill>
        <p className="muted">
          {item.summary.sourceCount} {plural(
            item.summary.sourceCount, 'pozycja', 'pozycje', 'pozycji',
          )} · {item.summary.quarantineCount} {plural(
            item.summary.quarantineCount, 'pozycja', 'pozycje', 'pozycji',
          )} w kwarantannie
          {' · '}{item.summary.conflictCount === null
            ? 'liczba konfliktów nieustalona'
            : `${item.summary.conflictCount} ${plural(
              item.summary.conflictCount, 'konflikt', 'konflikty', 'konfliktów',
            )}`} · {item.summary.duplicateCount} {plural(
              item.summary.duplicateCount, 'duplikat', 'duplikaty', 'duplikatów',
            )}
        </p>
        <dl className="registry-provenance">
          <div><dt>Id importu</dt><dd>{item.id}</dd></div>
          <div><dt>Id artefaktu</dt><dd>{item.artifact.id}</dd></div>
          <div><dt>Odcisk SHA-256</dt><dd>{item.artifact.fingerprint}</dd></div>
          <div><dt>Rozmiar artefaktu</dt><dd>{item.artifact.byteSize.toLocaleString('pl-PL')} bajtów</dd></div>
          <div><dt>Wersje</dt><dd>Parser {item.artifact.parserVersion} · materializator {item.artifact.materializerVersion}</dd></div>
        </dl>
        {item.progress ? <div className="registry-progress">
          <progress
            aria-label={`Postęp importu z ${dateTime(item.createdAt)}`}
            max={item.progress.total || 1}
            value={item.progress.processed}
          />
          <span aria-live="polite">{item.progress.processed} z {item.progress.total}</span>
        </div> : null}
      </div>
      <div className="registry-list__actions">
        <Button variant="ghost" onClick={(event) => onSelect(item, event.currentTarget)}>
          Przejrzyj import
        </Button>
        {canContinue && item.createdByStaffId === currentActorId
          && ['ready', 'materializing', 'conflicts'].includes(item.status) ? <Button
          disabled={operationBusy}
          onClick={() => onContinue(item)}
        >{continuing === item.id ? 'Wczytywanie…'
            : item.status === 'conflicts' ? 'Rozstrzygnij konflikty' : 'Kontynuuj import'}</Button> : null}
      </div>
    </article>
  ))}</div>
}

function ExportList({ values }) {
  if (values.length === 0) return <EmptyState icon="ledger" title="Brak historii eksportów" />
  return <div className="registry-list">{values.map((item) => <article
    className="registry-list__item registry-list__item--export" key={item.id}
  >
    <div><h3>Eksport z {dateTime(item.createdAt)}</h3>
      <p>{item.format === 'panel-v2' ? 'Panel-v2' : 'Format zgodny'} · {
        item.scope === 'centre' ? 'Zakres centrum' : 'Zakres własny'
      }</p>
      <p className="muted">{item.byteSize.toLocaleString('pl-PL')} bajtów</p>
    </div>
  </article>)}</div>
}

function EntryList({ values, canVoid, onVoid, operationBusy, restoreEntryId, restoreRef }) {
  if (values.length === 0) return <EmptyState icon="ledger" title="Brak pozycji rejestru" />
  return <TableScroll label="Przewijana tabela pozycji rejestru"><table className="table" aria-label="Pozycje rejestru finansowego">
    <thead><tr><th>Miesiąc</th><th>Rodzaj</th><th>Stan</th><th className="right">Kwota</th><th></th></tr></thead>
    <tbody>{values.map((item) => <tr key={item.id}>
      <td>{item.accountingMonth ? fmtMonthYear(item.accountingMonth) : 'Okres nieustalony'}</td>
      <td>{kindLabel[item.kind] ?? 'Nie ustalono'}</td>
      <td>{item.state === 'void' ? 'Unieważniona' : 'Aktywna'}</td>
      <td className="right">{fmtMoney(item.amountGrosze / 100)}</td>
      <td className="right">{canVoid && item.state === 'active' ? <button
        ref={item.id === restoreEntryId ? restoreRef : undefined}
        type="button" className="btn btn--ghost btn--sm"
        disabled={operationBusy}
        onClick={(event) => onVoid(item, event.currentTarget)}
      ><span>Unieważnij pozycję</span></button> : null}</td>
    </tr>)}</tbody>
  </table></TableScroll>
}

function DetailItems({ detail, specialistNames }) {
  if (!detail || detail.items.length === 0) return <EmptyState icon="ledger" title="Brak pozycji w tej sekcji" />
  const visibleSpecialistNames = new Map([
    ...specialistNames,
    ...(detail.specialistLabels ?? []).map(({ id, label }) => [id, label]),
  ])
  return <div className="registry-detail__items">{detail.items.map((item) => {
    if (detail.section === 'source') return <article key={item.id}>
      <h4>Pozycja źródłowa</h4>
      {item.display.sourceLabel ? <p>Opis: {item.display.sourceLabel}</p> : null}
      {item.display.counterparty ? <p>Podmiot: {item.display.counterparty}</p> : null}
      <p>{item.display.accountingMonth ? fmtMonthYear(item.display.accountingMonth) : 'Okres nieustalony'}
        {' · '}{item.display.amountGrosze === null ? 'Kwota nieustalona' : fmtMoney(item.display.amountGrosze / 100)}</p>
      <p className="muted">{item.display.specialistName || 'Specjalistka nieustalona'}</p>
      <p className="muted">Arkusz: {item.sheetName} · wiersz {item.rowNumber}</p>
    </article>
    if (detail.section === 'quarantine') return <article key={item.id}>
      <h4>{reasonLabel[item.primaryReason] ?? 'Pozycja wymaga przeglądu'}</h4>
      <p>{item.reasonCodes.map((reason) => reasonLabel[reason] ?? 'Inny powód').join(' · ')}</p>
    </article>
    if (detail.section === 'conflicts') return <article key={item.id}>
      <h4>{item.resolved ? 'Konflikt rozstrzygnięty' : 'Konflikt wymaga rozstrzygnięcia'}</h4>
      <p>Identyfikator konfliktu: {item.id}</p>
      <p>{item.kind === 'specialist_mapping' ? 'Przypisanie specjalistki' : 'Zmiana danych Panel-v2'}</p>
      {item.kind === 'specialist_mapping' ? <p className="registry-detail__source">
        Wartość źródłowa: <strong>{item.sourceValue || 'brak nazwy'}</strong>
      </p> : null}
    </article>
    if (detail.section === 'duplicates') return <article key={item.id}>
      <h4>Powtórzone źródło</h4><p>{item.count} {plural(
        item.count, 'powiązana pozycja', 'powiązane pozycje', 'powiązanych pozycji',
      )}</p>
    </article>
    if (detail.section === 'resolutions') return <article key={item.id}>
      <h4>{decisionLabel[item.decision] ?? 'Zapisane rozstrzygnięcie'}</h4>
      {item.specialistId ? <p>{visibleSpecialistNames.get(item.specialistId) ?? 'Specjalistka nieustalona'}</p> : null}
      {item.sourceValue !== null ? <p>Wartość źródłowa: <strong>{item.sourceValue}</strong></p> : null}
      {item.sourceRecordId ? <p>Pozycja źródłowa: {item.sourceRecordId}</p> : null}
      {item.conflictId ? <p>Konflikt: {item.conflictId}</p> : null}
      {item.serviceId ? <p>Usługa: {serviceLabel(item.serviceId)}</p> : null}
      {item.targetId ? <p>Wybrany podmiot: {item.targetId}</p> : null}
      <p className="muted">Rozstrzygnęła: {item.resolvedByStaffId}</p>
      {item.choices?.map((choice) => <p key={choice.conflictId}>
        Konflikt {choice.conflictId} — przypisano:{' '}
        {visibleSpecialistNames.get(choice.specialistId) ?? 'Specjalistka nieustalona'}
      </p>)}
      <p className="muted">Zapisano: <time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time></p>
    </article>
    return <article key={item.id}>
      <h4>{kindLabel[item.kind] ?? 'Pozycja finansowa'}</h4>
      <p>{item.accountingMonth ? fmtMonthYear(item.accountingMonth) : 'Okres nieustalony'}
        {' · '}{fmtMoney(item.amountGrosze / 100)}</p>
      <p className="muted">{item.state === 'void' ? 'Unieważniona' : 'Aktywna'}</p>
    </article>
  })}</div>
}

function ResolutionPanel({ flow, values, specialists, onChange, onSubmit, saving, locked, headingRef }) {
  const conflicts = values.filter(({ kind }) => (
    kind === 'specialist_mapping'
  ))
  const selected = new Map(flow.resolutions.map((value) => [
    value.conflictId, value.specialistId,
  ]))
  const complete = conflicts.length > 0
    && conflicts.every(({ id }) => selected.has(id))
  const specialistSelectOptions = specialistOptionsForSelect(specialists)
  return <section className="card card--pad registry-resolutions" aria-labelledby="registry-resolutions-title">
    <h2 className="card-title" id="registry-resolutions-title" ref={headingRef} tabIndex={-1}>Rozstrzygnij przypisania</h2>
    <p className="muted">Każdy konflikt wymaga jawnego przypisania aktywnej specjalistki.</p>
    {conflicts.map((conflict, index) => <div
      className="registry-resolutions__conflict"
      key={conflict.id}
    >
      <p className="registry-resolutions__source">
        Wartość źródłowa: <strong>{conflict.sourceValue || 'brak nazwy'}</strong>
      </p>
      <p>Identyfikator konfliktu: {conflict.id}</p>
      <Field label={`Konflikt przypisania ${index + 1}`}>
        <select
          className="select"
          disabled={saving || locked}
          value={selected.get(conflict.id) ?? ''}
          onChange={(event) => onChange(conflict.id, event.target.value)}
        >
          <option value="">Wybierz specjalistkę</option>
          {specialistSelectOptions.map(({ id, selectLabel }) => (
            <option key={id} value={id}>{selectLabel}</option>
          ))}
        </select>
      </Field>
    </div>)}
    <Button disabled={!complete || saving} onClick={onSubmit}>
      {saving ? 'Zapisywanie rozstrzygnięć…' : 'Zapisz rozstrzygnięcia i kontynuuj'}
    </Button>
  </section>
}

function VoidDialog({ error, onConfirm, onClose, reason, setReason, saving, locked }) {
  const dialogRef = useRef(null)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    dialog?.querySelector('textarea')?.focus()
    return () => { if (dialog?.open) dialog.close() }
  }, [])
  return <dialog
    className="quick-dialog registry-void"
    ref={dialogRef}
    aria-labelledby="registry-void-title"
    onCancel={(event) => { event.preventDefault(); if (!saving && !locked) onClose() }}
    onClick={(event) => {
      if (!saving && !locked && event.target === dialogRef.current) onClose()
    }}
  >
    <h2 id="registry-void-title">Unieważnij pozycję rejestru</h2>
    <p>
      Ta operacja usuwa pozycję z podsumowań. Niezmienny skoroszyt i rekord źródłowy
      pozostają zachowane w historii.
    </p>
    <Field label="Powód unieważnienia">
      <textarea disabled={saving || locked} className="textarea" value={reason} onChange={(event) => setReason(event.target.value)} />
    </Field>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="row"><Button variant="ghost" disabled={saving || locked} onClick={onClose}>Anuluj</Button>
      <Button disabled={reason.trim().length < 3 || saving} onClick={onConfirm}>
        {saving ? 'Unieważnianie…' : 'Potwierdź unieważnienie'}
      </Button></div>
  </dialog>
}

export function Registry({ params = {} }) {
  const { actor, authorityGeneration, capabilities } = useShell()
  const generation = authorityGeneration ?? 0
  const canContinue = canPerformAction(capabilities, 'finance.import.continue')
  const [flow, dispatchFlow] = useReducer(
    workbookFlowReducer, generation, createWorkbookFlowState,
  )
  const [section, setSection] = useState(() => (
    MAIN_SECTIONS.some(({ value }) => value === params.section) ? params.section : 'imports'
  ))
  const [cursor, setCursor] = useState(null)
  const [cursorHistory, setCursorHistory] = useState([])
  const [page, setPage] = useState({ status: 'loading', data: null, error: '' })
  const [reloadToken, setReloadToken] = useState(0)
  const [selectedImport, setSelectedImport] = useState(null)
  const [detailSection, setDetailSection] = useState('source')
  const [detailCursor, setDetailCursor] = useState(null)
  const [detailCursorHistory, setDetailCursorHistory] = useState([])
  const [detail, setDetail] = useState({ status: 'idle', data: null, error: '' })
  const [detailReloadToken, setDetailReloadToken] = useState(0)
  const [continuing, setContinuing] = useState(null)
  const [resolutionCatalog, setResolutionCatalog] = useState(null)
  const [resolutionSaving, setResolutionSaving] = useState(false)
  const [resolutionLocked, setResolutionLocked] = useState(false)
  const [workflowError, setWorkflowError] = useState('')
  const [voidTarget, setVoidTarget] = useState(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidError, setVoidError] = useState('')
  const [voiding, setVoiding] = useState(false)
  const [voidLocked, setVoidLocked] = useState(false)
  const [resultFocusToken, setResultFocusToken] = useState(0)
  const [voidFocusToken, setVoidFocusToken] = useState(0)
  const resultRef = useRef(null)
  const resolutionRef = useRef(null)
  const detailHeadingRef = useRef(null)
  const detailOpenerRef = useRef(null)
  const voidOpenerRef = useRef(null)
  const voidOpenerIdRef = useRef(null)
  const pendingResultFocusRef = useRef(false)
  const pendingResolutionFocusRef = useRef(false)
  const pendingDetailFocusRef = useRef(false)
  const pendingVoidFocusRef = useRef(false)
  const selectedFileRef = useRef(null)
  const mutationControllersRef = useRef({ continuation: null, resolution: null, void: null })
  const continuationKeysRef = useRef(new Map())
  const resolutionKeysRef = useRef(new Map())
  const resolutionRequestsRef = useRef(new Map())
  const voidKeyRef = useRef(null)
  const voidRequestRef = useRef(null)
  const canVoid = canPerformAction(capabilities, 'finance.entry.void')
  const operationBusy = continuing !== null || resolutionSaving || voiding
  const abortMutationControllers = (...operations) => {
    for (const operation of operations) {
      mutationControllersRef.current[operation]?.abort()
      mutationControllersRef.current[operation] = null
    }
  }
  useRouteParamsSync('ledger', { section: section === 'imports' ? undefined : section })
  const queueResultFocus = () => {
    pendingResultFocusRef.current = true
    setResultFocusToken((value) => value + 1)
  }
  const queueVoidFocus = () => {
    pendingVoidFocusRef.current = true
    setVoidFocusToken((value) => value + 1)
  }

  useEffect(() => {
    const next = MAIN_SECTIONS.some(({ value }) => value === params.section)
      ? params.section : 'imports'
    setSection((current) => current === next ? current : next)
    setCursor(null)
    setCursorHistory([])
    setSelectedImport(null)
  }, [params.section])

  useEffect(() => {
    dispatchFlow({ type: WORKBOOK_FLOW_ACTIONS.AUTHORITY_RESET, generation })
    abortMutationControllers('continuation', 'resolution', 'void')
    selectedFileRef.current = null
    setContinuing(null)
    setResolutionCatalog(null)
    setResolutionSaving(false)
    setResolutionLocked(false)
    setWorkflowError('')
    setVoidTarget(null)
    setVoidReason('')
    setVoidError('')
    setVoiding(false)
    setVoidLocked(false)
    continuationKeysRef.current.clear()
    resolutionKeysRef.current.clear()
    resolutionRequestsRef.current.clear()
    voidKeyRef.current = null
    voidRequestRef.current = null
    return () => abortMutationControllers('continuation', 'resolution', 'void')
  }, [generation])

  useEffect(() => {
    if (canContinue) return
    abortMutationControllers('continuation', 'resolution')
    selectedFileRef.current = null
    setContinuing(null)
    setResolutionCatalog(null)
    setResolutionSaving(false)
    setResolutionLocked(false)
    setWorkflowError('')
    dispatchFlow({ type: WORKBOOK_FLOW_ACTIONS.RESET, generation })
  }, [canContinue])

  useEffect(() => {
    if (canVoid) return
    abortMutationControllers('void')
    setVoidTarget(null)
    setVoidReason('')
    setVoidError('')
    setVoiding(false)
    setVoidLocked(false)
    voidKeyRef.current = null
    voidRequestRef.current = null
  }, [canVoid])

  useEffect(() => {
    if (flow.phase !== 'needs-resolution' || !resolutionCatalog
      || !pendingResolutionFocusRef.current) return
    pendingResolutionFocusRef.current = false
    requestAnimationFrame(() => resolutionRef.current?.focus({ preventScroll: true }))
  }, [flow.phase, resolutionCatalog])

  useEffect(() => {
    if (!selectedImport || detail.status !== 'ready' || !pendingDetailFocusRef.current) return
    pendingDetailFocusRef.current = false
    requestAnimationFrame(() => detailHeadingRef.current?.focus({ preventScroll: true }))
  }, [detail.status, selectedImport])

  useEffect(() => {
    if (page.status !== 'ready') return
    if (pendingVoidFocusRef.current) {
      pendingVoidFocusRef.current = false
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const target = voidOpenerRef.current?.isConnected
            ? voidOpenerRef.current : resultRef.current
          target?.focus({ preventScroll: true })
        })
      })
    } else if (pendingResultFocusRef.current) {
      pendingResultFocusRef.current = false
      requestAnimationFrame(() => resultRef.current?.focus({ preventScroll: true }))
    }
  }, [page.status, resultFocusToken, voidFocusToken])

  useEffect(() => {
    const controller = new AbortController()
    setPage({ status: 'loading', data: null, error: '' })
    financeRepository.loadRegistryPage({ cursor, section }, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setPage({ status: 'ready', data, error: '' }) })
      .catch(() => { if (!controller.signal.aborted) setPage({ status: 'error', data: null, error: 'Nie udało się wczytać rejestru.' }) })
    return () => controller.abort()
  }, [cursor, reloadToken, section])

  useEffect(() => {
    if (!selectedImport) {
      setDetail({ status: 'idle', data: null, error: '' })
      return undefined
    }
    const controller = new AbortController()
    setDetail({ status: 'loading', data: null, error: '' })
    financeRepository.loadRegistryDetail({
      importId: selectedImport.id, section: detailSection, cursor: detailCursor,
    }, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setDetail({ status: 'ready', data, error: '' }) })
      .catch(() => { if (!controller.signal.aborted) setDetail({ status: 'error', data: null, error: 'Nie udało się wczytać szczegółów.' }) })
    return () => controller.abort()
  }, [detailCursor, detailReloadToken, detailSection, selectedImport])

  const refresh = () => {
    setCursor(null)
    setCursorHistory([])
    setDetailCursor(null)
    setDetailCursorHistory([])
    setReloadToken((value) => value + 1)
    setDetailReloadToken((value) => value + 1)
  }
  const loadConflictCatalog = async (importId, signal) => {
    const items = []
    let nextCursor = null
    let planDigest = null
    let specialistOptions = null
    do {
      const pageResult = await financeRepository.loadRegistryDetail({
        importId, section: 'conflicts', cursor: nextCursor,
      }, { signal })
      if (planDigest !== null && pageResult.planDigest !== planDigest) {
        throw new Error('WORKBOOK_CONFLICT_CATALOG_CHANGED')
      }
      planDigest = pageResult.planDigest
      if (specialistOptions !== null && JSON.stringify(pageResult.specialistOptions)
        !== JSON.stringify(specialistOptions)) {
        throw new Error('WORKBOOK_CONFLICT_CATALOG_CHANGED')
      }
      specialistOptions = pageResult.specialistOptions
      items.push(...pageResult.items.filter(({ id, kind }) => (
        kind === 'specialist_mapping' && id.startsWith('wmc_')
      )))
      if (items.length > 100) throw new Error('WORKBOOK_CONFLICT_CATALOG_LIMIT')
      nextCursor = pageResult.nextCursor
    } while (nextCursor !== null)
    return { planDigest, items, specialistOptions: specialistOptions ?? [] }
  }
  const continueImport = async (item) => {
    if (!canContinue || operationBusy) return
    const controller = new AbortController()
    mutationControllersRef.current.continuation = controller
    setContinuing(item.id)
    setPage((current) => ({ ...current, error: '' }))
    let transitionQueued = false
    try {
      const status = await financeRepository.getWorkbookImport(item.id, {
        signal: controller.signal,
      })
      const expected = {
        importId: item.id, importVersion: item.version,
        createdByStaffId: item.createdByStaffId,
      }
      if (!matchesWorkbookContinuationImport(status.import, expected)) {
        throw new Error('WORKBOOK_CONTINUATION_AUTHORITY_CHANGED')
      }
      const imported = { ...status.import, resolutionVersion: item.resolutionVersion }
      let planDigest = null
      let catalog = null
      if (status.import.status === 'conflicts') {
        catalog = await loadConflictCatalog(item.id, controller.signal)
        planDigest = catalog.planDigest
      }
      const sameFlow = flow.continuation?.importId === item.id
        && ['materializing', 'needs-resolution'].includes(flow.phase)
      if (!sameFlow && !['idle', 'failed', 'complete'].includes(flow.phase)) {
        dispatchFlow({ type: WORKBOOK_FLOW_ACTIONS.RESET, generation })
        resolutionKeysRef.current.clear()
        resolutionRequestsRef.current.clear()
        setResolutionCatalog(null)
        setResolutionLocked(false)
        setWorkflowError('')
      }
      transitionQueued = true
      dispatchFlow({
        type: sameFlow ? WORKBOOK_FLOW_ACTIONS.STATUS_SUCCEEDED
          : WORKBOOK_FLOW_ACTIONS.BATCH_SELECTED,
        generation,
        imported,
        ...(!sameFlow || status.import.status === 'conflicts' ? { planDigest } : {}),
      })
      if (status.import.status === 'conflicts') {
        pendingResolutionFocusRef.current = true
        setResolutionCatalog(catalog)
        return
      }
      if (status.import.status === 'complete') {
        queueResultFocus()
        refresh()
        return
      }
      dispatchFlow({ type: WORKBOOK_FLOW_ACTIONS.CONTINUE_STARTED, generation })
      const keyId = `${item.id}:${status.import.version}`
      if (!continuationKeysRef.current.has(keyId)) {
        continuationKeysRef.current.set(keyId, continuationKey())
      }
      const continued = await financeRepository.continueWorkbookImport(
        item.id, status.import.version, {
          idempotencyKey: continuationKeysRef.current.get(keyId), signal: controller.signal,
        },
      )
      if (!matchesWorkbookContinuationImport(continued.import, expected, {
        requireNewer: true,
      })) throw new Error('WORKBOOK_CONTINUATION_AUTHORITY_CHANGED')
      let continuedCatalog = null
      if (continued.import.status === 'conflicts') {
        continuedCatalog = await loadConflictCatalog(item.id, controller.signal)
      }
      dispatchFlow({
        type: WORKBOOK_FLOW_ACTIONS.STATUS_SUCCEEDED,
        generation,
        imported: continued.import,
        ...(continuedCatalog ? { planDigest: continuedCatalog.planDigest } : {}),
      })
      continuationKeysRef.current.delete(keyId)
      if (continuedCatalog) {
        pendingResolutionFocusRef.current = true
        setResolutionCatalog(continuedCatalog)
        return
      }
      queueResultFocus()
      refresh()
    } catch {
      if (!controller.signal.aborted) {
        if (transitionQueued) dispatchFlow({
          type: WORKBOOK_FLOW_ACTIONS.REQUEST_FAILED,
          generation,
          errorCode: 'WORKBOOK_CONTINUE_FAILED',
        })
        setPage((current) => ({ ...current, error: 'Nie udało się kontynuować importu.' }))
      }
    } finally {
      if (mutationControllersRef.current.continuation === controller) {
        mutationControllersRef.current.continuation = null
        setContinuing(null)
      }
    }
  }
  const changeRecordedResolution = (conflictId, specialistId) => dispatchFlow({
    type: WORKBOOK_FLOW_ACTIONS.RESOLUTION_CHANGED,
    generation,
    conflictId,
    specialistId: specialistId || null,
  })
  const recordResolutions = async () => {
    const continuation = flow.continuation
    if (!canContinue || operationBusy || !continuation || !resolutionCatalog
      || continuation.planDigest !== resolutionCatalog.planDigest
      || continuation.resolutionVersion === null) return
    const controller = new AbortController()
    mutationControllersRef.current.resolution = controller
    setResolutionSaving(true)
    const resolutionKeyId = `${continuation.importId}:${continuation.resolutionVersion}`
    if (!resolutionKeysRef.current.has(resolutionKeyId)) {
      resolutionKeysRef.current.set(resolutionKeyId, `workbook-resolution-${crypto.randomUUID()}`)
    }
    if (!resolutionRequestsRef.current.has(resolutionKeyId)) {
      resolutionRequestsRef.current.set(resolutionKeyId, Object.freeze({
        expectedVersion: continuation.resolutionVersion,
        planDigest: continuation.planDigest,
        resolutions: flow.resolutions,
      }))
    }
    const request = resolutionRequestsRef.current.get(resolutionKeyId)
    setWorkflowError('')
    try {
      const recorded = await financeRepository.recordWorkbookResolutions(
        continuation.importId,
        request,
        { idempotencyKey: resolutionKeysRef.current.get(resolutionKeyId), signal: controller.signal },
      )
      if (!matchesWorkbookResolutionResult(recorded, continuation)) {
        throw new Error('WORKBOOK_RESOLUTION_AUTHORITY_CHANGED')
      }
      dispatchFlow({
        type: WORKBOOK_FLOW_ACTIONS.RESOLUTIONS_RECORDED,
        generation,
        result: recorded,
      })
      resolutionKeysRef.current.delete(resolutionKeyId)
      resolutionRequestsRef.current.delete(resolutionKeyId)
      setResolutionLocked(false)
      dispatchFlow({ type: WORKBOOK_FLOW_ACTIONS.CONTINUE_STARTED, generation })
      const continuationKeyId = `${continuation.importId}:${recorded.importVersion}`
      if (!continuationKeysRef.current.has(continuationKeyId)) {
        continuationKeysRef.current.set(continuationKeyId, continuationKey())
      }
      const continued = await financeRepository.continueWorkbookImport(
        continuation.importId, recorded.importVersion, {
          idempotencyKey: continuationKeysRef.current.get(continuationKeyId),
          signal: controller.signal,
        },
      )
      if (!matchesWorkbookContinuationImport(continued.import, {
        ...continuation, importVersion: recorded.importVersion,
      }, { requireNewer: true })) {
        throw new Error('WORKBOOK_CONTINUATION_AUTHORITY_CHANGED')
      }
      let continuedCatalog = null
      if (continued.import.status === 'conflicts') {
        continuedCatalog = await loadConflictCatalog(
          continuation.importId, controller.signal,
        )
      }
      dispatchFlow({
        type: WORKBOOK_FLOW_ACTIONS.STATUS_SUCCEEDED,
        generation,
        imported: continued.import,
        ...(continuedCatalog ? { planDigest: continuedCatalog.planDigest } : {}),
      })
      continuationKeysRef.current.delete(continuationKeyId)
      if (continuedCatalog) {
        pendingResolutionFocusRef.current = true
        setResolutionCatalog(continuedCatalog)
        return
      }
      setResolutionCatalog(null)
      queueResultFocus()
      refresh()
    } catch (error) {
      if (!controller.signal.aborted) {
        const key = resolutionKeysRef.current.get(resolutionKeyId)
        if (error instanceof ApiError && error.idempotencyKey === key) {
          setResolutionLocked(true)
          setWorkflowError('Nie potwierdzono zapisu. Ponów dokładnie ten sam zestaw rozstrzygnięć.')
        } else {
          resolutionKeysRef.current.delete(resolutionKeyId)
          resolutionRequestsRef.current.delete(resolutionKeyId)
          setResolutionLocked(false)
          setResolutionCatalog(null)
          dispatchFlow({
            type: WORKBOOK_FLOW_ACTIONS.REQUEST_FAILED,
            generation,
            errorCode: 'WORKBOOK_RESOLUTION_FAILED',
          })
          setWorkflowError('Rozstrzygnięcia odrzucono. Rejestr został odświeżony.')
          refresh()
        }
      }
    } finally {
      if (mutationControllersRef.current.resolution === controller) {
        mutationControllersRef.current.resolution = null
        setResolutionSaving(false)
      }
    }
  }
  const confirmVoid = async () => {
    if (!voidTarget || voidReason.trim().length < 3 || operationBusy || !canVoid) return
    const controller = new AbortController()
    mutationControllersRef.current.void = controller
    setVoiding(true)
    voidKeyRef.current ??= voidKey()
    voidRequestRef.current ??= Object.freeze({
      key: voidKeyRef.current, reason: voidReason.trim(),
    })
    const request = voidRequestRef.current
    try {
      await financeRepository.voidLedgerEntry(
        voidTarget.id, voidTarget.version, request.reason,
        { idempotencyKey: request.key, signal: controller.signal },
      )
      setVoidTarget(null)
      setVoidReason('')
      voidKeyRef.current = null
      voidRequestRef.current = null
      setVoidLocked(false)
      queueVoidFocus()
      refresh()
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof ApiError && error.idempotencyKey === request.key) {
          setVoidLocked(true)
          setVoidError('Nie potwierdzono zapisu. Ponów dokładnie ten sam powód unieważnienia.')
        } else {
          voidKeyRef.current = null
          voidRequestRef.current = null
          setVoidLocked(false)
          setVoidError('Nie udało się unieważnić pozycji. Możesz poprawić powód i spróbować ponownie.')
        }
      }
    } finally {
      if (mutationControllersRef.current.void === controller) {
        mutationControllersRef.current.void = null
        setVoiding(false)
      }
    }
  }
  const values = page.data?.[section === 'unknown' ? 'entries' : section] ?? []
  const handleCommitted = () => {
    queueResultFocus()
    refresh()
  }

  return (
    <div className="registry-view">
      <div className="view-head registry-view__hero"><div>
        <div className="eyebrow">Pochodzenie danych</div>
        <h1 className="display view-head__title" ref={resultRef} tabIndex={-1}>Rejestr <em>skoroszytów</em></h1>
        <p className="view-head__sub">Historia importów, eksportów i jawnych rozstrzygnięć.</p>
      </div></div>
      <div className="registry-view__workflows">
        <WorkbookImport
          flow={flow}
          dispatchFlow={dispatchFlow}
          generation={generation}
          selectedFileRef={selectedFileRef}
          onCommitted={handleCommitted}
        />
        <WorkbookExport onComplete={refresh} />
      </div>
      {flow.phase === 'needs-resolution' && resolutionCatalog ? <ResolutionPanel
        flow={flow}
        values={resolutionCatalog.items}
        specialists={resolutionCatalog.specialistOptions}
        onChange={changeRecordedResolution}
        onSubmit={recordResolutions}
        saving={resolutionSaving}
        locked={resolutionLocked}
        headingRef={resolutionRef}
      /> : null}
      <Tabs options={MAIN_SECTIONS} value={section} onChange={(next) => {
        setSection(next)
        setCursor(null)
        setCursorHistory([])
        setSelectedImport(null)
      }} ariaLabel="Sekcje rejestru">
        {page.status === 'loading' ? <p role="status">Wczytywanie rejestru…</p>
          : page.status === 'error' ? <EmptyState icon="ledger" title="Rejestr jest teraz niedostępny" action={<Button onClick={refresh}>Spróbuj ponownie</Button>} />
            : section === 'imports' ? <ImportList
              values={values}
              onSelect={(item, opener) => {
                detailOpenerRef.current = opener
                pendingDetailFocusRef.current = true
                setSelectedImport(item)
                setDetailSection('source')
                setDetailCursor(null)
                setDetailCursorHistory([])
              }}
              onContinue={continueImport}
              continuing={continuing}
              canContinue={canContinue}
              currentActorId={actor?.id}
              operationBusy={operationBusy}
            />
              : section === 'exports' ? <ExportList values={values} />
                : <EntryList values={values} canVoid={canVoid} operationBusy={operationBusy} onVoid={(item, opener) => {
                  voidOpenerIdRef.current = item.id
                  voidOpenerRef.current = opener
                  setVoidTarget(item); setVoidReason(''); setVoidError(''); setVoiding(false)
                  setVoidLocked(false); voidRequestRef.current = null
                  voidKeyRef.current = voidKey()
                }} restoreEntryId={voidOpenerIdRef.current} restoreRef={voidOpenerRef} />}
      </Tabs>
      {page.status === 'ready' ? <div className="row registry-paging">
        {cursorHistory.length > 0 ? <Button variant="ghost" onClick={() => {
          const previous = cursorHistory.at(-1)
          setCursorHistory((values) => values.slice(0, -1))
          setCursor(previous)
        }}>Poprzednia strona</Button> : null}
        {page.data?.nextCursor ? <Button variant="ghost" onClick={() => {
          setCursorHistory((values) => [...values, cursor])
          setCursor(page.data.nextCursor)
        }}>Następna strona</Button> : null}
      </div> : null}
      {page.error ? <p className="form-error" role="alert">{page.error}</p> : null}
      {workflowError ? <p className="form-error" role="alert">{workflowError}</p> : null}
      {selectedImport ? <section className="card card--pad registry-detail" aria-labelledby="registry-detail-title">
        <div className="registry-detail__head"><h2
          className="card-title"
          id="registry-detail-title"
          ref={detailHeadingRef}
          tabIndex={-1}
        >Szczegóły importu</h2>
          <Button variant="ghost" onClick={() => {
            setSelectedImport(null)
            setDetailSection('source')
            setDetailCursor(null)
            setDetailCursorHistory([])
            pendingDetailFocusRef.current = false
            requestAnimationFrame(() => {
              const target = detailOpenerRef.current?.isConnected
                ? detailOpenerRef.current : resultRef.current
              target?.focus({ preventScroll: true })
            })
          }}>Zamknij szczegóły</Button></div>
        <Tabs options={DETAIL_SECTIONS} value={detailSection} onChange={(next) => {
          setDetailSection(next); setDetailCursor(null); setDetailCursorHistory([])
        }} ariaLabel="Szczegóły importu">
          {detail.status === 'loading' ? <p role="status">Wczytywanie szczegółów…</p>
            : detail.status === 'error' ? <p role="alert">{detail.error}</p>
              : <DetailItems detail={detail.data} specialistNames={new Map()} />}
        </Tabs>
        {detail.status === 'ready' ? <div className="row registry-paging">
          {detailCursorHistory.length > 0 ? <Button variant="ghost" onClick={() => {
            const previous = detailCursorHistory.at(-1)
            setDetailCursorHistory((values) => values.slice(0, -1))
            setDetailCursor(previous)
          }}>Poprzednia strona szczegółów</Button> : null}
          {detail.data?.nextCursor ? <Button variant="ghost" onClick={() => {
            setDetailCursorHistory((values) => [...values, detailCursor])
            setDetailCursor(detail.data.nextCursor)
          }}>Następna strona szczegółów</Button> : null}
        </div> : null}
      </section> : null}
      {voidTarget ? <VoidDialog
        error={voidError}
        onConfirm={confirmVoid}
        onClose={() => {
          setVoidTarget(null)
          setVoiding(false)
          setVoidLocked(false)
          voidKeyRef.current = null
          voidRequestRef.current = null
          requestAnimationFrame(() => voidOpenerRef.current?.focus({ preventScroll: true }))
        }}
        reason={voidReason}
        setReason={setVoidReason}
        saving={voiding}
        locked={voidLocked}
      /> : null}
    </div>
  )
}
