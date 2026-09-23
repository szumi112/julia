import { useCallback, useEffect, useRef, useState } from 'react'

import { canPerformAction } from '../capability-access.js'
import { ApiError } from '../api.js'
import { financeRepository } from '../finance-repository.js'
import { useShell } from '../shell-ctx.js'
import { Button } from '../ui.jsx'

export function WorkbookExport({ own = false, onComplete, placement = 'card' }) {
  const { appMode, authorityGeneration, capabilities, environment } = useShell()
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const controllerRef = useRef(null)
  const urlRef = useRef(null)
  const authorityGenerationRef = useRef(authorityGeneration)
  const allowed = canPerformAction(
    capabilities, own ? 'workbook.export.own' : 'workbook.export.centre',
  ) && (own || (appMode === 'app' && environment === 'staging'))

  const clearUrl = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
  }, [])
  useEffect(() => () => {
    controllerRef.current?.abort()
    clearUrl()
  }, [clearUrl])
  useEffect(() => {
    const authorityChanged = authorityGenerationRef.current !== authorityGeneration
    authorityGenerationRef.current = authorityGeneration
    if (!authorityChanged && allowed) return
    controllerRef.current?.abort()
    controllerRef.current = null
    clearUrl()
    setStatus('idle')
    setError('')
    setUnavailable(false)
  }, [allowed, authorityGeneration, clearUrl])

  const download = async (format) => {
    if (!allowed || status === 'loading') return
    controllerRef.current?.abort()
    clearUrl()
    const controller = new AbortController()
    controllerRef.current = controller
    setStatus('loading')
    setError('')
    try {
      const { blob, filename } = await financeRepository.exportWorkbook(
        { format }, { signal: controller.signal },
      )
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const anchor = document.createElement('a')
      try {
        anchor.href = url
        anchor.download = filename
        anchor.rel = 'noopener'
        anchor.click()
      } finally {
        anchor.remove()
        clearUrl()
      }
      setStatus('complete')
      onComplete?.()
    } catch (caught) {
      if (!controller.signal.aborted) {
        if (caught instanceof ApiError && caught.status === 404) {
          setUnavailable(true)
          return
        }
        setStatus('error')
        setError(caught instanceof ApiError && caught.code === 'IDEMPOTENCY_CONFLICT'
          ? 'Dane zmieniły się w trakcie przygotowania arkusza. Spróbuj ponownie.'
          : 'Nie udało się przygotować arkusza. Spróbuj ponownie za chwilę.')
      }
    }
  }

  if (!allowed || unavailable) return null
  const done = status === 'complete' ? <p className="muted" role="status">Eksport został pobrany.</p> : null
  if (own || placement === 'finance-header') return (
    <div className="workbook-export workbook-export--finance">
      <Button
        variant="ghost"
        disabled={status === 'loading'}
        onClick={() => download('panel-v2')}
      >
        {status === 'loading' ? 'Przygotowuję arkusz…' : 'Pobierz arkusz Excel'}
      </Button>
      {own ? null : <p className="muted">Plik zawiera wszystkie dane poradni, nie tylko wybrany miesiąc.</p>}
      {done}
      {error ? <p className="form-error" role="alert">{error} <Button size="sm" variant="ghost" onClick={() => download('panel-v2')}>Spróbuj ponownie</Button></p> : null}
    </div>
  )
  return (
    <section className="card card--pad workbook-export" data-reveal aria-labelledby="workbook-export-title">
      <h2 className="card-title" id="workbook-export-title">Pobierz arkusz</h2>
      <p className="muted">Plik zawiera dane, które widzisz w panelu.</p>
      <div className="row workbook-export__actions">
        <Button disabled={status === 'loading'} onClick={() => download('panel-v2')}>
          Pobierz arkusz Excel
        </Button>
        <Button variant="ghost" disabled={status === 'loading'} onClick={() => download('legacy')}>
          Pobierz w układzie dawnego arkusza
        </Button>
      </div>
      {done}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  )
}
