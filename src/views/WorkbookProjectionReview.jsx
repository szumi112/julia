import { useEffect, useRef, useState } from 'react'
import { projectionRepository as repository } from '../finance-repository.js'
import { captureProjectionResolution, projectionsComplete } from '../workbook-projection-review.js'
import { SERVICES } from '../services.js'
import { Button, Pill } from '../ui.jsx'

const labels = { ready: 'Oczekuje', running: 'W trakcie', conflicts: 'Wymaga decyzji',
  complete: 'Zakończono', failed: 'Przerwano' }
const services = [...SERVICES].sort((a, b) => a.label.localeCompare(b.label, 'pl'))

export function WorkbookProjectionReview({ importId, creatorId, quarantineCount = 0, disabled = false }) {
  const [historical, setHistorical] = useState(null)
  const [activity, setActivity] = useState(null)
  const [review, setReview] = useState(null)
  const [draft, setDraft] = useState({ classification: '', existingSubjectId: '', serviceId: '' })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [locked, setLocked] = useState(false)
  const controllerRef = useRef(null)
  const requestsRef = useRef(new Map())
  const activeReviewRef = useRef(null)

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

  const findReview = async (conflict, signal) => {
    let after = null
    let directoryDigest = null
    for (let page = 0; page < 100; page += 1) {
      const catalog = await repository.getHistoricalProjectionReviewCatalog(importId, after, { signal })
      if (signal.aborted) return
      if (catalog.binding.creatorId !== creatorId || (directoryDigest !== null
        && directoryDigest !== catalog.directoryDigest)) throw new Error('REVIEW_CHANGED')
      directoryDigest = catalog.directoryDigest
      const item = catalog.items.find((item) => item.conflictId === conflict.id && item.resolution === null)
      if (item) {
        if (activeReviewRef.current !== conflict.id) {
          setDraft({ classification: '', existingSubjectId: '', serviceId: '' })
          activeReviewRef.current = conflict.id
        }
        setReview({ item, directoryCount: catalog.directoryCount, directoryDigest: catalog.directoryDigest })
        return
      }
      if (catalog.nextAfterSourceRecordId === null) break
      after = catalog.nextAfterSourceRecordId
    }
    throw new Error('REVIEW_UNAVAILABLE')
  }
  const command = async (kind, version, body, signal) => {
    const slot = `${kind}:${version}`
    if (!requestsRef.current.has(slot)) requestsRef.current.set(slot, {
      key: `projection-${crypto.randomUUID()}`, body,
    })
    const request = requestsRef.current.get(slot)
    const options = { signal, idempotencyKey: request.key }
    const result = kind === 'historical'
      ? await repository.continueHistoricalProjection(importId, version, options)
      : kind === 'activity' ? await repository.continueActivityProjection(importId, version, options)
        : await repository.resolveHistoricalProjection(importId, request.body, options)
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
      if (state.projection?.status === 'conflicts') {
        const conflict = state.conflicts[0]
        if (!conflict || conflict.kind === 'near_match') {
          throw new Error('IDENTITY_REVIEW_UNAVAILABLE')
        }
        await findReview(conflict, signal)
        return
      }
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
      setReview(null)
      return
    }
    throw new Error('PROJECTION_LIMIT')
  }
  const run = async (resolve = false) => {
    if (busy || disabled) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setError('')
    try {
      if (resolve) {
        const body = captureProjectionResolution({
          expectedJobVersion: historical.version, conflictId: review.item.conflictId,
          classification: draft.classification,
          existingSubjectId: draft.classification === 'exclude' || draft.existingSubjectId === 'new'
            ? null : draft.existingSubjectId,
          serviceId: draft.classification === 'exclude' ? null : draft.serviceId,
          reviewContextDigest: review.item.reviewContextDigest,
          directoryCount: review.directoryCount, directoryDigest: review.directoryDigest,
        })
        setLocked(true)
        await command('resolution', historical.version, body, controller.signal)
        if (controller.signal.aborted) return
        setLocked(false)
        setReview(null)
      }
      await advance(controller.signal)
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure.code === 'VERSION_CONFLICT' && resolve) {
          requestsRef.current.delete(`resolution:${historical.version}`)
          setLocked(false)
          const latest = await load(controller.signal).catch(() => null)
          const conflict = latest?.conflicts.find(({ id }) => id === review.item.conflictId)
          if (conflict) await findReview(conflict, controller.signal).catch(() => {})
          else if (latest) setReview(null)
        }
        if (controller.signal.aborted) return
        setError(failure.message === 'IDENTITY_REVIEW_UNAVAILABLE'
          ? 'Serwer wymaga dodatkowej weryfikacji tożsamości, której ten import nie pozwala jeszcze zapisać. Import klientów pozostaje nieukończony.'
          : 'Operacja nie została potwierdzona. Zachowano Twoje decyzje. Ponów operację; zapisane partie nie zostaną powielone.')
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const complete = loaded && projectionsComplete(historical, activity)
  const validDecision = review && draft.classification && (draft.classification === 'exclude'
    || (draft.existingSubjectId && draft.serviceId))
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
    {review ? <div>
      <h3>Decyzja dotycząca pozycji źródłowej</h3>
      <p>{review.item.context.counterparty} · {review.item.context.serviceLabel}</p>
      <p className="muted">Źródło: {review.item.sourceRecordId}</p>
      <label className="field">Rodzaj podmiotu<select value={draft.classification} disabled={busy || locked}
        onChange={(event) => setDraft({ ...draft, classification: event.target.value, existingSubjectId: '', serviceId: '' })}>
        <option value="">Wybierz jawnie</option>
        {review.item.kind !== 'service' || review.item.context.proposedClassification === 'counterparty'
          ? <option value="counterparty">Kontrahent / organizacja</option> : null}
        {review.item.kind !== 'service' || review.item.context.proposedClassification === 'person'
          ? <option value="person">Osoba / klient</option> : null}
        {review.item.kind !== 'service' ? <option value="exclude">Wyłącz z historii klientów</option> : null}
      </select></label>
      {draft.classification && draft.classification !== 'exclude' ? <>
        <label className="field">Dopasowanie tożsamości<select value={draft.existingSubjectId} disabled={busy || locked}
          onChange={(event) => setDraft({ ...draft, existingSubjectId: event.target.value })}>
          <option value="">Wybierz jawnie</option>
          <option value="new">Odrębna tożsamość (nie łącz podobnych nazw)</option>
          {review.item.context.nearSubjectIds.filter((id) => id.startsWith(draft.classification === 'person' ? 'hcl_' : 'hcp_'))
            .sort().map((id) => <option key={id} value={id}>{id}</option>)}
        </select></label>
        <label className="field">Usługa<select value={draft.serviceId} disabled={busy || locked}
          onChange={(event) => setDraft({ ...draft, serviceId: event.target.value })}>
          <option value="">Wybierz usługę</option>
          {services.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select></label>
      </> : null}
      <Button disabled={busy || disabled || !validDecision} onClick={() => run(true)}>
        {locked ? 'Ponów zapis tej samej decyzji' : 'Zapisz decyzję i kontynuuj'}</Button>
    </div> : !complete ? <Button disabled={busy || disabled} onClick={() => run()}>
      {busy ? 'Importowanie klientów i zajęć…' : 'Kontynuuj import klientów i zajęć'}</Button> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>
}
