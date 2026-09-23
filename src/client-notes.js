import { isWellFormedUnicode } from './core-records.js'

const NOTE_ID = /^cno_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const CLIENT_ID = /^cl_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const STAFF_ID = /^stf_[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/
const SPECIALIST_ID = /^sp_[A-Za-z0-9][A-Za-z0-9_-]{0,124}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CURSOR = /^v1\.[1-9]\d*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/
const INVALID_TEXT = /[\p{Cc}\p{Cf}]/u

const exact = (value, required, optional = []) => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length < required.length || keys.length > required.length + optional.length
      || !required.every((key) => keys.includes(key))
      || keys.some((key) => typeof key !== 'string'
        || ![...required, ...optional].includes(key))) return null
    const copy = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      copy[key] = descriptor.value
    }
    return copy
  } catch { return null }
}

const validText = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4000
    || value !== value.trim() || value !== value.normalize('NFC')
    || !isWellFormedUnicode(value)
    || INVALID_TEXT.test(value.replaceAll('\n', ''))) return false
  const bytes = new TextEncoder().encode(value)
  const valid = bytes.byteLength <= 8000
  bytes.fill(0)
  return valid
}

const validInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

const validCursor = (value) => typeof value === 'string' && value.length <= 1024
  && CURSOR.test(value)

export function captureClientNoteInput(value) {
  const input = exact(value, ['text'])
  return input && validText(input.text) ? Object.freeze(input) : null
}

export function captureClientNotesQuery(value = {}) {
  const query = exact(value, [], ['limit', 'cursor'])
  if (!query) return null
  const limit = query.limit ?? 20
  const cursor = query.cursor ?? null
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50
    || (cursor !== null && !validCursor(cursor))) return null
  return Object.freeze({ limit, cursor })
}

export function captureClientNote(value) {
  const note = exact(value, [
    'id', 'clientId', 'authorStaffId', 'authorSpecialistId', 'createdAt', 'text',
  ])
  if (!note || !NOTE_ID.test(note.id) || !CLIENT_ID.test(note.clientId)
    || !STAFF_ID.test(note.authorStaffId)
    || !SPECIALIST_ID.test(note.authorSpecialistId)
    || !validInstant(note.createdAt) || !validText(note.text)) return null
  return Object.freeze(note)
}

export function captureClientNotesPayload(value) {
  const payload = exact(value, ['items', 'nextCursor'])
  if (!payload || !Array.isArray(payload.items) || payload.items.length > 50
    || (payload.nextCursor !== null && !validCursor(payload.nextCursor))) return null
  const items = payload.items.map(captureClientNote)
  if (items.some((item) => !item)
    || new Set(items.map((item) => item.id)).size !== items.length) return null
  for (let index = 1; index < items.length; index += 1) {
    const before = items[index - 1]
    const after = items[index]
    if (before.clientId !== after.clientId
      || before.authorStaffId !== after.authorStaffId
      || before.authorSpecialistId !== after.authorSpecialistId
      || before.createdAt < after.createdAt
      || (before.createdAt === after.createdAt && before.id <= after.id)) return null
  }
  return Object.freeze({ items: Object.freeze(items), nextCursor: payload.nextCursor })
}
