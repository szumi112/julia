import { captureClientNotesQuery } from '../../src/client-notes.js'
import { createClientNote, listClientNotes } from '../core/client-notes.js'
import { AppError } from '../http/errors.js'

const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/

const invalid = () => { throw new AppError('VALIDATION_FAILED') }

const noteQuery = (value) => {
  if (!(value instanceof URLSearchParams)) invalid()
  const pairs = [...value]
  if (pairs.length > 2 || pairs.some(([key]) => !['limit', 'cursor'].includes(key))
    || new Set(pairs.map(([key]) => key)).size !== pairs.length) invalid()
  const rawLimit = value.get('limit')
  if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) invalid()
  const limit = rawLimit === null ? undefined : Number(rawLimit)
  const cursor = value.get('cursor') ?? undefined
  const query = captureClientNotesQuery({ limit, cursor })
  if (!query) invalid()
  return query
}

export async function getClientNotes(input) {
  if (!CLIENT_ID.test(input?.clientId ?? '')) throw new AppError('NOT_FOUND')
  try {
    return (await listClientNotes({ ...input, query: noteQuery(input.query) })).body
  } catch (error) {
    if (error instanceof TypeError && /^VALIDATION_FAILED\//.test(error.message)) invalid()
    throw error
  }
}

export async function postClientNote(input) {
  if (!CLIENT_ID.test(input?.clientId ?? '')) throw new AppError('NOT_FOUND')
  try { return await createClientNote(input) } catch (error) {
    if (error instanceof TypeError && /^VALIDATION_FAILED\//.test(error.message)) invalid()
    throw error
  }
}
