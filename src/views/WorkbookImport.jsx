import { useEffect, useMemo, useRef, useState } from 'react'

import { canPerformAction } from '../capability-access.js'
import { ApiError } from '../api.js'
import { financeRepository } from '../finance-repository.js'
import { fmtMonthYear, fmtShortDate, plural } from '../format.js'
import { useShell } from '../shell-ctx.js'
import { specialistOptionsForSelect, WORKBOOK_FLOW_ACTIONS } from '../workbook-flow.js'
import { Button, EmptyState, Field } from '../ui.jsx'

const importKey = () => `workbook-import-${crypto.randomUUID()}`

const warningText = ({ code, count }) => {
  if (code === 'DUPLICATE_SOURCE_RECORD') {
    return `${count} ${plural(
      count, 'powtórzony wiersz', 'powtórzone wiersze', 'powtórzonych wierszy',
    )}`
  }
  if (code === 'AMOUNT_STORED_AS_TEXT') {
    return `${count} ${plural(
      count, 'kwota zapisana jako tekst', 'kwoty zapisane jako tekst',
      'kwot zapisanych jako tekst',
    )}`
  }
  return `${count} ${plural(
    count, 'wiersz', 'wiersze', 'wierszy',
  )} do sprawdzenia`
}

const quarantineReason = Object.freeze({
  SERVICE_DATE_INVALID: 'Niepoprawna data usługi',
  SERVICE_DATE_MISSING: 'Brak daty usługi',
  ORPHAN_AMOUNT: 'Kwota bez przypisanej pozycji',
})
const panelFieldLabel = Object.freeze({
  accountingMonth: 'miesiąc rozliczenia', occurredOn: 'data', amountGrosze: 'kwota',
  paidAmountGrosze: 'wpłacono', paymentMethod: 'forma płatności',
  settlementStatus: 'status płatności', invoiceStatus: 'faktura', specialistId: 'specjalistka',
})
const panelConflictLabel = Object.freeze({
  PANEL_CONCURRENT_EDIT: 'Ktoś w międzyczasie zmienił to pole w panelu',
  PANEL_CONCURRENT_VOID: 'Ktoś w międzyczasie usunął tę pozycję z rozliczeń',
  PANEL_ROW_MISSING: 'Tej pozycji nie ma już w panelu',
  PANEL_VALUE_INVALID: 'Niepoprawna wartość pola',
  PANEL_DEPENDENCY_CONFLICT: 'Tę pozycję można zmienić tylko w panelu, nie w pliku',
})
const panelEnumLabel = Object.freeze({
  paymentMethod: Object.freeze({
    blik: 'BLIK', card: 'Karta', cash: 'Gotówka', monthly: 'Miesięcznie',
    other: 'Inna', transfer: 'Przelew', unknown: 'Nie ustalono',
  }),
  settlementStatus: Object.freeze({
    paid: 'Opłacona', partial: 'Częściowo opłacona',
    unknown: 'Nie ustalono', unpaid: 'Do zapłaty',
  }),
  invoiceStatus: Object.freeze({
    action_required: 'Wymaga wystawienia', issued: 'Wystawiona',
    not_issued: 'Niewystawiona', not_required: 'Nie wymaga', unknown: 'Do sprawdzenia',
  }),
})
const conciseSpecialistOptions = (options) => {
  const totals = new Map()
  const seen = new Map()
  options.forEach(({ label }) => totals.set(label, (totals.get(label) ?? 0) + 1))
  return options.map(({ id, label }) => {
    const index = (seen.get(label) ?? 0) + 1
    seen.set(label, index)
    return { id, selectLabel: totals.get(label) > 1 ? `${label} (${index})` : label }
  })
}
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
  concise = false, flow, dispatchFlow, generation, selectedFileRef, onCommitted,
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
  const specialistSelectOptions = concise
    ? conciseSpecialistOptions(specialists) : specialistOptionsForSelect(specialists)
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
    } catch (error) {
      if (controller.signal.aborted) return
      let code = null
      try { code = error?.code } catch { code = null }
      fail(code === 'WORKBOOK_FINGERPRINT_REJECTED' ? code : 'WORKBOOK_PREVIEW_FAILED')
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
        } else if (error instanceof ApiError && error.code === 'WORKBOOK_IMPORT_CONFLICT') {
          fail('WORKBOOK_IMPORT_CONFLICT')
        } else fail('WORKBOOK_COMMIT_REJECTED')
      }
    }
  }

  if (!allowed) return null
  return (
    <section className="card card--pad workbook-import" data-reveal aria-labelledby="workbook-import-title">
      <h2 className="card-title" id="workbook-import-title">Przeniesienie danych z arkusza</h2>
      <label className={`btn btn--ghost workbook-import__file${busy || commitLocked ? ' is-disabled' : ''}`}>
        <input
          key={inputGeneration}
          className="workbook-import__file-input"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={chooseFile}
          disabled={busy || commitLocked}
        />
        <span>Wybierz plik Excel (.xlsx)</span>
      </label>
      {flow.phase === 'previewing' ? <p role="status">Sprawdzam plik…</p> : null}
      {flow.preview ? <section className="workbook-import__review" aria-labelledby="workbook-preview-title">
        <h3 id="workbook-preview-title" ref={headingRef} tabIndex={-1}>
          Sprawdziliśmy plik. Nic jeszcze nie zostało zapisane.
        </h3>
        <dl className="workbook-import__counts">
          <div><dt>Gotowe do przeniesienia</dt><dd>{flow.preview.reconciliation.acceptedRows}</dd></div>
          <div><dt>Do poprawy w arkuszu</dt><dd>{flow.preview.reconciliation.quarantinedRows}</dd></div>
          <div><dt>Pominięte (sumy i formuły)</dt><dd>{flow.preview.reconciliation.excludedFormulaRows}</dd></div>
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
          <h4 id="workbook-preview-warnings">Powtórzenia i uwagi</h4>
          <ul>{flow.preview.warnings.map((warning, index) => <li
            key={`${warning.code}:${index}`}
          >{warningText(warning)}</li>)}</ul>
        </section> : null}
        {flow.preview.quarantine.length > 0 ? <section
          className="workbook-import__evidence"
          aria-labelledby="workbook-preview-quarantine"
        >
          <h4 id="workbook-preview-quarantine">Do poprawy w arkuszu</h4>
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
          <h4 id="workbook-preview-panel-changes">Zmiany w pozycjach</h4>
          {flow.preview.panelChanges.updates.length > 0 ? <>
            <p>Pozycje do zmiany</p>
            <ul>{flow.preview.panelChanges.updates.map((update, index) => <li
              key={`panel-update:${index}`}
            >
              {concise ? 'Pozycja do zmiany: ' : <><strong>{update.id}</strong>: </>}{Object.entries(update.values).map(
                ([field, value]) => `${panelFieldLabel[field]} — ${panelValueText(
                  field, value, specialistNames,
                )}`,
              ).join(', ')}
            </li>)}</ul>
          </> : <p>Brak zmian pól.</p>}
          {flow.preview.panelChanges.voidIds.length > 0 ? <>
            <p>Pozycje do usunięcia z rozliczeń</p>
            {concise ? <p>{flow.preview.panelChanges.voidIds.length} {plural(
              flow.preview.panelChanges.voidIds.length, 'pozycja do usunięcia',
              'pozycje do usunięcia', 'pozycji do usunięcia',
            )}.</p> : <ul>{flow.preview.panelChanges.voidIds.map((id, index) => <li
              key={`panel-void:${index}`}
            >{id}</li>)}</ul>}
          </> : <p>Żadna pozycja nie zostanie usunięta.</p>}
        </section> : null}
        {conflicts.length > 0 ? <section
          className="workbook-import__evidence"
          aria-labelledby="workbook-preview-conflicts"
        >
          <h4 id="workbook-preview-conflicts">Kto jest kim?</h4>
          {conflicts.map((conflict, index) => (
            <div className="workbook-import__conflict" key={conflict.id}>
              <p>„<strong>{conflict.sourceValue || 'brak nazwy'}</strong>” w arkuszu to:</p>
              <Field label={`Specjalistka nr ${index + 1}`}>
                <select
                  className="select"
                  disabled={commitLocked || flow.phase === 'committing'}
                  value={resolutionByConflict.get(conflict.id) ?? ''}
                  onChange={(event) => changeResolution(conflict.id, event.target.value)}
                >
                  <option value="">Wybierz specjalistkę</option>
                  {specialistSelectOptions.map(({ id, selectLabel }) => (
                    <option key={id} value={id}>{selectLabel}</option>
                  ))}
                </select>
              </Field>
            </div>
          ))}
        </section> : null}
        {blocked ? <section className="workbook-import__evidence">
          <EmptyState
            icon="ledger"
            title="Tego pliku nie można teraz przenieść"
            hint="Niektóre pozycje zmieniły się w panelu po pobraniu arkusza. Pobierz arkusz ponownie i nanieś zmiany jeszcze raz."
          />
          <ul>{panelConflicts.map((conflict, index) => <li key={`panel-conflict:${index}`}>
            {concise ? 'Pozycja w pliku' : <strong>{conflict.recordId}</strong>}{' — '}{panelConflictLabel[conflict.code]}
            {conflict.field ? `: ${panelFieldLabel[conflict.field]}` : ''}
            {conflict.code === 'PANEL_CONCURRENT_EDIT' ? <span>
              {' '}· obecnie: {panelValueText(conflict.field, conflict.current, specialistNames)}
              {' '}· w pliku: {panelValueText(conflict.field, conflict.edited, specialistNames)}
            </span> : null}
          </li>)}</ul>
        </section> : null}
        <Button disabled={!complete || blocked || flow.phase !== 'review'} onClick={commit}>
          {flow.phase === 'committing' ? 'Zapisywanie…' : 'Przenieś dane'}
        </Button>
      </section> : null}
      {flow.phase === 'materializing' ? <p role="status">Dane z arkusza są przenoszone. Dokończ to poniżej.</p> : null}
      {flow.phase === 'complete' ? <p role="status">Finanse zostały przeniesione. Poniżej możesz dokończyć import klientów i zajęć.</p> : null}
      {flow.phase === 'review' && flow.errorCode === 'WORKBOOK_COMMIT_FAILED'
        ? <p className="form-error" role="alert">
          Nie mamy pewności, czy dane się zapisały. Kliknij „Przenieś dane” jeszcze raz, niczego nie zmieniając - nic się nie zdubluje.
        </p> : null}
      {flow.phase === 'failed' && flow.errorCode === 'WORKBOOK_IMPORT_CONFLICT'
        ? <p className="form-error" role="alert">
          Nie można przenieść danych z tego pliku. Mógł zostać już wczytany albo lista specjalistek się zmieniła. Wybierz plik ponownie.
        </p> : null}
      {flow.phase === 'failed' && flow.errorCode === 'WORKBOOK_FINGERPRINT_REJECTED'
        ? <p className="form-error" role="alert">
          Tego arkusza nie można wczytać. Dawny arkusz poradni został już przeniesiony, a bieżące dane wpisuje się w panelu.
        </p> : null}
      {flow.phase === 'failed' && flow.errorCode === 'WORKBOOK_PREVIEW_FAILED'
        ? <p className="form-error" role="alert">Nie udało się sprawdzić pliku. Wybierz go ponownie.</p> : null}
      {flow.phase === 'failed' && flow.errorCode === 'WORKBOOK_COMMIT_REJECTED'
        ? <p className="form-error" role="alert">Nie udało się przenieść danych. Wybierz plik ponownie.</p> : null}
    </section>
  )
}
