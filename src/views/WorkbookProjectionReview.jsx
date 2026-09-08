import { useEffect, useRef, useState } from 'react'
import { projectionRepository as repository } from '../finance-repository.js'
import { projectionsComplete } from '../workbook-projection-review.js'
import { Button, Pill } from '../ui.jsx'

// 'conflicts' is a paused job from the former manual review; the next
// continuation resolves it on the server without a decision here.
const labels = { ready: 'Oczekuje', running: 'W trakcie', conflicts: 'W trakcie',
  complete: 'Zakończono', failed: 'Przerwano' }

export function WorkbookProjectionReview({ importId, creatorId, quarantineCount = 0, disabled = false }) {
  const [historical, setHistorical] = useState(null)
  const [activity, setActivity] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controllerRef = useRef(null)
  const requestsRef = useRef(new Map())

  const load = async (signal) => {
    const status = await repository.getHistoricalProjection(importId, { signal })
    if (signal.aborted) return null
    setHistorical(status.projection)
    const nextActivity = await repository.getActivityProjection(importId, { signal })
    if (signal.aborted) return null
    setActivity(nextActivity)
    setLoaded(true)
    return { ...status, activity: nextActivity }
  }
  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    load(controller.signal).catch(() => {
      if (!controller.signal.aborted) setError('Nie udało się sprawdzić importu klientów i zajęć. Spróbuj ponownie.')
    })
    return () => { controller.abort(); controllerRef.current?.abort() }
  }, [importId])

  const command = async (kind, version, body, signal) => {
    const slot = `${kind}:${version}`
    if (!requestsRef.current.has(slot)) requestsRef.current.set(slot, {
      key: `projection-${crypto.randomUUID()}`, body,
    })
    const request = requestsRef.current.get(slot)
    const options = { signal, idempotencyKey: request.key }
    const result = kind === 'historical'
      ? await repository.continueHistoricalProjection(importId, version, options)
      : await repository.continueActivityProjection(importId, version, options)
    if (signal.aborted) return null
    if (result.version <= version) throw new Error('PROJECTION_STALLED')
    requestsRef.current.delete(slot)
    return result
  }
  const advance = async (signal) => {
    let state = await load(signal)
    if (!state || signal.aborted) return
    for (let step = 0; step < 5000; step += 1) {
      if (signal.aborted) return
      if (state.projection?.status === 'failed' || state.activity?.status === 'failed') {
        throw new Error('PROJECTION_FAILED')
      }
      if (state.projection?.status !== 'complete') {
        await command('historical', state.projection?.version ?? 0, null, signal)
        state = await load(signal)
        if (!state) return
        continue
      }
      if (state.activity?.status !== 'complete') {
        const next = await command('activity', state.activity?.version ?? 0, null, signal)
        if (!next) return
        state.activity = next
        setActivity(next)
        continue
      }
      return
    }
    throw new Error('PROJECTION_LIMIT')
  }
  const run = async () => {
    if (busy || disabled) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setError('')
    try {
      await advance(controller.signal)
    } catch {
      if (!controller.signal.aborted) {
        setError('Operacja nie została potwierdzona. Ponów operację; zapisane partie nie zostaną powielone.')
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const complete = loaded && projectionsComplete(historical, activity)
  return <section className="card card--pad" aria-label="Import klientów i zajęć">
    <h2 className="card-title">Import klientów i zajęć</h2>
    <p>Finanse zostały zapisane. Import klientów oraz zajęć TUS i angielskiego wymaga osobnego potwierdzenia.</p>
    <p>Historia klientów: <Pill tone={historical?.status === 'complete' ? 'sage' : 'amber'}>
      {loaded ? labels[historical?.status] ?? 'Oczekuje' : 'Sprawdzanie…'}</Pill>
      {historical ? ` ${historical.processedRecords} / ${historical.totalRecords}` : ''}</p>
    <p>TUS i angielski: <Pill tone={activity?.status === 'complete' ? 'sage' : 'amber'}>
      {loaded ? labels[activity?.status] ?? 'Oczekuje' : 'Sprawdzanie…'}</Pill>
      {activity ? ` ${activity.processedRecords} / ${activity.totalRecords}` : ''}</p>
    {complete ? <p role="status">Finanse, historia klientów i zajęcia zostały zaimportowane.</p> : null}
    {quarantineCount > 0 ? <p role="status">Pozycje w kwarantannie: {quarantineCount}. Pozostają wyłączone z importu i wymagają osobnej korekty źródła.</p> : null}
    {!complete ? <Button disabled={busy || disabled} onClick={() => run()}>
      {busy ? 'Importowanie klientów i zajęć…' : 'Kontynuuj import klientów i zajęć'}</Button> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>
}
