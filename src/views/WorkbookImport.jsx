import { useEffect, useMemo, useRef, useState } from 'react'

import { canPerformAction } from '../capability-access.js'
import { ApiError } from '../api.js'
import { financeRepository } from '../finance-repository.js'
import { fmtMonthYear, fmtShortDate, plural } from '../format.js'
import { useShell } from '../shell-ctx.js'
import { WORKBOOK_FLOW_ACTIONS } from '../workbook-flow.js'
import { Button, EmptyState, Field } from '../ui.jsx'

const importKey = () => `workbook-import-${crypto.randomUUID()}`

const warningText = ({ code, count }) => {
  if (code === 'DUPLICATE_SOURCE_RECORD') {
    return `${count} ${plural(
      count, 'powtórzona pozycja źródłowa', 'powtórzone pozycje źródłowe',
      'powtórzonych pozycji źródłowych',
    )}`
  }
  if (code === 'AMOUNT_STORED_AS_TEXT') {
    return `${count} ${plural(
      count, 'kwota zapisana jako tekst', 'kwoty zapisane jako tekst',
      'kwot zapisanych jako tekst',
    )}`
  }
  return `${count} ${plural(
    count, 'ostrzeżenie wymaga', 'ostrzeżenia wymagają', 'ostrzeżeń wymaga',
  )} przeglądu`
}

const quarantineReason = Object.freeze({
  SERVICE_DATE_INVALID: 'Niepoprawna data usługi',
  SERVICE_DATE_MISSING: 'Brak daty usługi',
  ORPHAN_AMOUNT: 'Kwota bez przypisanej pozycji',
})
const panelFieldLabel = Object.freeze({
  accountingMonth: 'miesiąc księgowy', occurredOn: 'data', amountGrosze: 'kwota',
  paidAmountGrosze: 'zapłacono', paymentMethod: 'sposób płatności',
  settlementStatus: 'rozliczenie', invoiceStatus: 'faktura', specialistId: 'specjalistka',
})
const panelConflictLabel = Object.freeze({
  PANEL_CONCURRENT_EDIT: 'Równoległa zmiana pola',
  PANEL_CONCURRENT_VOID: 'Pozycja została równolegle unieważniona',
  PANEL_ROW_MISSING: 'Pozycja nie istnieje już w rejestrze',
  PANEL_VALUE_INVALID: 'Niepoprawna wartość pola',
  PANEL_DEPENDENCY_CONFLICT: 'Pozycja ma aktywne powiązanie i nie może być zmieniona w pliku',
})
const panelEnumLabel = Object.freeze({
  paymentMethod: Object.freeze({
    blik: 'BLIK', card: 'Karta', cash: 'Gotówka', monthly: 'Miesięcznie',
    other: 'Inna', transfer: 'Przelew', unknown: 'Nie ustalono',
  }),
  settlementStatus: Object.freeze({
    paid: 'Opłacona', partial: 'Częściowo opłacona',
    unknown: 'Nie ustalono', unpaid: 'Nieopłacona',
  }),
  invoiceStatus: Object.freeze({
    action_required: 'Wymaga wystawienia', issued: 'Wystawiona',
    not_issued: 'Niewystawiona', not_required: 'Nie wymaga', unknown: 'Do sprawdzenia',
  }),
})
const panelValueText = (field, value, specialistNames) => {
  if (value === null) return 'brak wartości'
  if (field === 'amountGrosze' || field === 'paidAmountGrosze') {
    return `${(value / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2 })} zł`
  }
  if (field === 'specialistId') {
    return specialistNames.get(value) ?? 'Specjalistka nieustalona'
  }
  if (field === 'accountingMonth') return fmtMonthYear(value)
  if (field === 'occurredOn') return fmtShortDate(value)
  if (panelEnumLabel[field]) return panelEnumLabel[field][value] ?? 'Nie ustalono'
  if (typeof value === 'boolean') return value ? 'tak' : 'nie'
  return String(value)
}

export function WorkbookImport({
  flow, dispatchFlow, generation, selectedFileRef, onCommitted,
}) {
  const { capabilities } = useShell()
  const [inputGeneration, setInputGeneration] = useState(0)
  const [commitLocked, setCommitLocked] = useState(false)
  const controllerRef = useRef(null)
  const commitKeyRef = useRef(null)
  const commitRequestRef = useRef(null)
  const authorityGenerationRef = useRef(generation)
  const headingRef = useRef(null)
  const pendingHeadingFocusRef = useRef(false)
  const allowed = canPerformAction(capabilities, 'finance.import.preview')
    && canPerformAction(capabilities, 'finance.import.create')
  const specialists = flow.preview?.specialistOptions ?? []
  const specialistNames = useMemo(() => new Map(
    (flow.preview?.specialistLabels ?? []).map(({ id, label }) => [id, label]),
  ), [flow.preview?.specialistLabels])
  const conflicts = flow.preview?.mappingConflicts ?? []
  const resolutionByConflict = new Map(flow.resolutions.map((item) => [
    item.conflictId, item.specialistId,
  ]))
  const complete = conflicts.every(({ id }) => resolutionByConflict.has(id))
  const blocked = flow.preview?.hasBlockingConflicts === true
  const panelConflicts = (flow.preview?.conflicts ?? []).filter(({ code }) => (
    code.startsWith('PANEL_')
  ))
  const busy = ['previewing', 'committing', 'continuing', 'materializing', 'needs-resolution']
    .includes(flow.phase)

  useEffect(() => () => controllerRef.current?.abort(), [])

  useEffect(() => {
    const authorityChanged = authorityGenerationRef.current !== generation
    authorityGenerationRef.current = generation
    if (!authorityChanged && allowed) return
    controllerRef.current?.abort()
    controllerRef.current = null
    selectedFileRef.current = null
    commitKeyRef.current = null
    commitRequestRef.current = null
    setCommitLocked(false)
    pendingHeadingFocusRef.current = false
    setInputGeneration((value) => value + 1)
  }, [allowed, generation, selectedFileRef])

  useEffect(() => {
    if (!pendingHeadingFocusRef.current || flow.phase !== 'review' || !flow.preview) return
    pendingHeadingFocusRef.current = false
    headingRef.current?.focus({ preventScroll: true })
  }, [flow.phase, flow.preview])

  const clearFileInput = () => {
    selectedFileRef.current = null
    commitKeyRef.current = null
    commitRequestRef.current = null
    setCommitLocked(false)
    setInputGeneration((value) => value + 1)
  }
  const fail = (errorCode) => {
    clearFileInput()
    dispatchFlow({ type: WORKBOOK_FLOW_ACTIONS.REQUEST_FAILED, generation, errorCode })
  }
  const chooseFile = async (event) => {
    const input = event.currentTarget
    const file = input.files?.[0] ?? null
    input.value = ''
    controllerRef.current?.abort()
    dispatchFlow({ type: WORKBOOK_FLOW_ACTIONS.RESET, generation })
    selectedFileRef.current = null
    commitKeyRef.current = null
    commitRequestRef.current = null
    setCommitLocked(false)
    if (!file) return
    selectedFileRef.current = file
    commitKeyRef.current = importKey()
    dispatchFlow({ type: WORKBOOK_FLOW_ACTIONS.FILE_SELECTED, generation })
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const preview = await financeRepository.previewWorkbook(file, { signal: controller.signal })
      if (controller.signal.aborted) return
      pendingHeadingFocusRef.current = true
      dispatchFlow({
        type: WORKBOOK_FLOW_ACTIONS.PREVIEW_SUCCEEDED, generation, preview,
      })
    } catch {
      if (!controller.signal.aborted) fail('WORKBOOK_PREVIEW_FAILED')
    }
  }

  const changeResolution = (conflictId, specialistId) => dispatchFlow({
    type: WORKBOOK_FLOW_ACTIONS.RESOLUTION_CHANGED,
    generation,
    conflictId,
    specialistId: specialistId || null,
  })

  const commit = async () => {
    const selectedFile = selectedFileRef.current
    if (!selectedFile || !flow.preview || !complete || blocked || flow.phase !== 'review') return
    const controller = new AbortController()
    controllerRef.current?.abort()
    controllerRef.current = controller
    dispatchFlow({ type: WORKBOOK_FLOW_ACTIONS.COMMIT_STARTED, generation })
    commitRequestRef.current ??= Object.freeze({
      previewToken: flow.preview.previewToken,
      resolutions: flow.resolutions,
    })
    const request = commitRequestRef.current
    try {
      const imported = await financeRepository.createWorkbookImport(
        selectedFile, request.previewToken, request.resolutions,
        { idempotencyKey: commitKeyRef.current, signal: controller.signal },
      )
      if (controller.signal.aborted) return
      dispatchFlow({
        type: WORKBOOK_FLOW_ACTIONS.COMMIT_SUCCEEDED, generation, imported,
      })
      clearFileInput()
      onCommitted?.(imported)
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof ApiError && error.idempotencyKey === commitKeyRef.current) {
          setCommitLocked(true)
          dispatchFlow({
            type: WORKBOOK_FLOW_ACTIONS.REQUEST_FAILED,
            generation,
            errorCode: 'WORKBOOK_COMMIT_FAILED',
          })
        } else fail('WORKBOOK_COMMIT_REJECTED')
      }
    }
  }

  if (!allowed) return null
  return (
    <section className="card card--pad workbook-import" aria-labelledby="workbook-import-title">
      <h2 className="card-title" id="workbook-import-title">Import skoroszytu</h2>
      <Field label="Wybierz plik XLSX" hint="Plik trafia bezpośrednio do bezpiecznego podglądu na serwerze.">
        <input
          key={inputGeneration}
          className="input"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={chooseFile}
          disabled={busy || commitLocked}
        />
      </Field>
      {flow.phase === 'previewing' ? <p role="status">Przygotowywanie podglądu…</p> : null}
      {flow.preview ? <section className="workbook-import__review" aria-labelledby="workbook-preview-title">
        <h3 id="workbook-preview-title" ref={headingRef} tabIndex={-1}>
          Podgląd — nic nie zostało zapisane
        </h3>
        <dl className="workbook-import__counts">
          <div><dt>Przyjęte wiersze</dt><dd>{flow.preview.reconciliation.acceptedRows}</dd></div>
          <div><dt>Kwarantanna</dt><dd>{flow.preview.reconciliation.quarantinedRows}</dd></div>
          <div><dt>Wykluczone formuły</dt><dd>{flow.preview.reconciliation.excludedFormulaRows}</dd></div>
        </dl>
        {flow.preview.proposedMappings.length > 0 ? <section
          className="workbook-import__evidence"
          aria-labelledby="workbook-preview-mappings"
        >
          <h4 id="workbook-preview-mappings">Proponowane przypisania</h4>
          <ul>{flow.preview.proposedMappings.map((mapping, index) => <li
            key={`${mapping.specialistId}:${index}`}
          >
            {mapping.sourceValue || 'Brak nazwy'} → {mapping.displayName}
          </li>)}</ul>
        </section> : null}
        {flow.preview.warnings.length > 0 ? <section
          className="workbook-import__evidence"
          aria-labelledby="workbook-preview-warnings"
        >
          <h4 id="workbook-preview-warnings">Duplikaty i ostrzeżenia</h4>
          <ul>{flow.preview.warnings.map((warning, index) => <li
            key={`${warning.code}:${index}`}
          >{warningText(warning)}</li>)}</ul>
        </section> : null}
        {flow.preview.quarantine.length > 0 ? <section
          className="workbook-import__evidence"
          aria-labelledby="workbook-preview-quarantine"
        >
          <h4 id="workbook-preview-quarantine">Pozycje w kwarantannie</h4>
          <ul>{flow.preview.quarantine.map((item, index) => <li
            key={`quarantine:${index}`}
          >
            <strong>{item.sheet} · wiersz {item.rowNumber}</strong>
            <span>{item.reasonCodes.map((code) => (
              quarantineReason[code] ?? 'Powód wymaga przeglądu'
            )).join(', ')}</span>
          </li>)}</ul>
        </section> : null}
        {flow.preview.panelChanges ? <section
          className="workbook-import__evidence"
          aria-labelledby="workbook-preview-panel-changes"
        >
          <h4 id="workbook-preview-panel-changes">Zmiany Panel-v2</h4>
          {flow.preview.panelChanges.updates.length > 0 ? <>
            <p>Pozycje do zmiany</p>
            <ul>{flow.preview.panelChanges.updates.map((update, index) => <li
              key={`panel-update:${index}`}
            >
              <strong>{update.id}</strong>: {Object.entries(update.values).map(
                ([field, value]) => `${panelFieldLabel[field]} — ${panelValueText(
                  field, value, specialistNames,
                )}`,
              ).join(', ')}
            </li>)}</ul>
          </> : <p>Brak zmian pól.</p>}
          {flow.preview.panelChanges.voidIds.length > 0 ? <>
            <p>Pozycje do unieważnienia</p>
            <ul>{flow.preview.panelChanges.voidIds.map((id, index) => <li
              key={`panel-void:${index}`}
            >{id}</li>)}</ul>
          </> : <p>Brak unieważnień.</p>}
        </section> : null}
        {conflicts.length > 0 ? <section
          className="workbook-import__evidence"
          aria-labelledby="workbook-preview-conflicts"
        >
          <h4 id="workbook-preview-conflicts">Konflikty przypisań</h4>
          {conflicts.map((conflict, index) => (
            <div className="workbook-import__conflict" key={conflict.id}>
              <p>Wartość źródłowa: <strong>{conflict.sourceValue || 'brak nazwy'}</strong></p>
              <Field label={`Wybierz specjalistkę — konflikt ${index + 1}`}>
                <select
                  className="select"
                  disabled={commitLocked || flow.phase === 'committing'}
                  value={resolutionByConflict.get(conflict.id) ?? ''}
                  onChange={(event) => changeResolution(conflict.id, event.target.value)}
                >
                  <option value="">Wybierz specjalistkę</option>
                  {specialists.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
                </select>
              </Field>
            </div>
          ))}
        </section> : null}
        {blocked ? <section className="workbook-import__evidence">
          <EmptyState
            icon="ledger"
            title="Zmiany Panel-v2 wymagają osobnego przeglądu"
            hint="Ten podgląd jest blokujący i nie może zostać zapisany automatycznie."
          />
          <ul>{panelConflicts.map((conflict, index) => <li key={`panel-conflict:${index}`}>
            <strong>{conflict.recordId}</strong> — {panelConflictLabel[conflict.code]}
            {conflict.field ? `: ${panelFieldLabel[conflict.field]}` : ''}
            {conflict.code === 'PANEL_CONCURRENT_EDIT' ? <span>
              {' '}· obecnie: {panelValueText(conflict.field, conflict.current, specialistNames)}
              {' '}· w pliku: {panelValueText(conflict.field, conflict.edited, specialistNames)}
            </span> : null}
          </li>)}</ul>
        </section> : null}
        <Button disabled={!complete || blocked || flow.phase !== 'review'} onClick={commit}>
          {flow.phase === 'committing' ? 'Zapisywanie…' : 'Zapisz i rozpocznij import'}
        </Button>
        {commitLocked ? <p className="muted">
          Wybory są zablokowane do czasu ponowienia dokładnie tej samej operacji.
        </p> : null}
      </section> : null}
      {flow.phase === 'materializing' ? <p role="status">Import zapisany. Możesz kontynuować przetwarzanie poniżej.</p> : null}
      {flow.phase === 'complete' ? <p role="status">Import został zakończony.</p> : null}
      {flow.phase === 'review' && flow.errorCode === 'WORKBOOK_COMMIT_FAILED'
        ? <p className="form-error" role="alert">
          Nie udało się potwierdzić zapisu. Ten sam plik i klucz operacji zostały zachowane do bezpiecznej ponownej próby.
        </p> : null}
      {flow.phase === 'failed' && ['WORKBOOK_COMMIT_REJECTED', 'WORKBOOK_PREVIEW_FAILED']
        .includes(flow.errorCode) ? <p className="form-error" role="alert">
        Nie udało się zakończyć operacji. Plik został usunięty z pamięci przeglądarki.
      </p> : null}
    </section>
  )
}
