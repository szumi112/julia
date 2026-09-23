import { useEffect, useRef, useState } from 'react'
import { apiClient } from '../api.js'
import { captureClientNoteInput } from '../client-notes.js'
import { useShell } from '../shell-ctx.js'
import { Button, EmptyState } from '../ui.jsx'

const dateTime = new Intl.DateTimeFormat('pl-PL', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw',
})

const initial = () => ({ items: [], nextCursor: null, status: 'loading', error: null })
const loadedWithConfirmed = (current, result) => ({
  items: [
    ...current.items.filter((note) => !result.items.some((loaded) => loaded.id === note.id)),
    ...result.items,
  ],
  nextCursor: result.nextCursor,
  status: 'ready', error: null,
})

export function ClientSessionNotes({ clientId, specialistId, authorName }) {
  const { actor, capabilities, registerLeaveGuard } = useShell()
  const [notes, setNotes] = useState(initial)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [feedback, setFeedback] = useState('')
  const pendingSubmission = useRef(null)
  const mounted = useRef(false)
  const canRead = actor?.specialistId === specialistId
    && capabilities.includes('clinical.read')
  const canCreate = canRead && capabilities.includes('client.manage')

  useEffect(() => registerLeaveGuard(() => (
    draft.trim().length > 0 || pendingSubmission.current !== null
  )), [draft, registerLeaveGuard])

  useEffect(() => {
    mounted.current = true
    if (!canRead) return () => { mounted.current = false }
    const controller = new AbortController()
    setNotes(initial())
    apiClient.clientNotes(clientId, { limit: 20 }, { signal: controller.signal })
      .then((result) => {
        if (mounted.current && !controller.signal.aborted) setNotes((current) => (
          loadedWithConfirmed(current, result)
        ))
      })
      .catch(() => {
        if (mounted.current && !controller.signal.aborted) setNotes((current) => ({
          ...current, status: 'error', error: 'Nie udało się wczytać notatek.',
        }))
      })
    return () => { mounted.current = false; controller.abort() }
  }, [canRead, clientId])

  const reload = async () => {
    setNotes(initial())
    try {
      const result = await apiClient.clientNotes(clientId, { limit: 20 })
      if (mounted.current) setNotes((current) => loadedWithConfirmed(current, result))
    } catch {
      if (mounted.current) setNotes((current) => ({
        ...current, status: 'error', error: 'Nie udało się wczytać notatek.',
      }))
    }
  }

  const loadMore = async () => {
    if (!notes.nextCursor || loadingMore) return
    setLoadingMore(true)
    setFeedback('')
    try {
      const result = await apiClient.clientNotes(clientId, {
        limit: 20, cursor: notes.nextCursor,
      })
      if (mounted.current) setNotes((current) => ({
        ...current,
        items: [...current.items, ...result.items.filter((note) => (
          !current.items.some((existing) => existing.id === note.id)
        ))],
        nextCursor: result.nextCursor,
      }))
    } catch {
      if (mounted.current) setFeedback('Nie udało się wczytać kolejnych notatek.')
    } finally {
      if (mounted.current) setLoadingMore(false)
    }
  }

  const save = async (event) => {
    event.preventDefault()
    if (!canCreate || saving) return
    const input = captureClientNoteInput({ text: draft.trim().normalize('NFC') })
    if (!input) {
      setFeedback('Wpisz notatkę do 4000 znaków bez znaków sterujących.')
      return
    }
    const pending = pendingSubmission.current?.text === input.text
      ? pendingSubmission.current
      : { text: input.text, key: apiClient.createIdempotencyKey() }
    pendingSubmission.current = pending
    setSaving(true)
    setFeedback('')
    try {
      const { note } = await apiClient.createClientNote(clientId, input, {
        idempotencyKey: pending.key,
      })
      if (mounted.current) {
        setNotes((current) => ({
          ...current,
          items: [note, ...current.items.filter((item) => item.id !== note.id)],
          status: 'ready', error: null,
        }))
        setDraft('')
        setFeedback('Notatka zapisana.')
        pendingSubmission.current = null
      }
    } catch {
      if (mounted.current) setFeedback('Nie udało się potwierdzić zapisu. Spróbuj ponownie.')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  if (!canRead) return null
  return (
    <section className="client-record__section" aria-labelledby="client-session-notes-title" data-reveal>
      <div className="card card--pad">
        <h2 className="card-title" id="client-session-notes-title">Notatki z sesji</h2>
        {canCreate && <form className="note-composer" onSubmit={save} style={{ marginTop: 16 }}>
          <textarea
            className="textarea"
            aria-label="Treść notatki"
            placeholder="Nowa notatka..."
            maxLength={4000}
            value={draft}
            disabled={saving}
            onChange={(event) => { setDraft(event.target.value); setFeedback('') }}
          />
          <div>
            <Button size="sm" variant="soft" icon="plus" type="submit" disabled={saving || !draft.trim()}>
              {saving ? 'Zapisuję...' : 'Dodaj notatkę'}
            </Button>
          </div>
        </form>}
        {feedback && <p role="status">{feedback}</p>}
        {notes.status === 'loading' && <p role="status" className="faint">Wczytuję notatki...</p>}
        {notes.status === 'error' && <div role="alert">
          <p>{notes.error}</p>
          <Button size="sm" variant="soft" onClick={reload}>Spróbuj ponownie</Button>
        </div>}
        {notes.status === 'ready' && <div className="notes" style={{ marginTop: 18 }}>
          {notes.items.length === 0 && <EmptyState
            compact icon="edit" title="Brak notatek"
            hint="Dodaj pierwszą notatkę powyżej."
          />}
          {notes.items.map((note) => <article className="note" key={note.id}>
            <div className="note__date">
              <strong>{authorName}</strong> · <time dateTime={note.createdAt}>
                {dateTime.format(new Date(note.createdAt))}
              </time>
            </div>
            <div className="note__text" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {note.text}
            </div>
          </article>)}
          {notes.nextCursor && <Button
            size="sm" variant="soft" disabled={loadingMore} onClick={loadMore}
          >{loadingMore ? 'Wczytuję...' : 'Pokaż więcej'}</Button>}
        </div>}
      </div>
    </section>
  )
}
