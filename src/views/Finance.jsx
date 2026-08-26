import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ApiError, apiClient } from '../api.js'
import { financeImportChunks } from '../finance-import.js'
import {
  addMonths,
  cap,
  fmtMoney,
  fmtMonthYear,
  fmtShortDate,
  monthKey,
  searchNorm,
} from '../format.js'
import { useShell } from '../shell-ctx.js'
import { useApp } from '../store.jsx'
import { Button, Chip, EmptyState, IconBtn, Pager, Pill, usePagination } from '../ui.jsx'
import { useRouteParamsSync } from '../ux-patterns.jsx'

const METHOD_LABELS = Object.freeze({
  blik: 'BLIK', card: 'Karta', cash: 'Gotówka', monthly: 'Miesięcznie',
  other: 'Inna', transfer: 'Przelew', unknown: 'Nie ustalono',
})
const SETTLEMENT_LABELS = Object.freeze({
  paid: 'Opłacone', partial: 'Częściowo', unknown: 'Do sprawdzenia', unpaid: 'Nieopłacone',
})
const INVOICE_LABELS = Object.freeze({
  action_required: 'Wymaga wystawienia', issued: 'Wystawiona',
  not_issued: 'Niewystawiona', not_required: 'Nie wymaga', unknown: 'Do sprawdzenia',
})
const WARNING_LABELS = Object.freeze({
  ACCOUNTING_MONTH_UNKNOWN: 'wierszy bez ustalonego miesiąca',
  PAYMENT_METHOD_UNKNOWN: 'wierszy bez ustalonej formy płatności',
})

const validMonth = (value) => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value ?? '')
const money = (grosze) => fmtMoney(grosze / 100)

const errorMessage = (error) => {
  if (error instanceof ApiError) {
    if (error.code === 'FINANCE_IMPORT_DUPLICATE') return 'Ten plik został już wcześniej zaimportowany.'
    if (error.code === 'FINANCE_IMPORT_INCOMPLETE') return 'Import nie zawiera jeszcze wszystkich wierszy.'
    if (error.code === 'VERSION_CONFLICT') return 'Dane zmieniły się w trakcie importu. Wczytaj widok ponownie.'
    if (error.code === 'PAYLOAD_TOO_LARGE') return 'Wybrany fragment pliku jest zbyt duży.'
  }
  return 'Nie udało się wykonać operacji. Spróbuj ponownie.'
}

const importEntryCount = (preview) => preview?.rows?.length ?? 0

function SummaryCard({ label, value, note, tone = '' }) {
  return (
    <article className={`finance-mvp-stat ${tone ? `finance-mvp-stat--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  )
}

function ImportPreview({ preview, progress, importing, error, onCancel, onImport }) {
  const total = importEntryCount(preview)
  return (
    <section className="card card--pad finance-import" aria-labelledby="finance-import-title">
      <div className="row row--between finance-import__head">
        <div>
          <div className="eyebrow">Podgląd importu</div>
          <h2 className="card-title" id="finance-import-title">{preview.filename}</h2>
        </div>
        <Pill tone="sky">{total} wierszy</Pill>
      </div>
      <div className="finance-import__counts" role="list" aria-label="Zakres danych w pliku">
        <span role="listitem"><strong>{preview.counts.financeRows}</strong> przychodów</span>
        <span role="listitem"><strong>{preview.counts.tusRows}</strong> wpłat TUS</span>
        <span role="listitem"><strong>{preview.counts.englishRows}</strong> rozliczeń angielskiego</span>
        <span role="listitem"><strong>{preview.counts.costOrAncillaryRows}</strong> kosztów i pozostałych pozycji</span>
      </div>
      {preview.warnings.length > 0 ? (
        <div className="finance-import__warnings" role="status">
          {preview.warnings.map((warning) => (
            <span key={warning.code}>
              {warning.count} {WARNING_LABELS[warning.code] || 'wierszy do sprawdzenia'}
            </span>
          ))}
        </div>
      ) : null}
      {importing ? (
        <div className="finance-import__progress" role="status" aria-live="polite">
          <progress max={total} value={progress} />
          <span>Zaimportowano {progress} z {total} wierszy</span>
        </div>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="row finance-import__actions">
        <Button variant="ghost" disabled={importing} onClick={onCancel}>Anuluj</Button>
        <Button disabled={importing || total === 0} onClick={onImport}>
          {importing ? 'Importowanie…' : 'Zaimportuj do panelu'}
        </Button>
      </div>
    </section>
  )
}

export function Finance() {
  const { state, toast } = useApp()
  const { capabilities, route } = useShell()
  const currentMonth = monthKey(new Date())
  const [month, setMonth] = useState(() => (
    route.params?.ym === 'unknown'
      ? null
      : validMonth(route.params?.ym) ? route.params.ym : currentMonth
  ))
  const [kind, setKind] = useState(null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [finance, setFinance] = useState({ status: 'loading', entries: [], summary: null })
  const [reloadToken, setReloadToken] = useState(0)
  const [preview, setPreview] = useState(null)
  const [parseStatus, setParseStatus] = useState('idle')
  const [importStatus, setImportStatus] = useState({ importing: false, progress: 0, error: '' })
  const fileRef = useRef(null)
  const canImport = capabilities.includes('finance.centre.manage')

  useRouteParamsSync('ledger', { ym: month ?? 'unknown' })

  useEffect(() => {
    let active = true
    setFinance((current) => ({ ...current, status: 'loading' }))
    apiClient.listFinance({ month, kind }).then((result) => {
      if (active) setFinance({ status: 'ready', ...result })
    }).catch((error) => {
      if (active) setFinance({ status: 'error', entries: [], summary: null, error })
    })
    return () => { active = false }
  }, [kind, month, reloadToken])

  const filteredEntries = useMemo(() => {
    const wanted = searchNorm(deferredQuery)
    if (!wanted) return finance.entries
    return finance.entries.filter((entry) => searchNorm([
      entry.counterparty, entry.sourceLabel, entry.invoiceNote,
      METHOD_LABELS[entry.paymentMethod], INVOICE_LABELS[entry.invoiceStatus],
    ].join(' ')).includes(wanted))
  }, [deferredQuery, finance.entries])

  const { pageItems, page, pages, setPage } = usePagination(filteredEntries, {
    pageSize: 30,
    resetKey: `${month}|${kind}|${deferredQuery}`,
  })

  const selectFile = useCallback(async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setParseStatus('parsing')
    setPreview(null)
    setImportStatus({ importing: false, progress: 0, error: '' })
    try {
      const parser = await import('../workbook-import.js')
      const parsed = file.name.toLowerCase().endsWith('.csv')
        ? await parser.parseWorkbookCsv(await file.text(), { filename: file.name })
        : await parser.parseWorkbookFile(await file.arrayBuffer(), { filename: file.name })
      setPreview(parsed)
      setParseStatus('ready')
    } catch {
      setParseStatus('error')
    }
  }, [])

  const cancelImport = useCallback(() => {
    if (importStatus.importing) return
    setPreview(null)
    setParseStatus('idle')
    setImportStatus({ importing: false, progress: 0, error: '' })
  }, [importStatus.importing])

  const importWorkbook = useCallback(async () => {
    if (!preview || !canImport || importStatus.importing) return
    setImportStatus({ importing: true, progress: 0, error: '' })
    try {
      const started = await apiClient.startFinanceImport({
        filename: preview.filename,
        fingerprint: preview.fingerprint,
        formatVersion: preview.formatVersion,
        totalRows: preview.rows.length,
      }, { idempotencyKey: `finance-start-${preview.fingerprint}` })
      const chunks = financeImportChunks(
        preview.rows,
        started.id,
        state.psychologists,
      )
      let batch = started
      for (const chunk of chunks) {
        batch = await apiClient.appendFinanceImportChunk(
          batch.id,
          chunk.sequence,
          chunk.entries,
          { idempotencyKey: `finance-chunk-${preview.fingerprint.slice(0, 48)}-${chunk.sequence}` },
        )
        setImportStatus({ importing: true, progress: batch.acceptedRows, error: '' })
      }
      await apiClient.commitFinanceImport(batch.id, batch.version, {
        idempotencyKey: `finance-commit-${preview.fingerprint}`,
      })
      setPreview(null)
      setParseStatus('idle')
      setImportStatus({ importing: false, progress: 0, error: '' })
      setReloadToken((value) => value + 1)
      toast(`Zaimportowano ${preview.rows.length} fikcyjnych pozycji z arkusza.`, 'payments')
    } catch (error) {
      setImportStatus((current) => ({
        ...current, importing: false, error: errorMessage(error),
      }))
    }
  }, [canImport, importStatus.importing, preview, state.psychologists, toast])

  const summary = finance.summary
  const outstanding = summary?.outstandingGrosze ?? 0

  return (
    <div className="finance-mvp">
      <div className="view-head">
        <div>
          <div className="eyebrow">Arkusz przeniesiony do panelu</div>
          <h1 className="display view-head__title">Finanse <em>centrum</em></h1>
          <p className="view-head__sub">
            Przychody, koszty, płatności, faktury, TUS i angielski w jednym miesięcznym rejestrze.
          </p>
        </div>
        {canImport ? (
          <div className="view-head__actions">
            <input
              ref={fileRef}
              className="sr-only"
              type="file"
              accept=".xlsx,.csv"
              aria-label="Importuj XLSX lub CSV"
              onChange={selectFile}
            />
            <Button icon="plus" onClick={() => fileRef.current?.click()} disabled={parseStatus === 'parsing'}>
              {parseStatus === 'parsing' ? 'Czytanie pliku…' : 'Importuj XLSX lub CSV'}
            </Button>
          </div>
        ) : null}
      </div>

      {parseStatus === 'error' ? (
        <div className="form-error finance-mvp__parse-error" role="alert">
          Nie udało się odczytać pliku. Wybierz poprawny plik XLSX lub CSV.
        </div>
      ) : null}
      {preview ? (
        <ImportPreview
          preview={preview}
          progress={importStatus.progress}
          importing={importStatus.importing}
          error={importStatus.error}
          onCancel={cancelImport}
          onImport={importWorkbook}
        />
      ) : null}

      <section className="finance-mvp__scope" aria-label="Zakres rejestru finansowego">
        <div className="month-nav">
          {month === null ? (
            <span className="month-nav__label">Bez ustalonego miesiąca</span>
          ) : (
            <>
              <IconBtn name="chevL" label="Poprzedni miesiąc" onClick={() => setMonth(addMonths(month, -1))} />
              <span className="month-nav__label">{fmtMonthYear(month)}</span>
              <IconBtn
                name="chevR"
                label="Następny miesiąc"
                disabled={month >= currentMonth}
                onClick={() => setMonth(addMonths(month, 1))}
              />
            </>
          )}
        </div>
        <div className="row chips-row" role="group" aria-label="Rodzaj pozycji">
          <Chip on={month !== null} onClick={() => setMonth(currentMonth)}>Miesiące</Chip>
          <Chip on={month === null} onClick={() => setMonth(null)}>Bez miesiąca</Chip>
          <Chip on={kind === null} onClick={() => setKind(null)}>Wszystkie</Chip>
          <Chip on={kind === 'income'} onClick={() => setKind('income')}>Przychody</Chip>
          <Chip on={kind === 'expense'} onClick={() => setKind('expense')}>Koszty</Chip>
        </div>
      </section>

      {finance.status === 'loading' ? (
        <section role="status"><EmptyState icon="payments" title="Wczytywanie finansów…" /></section>
      ) : finance.status === 'error' ? (
        <section>
          <EmptyState
            icon="alert"
            title="Finanse są teraz niedostępne"
            hint="Nie pokazujemy niepełnych sum. Spróbuj ponownie."
            action={<Button variant="ghost" onClick={() => setReloadToken((value) => value + 1)}>Ponów</Button>}
          />
        </section>
      ) : (
        <>
          <section className="finance-mvp__stats" aria-label={`Podsumowanie — ${month === null ? 'bez ustalonego miesiąca' : fmtMonthYear(month)}`}>
            <SummaryCard label="Przychody" value={money(summary.revenueGrosze)} note={`${summary.entryCount} pozycji w rejestrze`} />
            <SummaryCard label="Wpłacono" value={money(summary.collectedGrosze)} note={`${money(outstanding)} pozostało`} tone="sage" />
            <SummaryCard label="Koszty" value={money(summary.expensesGrosze)} note="Stałe i pozostałe koszty" tone="amber" />
            <SummaryCard label="Bilans" value={money(summary.balanceGrosze)} note={`${summary.invoiceActionCount} faktur wymaga uwagi`} tone={summary.balanceGrosze < 0 ? 'error' : 'sky'} />
          </section>

          <section className="card finance-mvp__ledger" aria-labelledby="finance-mvp-ledger-title">
            <div className="finance-mvp__ledger-head">
              <div>
                <h2 className="card-title" id="finance-mvp-ledger-title">Rejestr miesiąca</h2>
                <span className="faint">{filteredEntries.length} widocznych pozycji</span>
              </div>
              <label className="finance-mvp__search">
                <span className="sr-only">Szukaj w rejestrze</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Klient, usługa, faktura…"
                />
              </label>
            </div>
            <div className="table-scroll">
              <table className="table" aria-label="Rejestr finansowy miesiąca">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Klient / kontrahent</th>
                    <th>Pozycja</th>
                    <th>Typ</th>
                    <th className="right">Kwota</th>
                    <th>Płatność</th>
                    <th>Faktura</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.occurredOn ? fmtShortDate(entry.occurredOn) : 'Brak daty'}</td>
                      <td>{entry.counterparty || '—'}</td>
                      <td>
                        <strong>{entry.sourceLabel}</strong>
                        {entry.lessonCount !== null ? <small>{entry.lessonCount} lekcji</small> : null}
                      </td>
                      <td><Pill tone={entry.kind === 'expense' ? 'amber' : 'sky'}>{entry.kind === 'expense' ? 'Koszt' : entry.recordType === 'tus' ? 'TUS' : entry.recordType === 'english' ? 'Angielski' : 'Przychód'}</Pill></td>
                      <td className="right num-cell">{money(entry.amountGrosze)}</td>
                      <td>
                        <span>{SETTLEMENT_LABELS[entry.settlementStatus]}</span>
                        <small>{METHOD_LABELS[entry.paymentMethod]}</small>
                      </td>
                      <td><span className={entry.invoiceStatus === 'action_required' ? 'finance-mvp__attention' : ''}>{INVOICE_LABELS[entry.invoiceStatus]}</span></td>
                    </tr>
                  ))}
                  {pageItems.length === 0 ? (
                    <tr><td colSpan={7}><EmptyState icon="search" title="Brak pozycji w tym zakresie" hint="Zmień miesiąc, filtr albo wyszukiwaną frazę." /></td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {pages > 1 ? <Pager page={page} pages={pages} onPage={setPage} /> : null}
          </section>
        </>
      )}
    </div>
  )
}
