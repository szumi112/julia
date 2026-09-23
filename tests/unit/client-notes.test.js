import test from 'node:test'
import assert from 'node:assert/strict'
import {
  captureClientNote,
  captureClientNoteInput,
  captureClientNotesPayload,
  captureClientNotesQuery,
} from '../../src/client-notes.js'
import { captureCoreAuditEvent } from '../../src/core-audit-contract.js'

const NOTE = Object.freeze({
  id: 'cno_abc', clientId: 'cl_abc', authorStaffId: 'stf_abc',
  authorSpecialistId: 'sp_abc', createdAt: '2026-09-22T12:00:00.000Z',
  text: 'Fikcyjna obserwacja.\nKolejny krok.',
})

test('note input accepts line breaks and rejects control text, malformed Unicode and oversized UTF-8', () => {
  assert.deepEqual(captureClientNoteInput({ text: NOTE.text }), { text: NOTE.text })
  for (const text of ['', ' ', ' tekst ', 'linia\ttab', 'linia\rdruga',
    'x\u200by', '\ud800', 'a'.repeat(4001), 'ą'.repeat(4000) + '😀']) {
    assert.equal(captureClientNoteInput({ text }), null)
  }
  assert.equal(captureClientNoteInput({ text: NOTE.text, clientId: NOTE.clientId }), null)
})

test('note query defaults to a bounded first page and rejects unknown parameters', () => {
  assert.deepEqual(captureClientNotesQuery({}), { limit: 20, cursor: null })
  assert.deepEqual(captureClientNotesQuery({ limit: 2, cursor: 'v1.1.c29tZQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), {
    limit: 2, cursor: 'v1.1.c29tZQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  })
  for (const value of [{ limit: 0 }, { limit: 51 }, { limit: '2' }, { other: 1 }, { cursor: 'bad cursor' }]) {
    assert.equal(captureClientNotesQuery(value), null)
  }
})

test('note payload accepts only chronological author-labelled DTOs', () => {
  assert.deepEqual(captureClientNote(NOTE), NOTE)
  assert.deepEqual(captureClientNotesPayload({ items: [NOTE], nextCursor: null }), {
    items: [NOTE], nextCursor: null,
  })
  assert.equal(captureClientNote({ ...NOTE, rawEnvelope: 'private' }), null)
  assert.equal(captureClientNotesPayload({ items: [NOTE, NOTE], nextCursor: null }), null)
  assert.equal(captureClientNotesPayload({ items: [{ ...NOTE, text: '\u0000' }], nextCursor: null }), null)
})

test('client note audit accepts only generic metadata and no note content', () => {
  const event = {
    action: 'client.note.created', actorStaffId: 'stf_abc',
    entityType: 'client', entityId: 'cl_abc', result: 'success', metadata: {},
  }
  assert.deepEqual(captureCoreAuditEvent(event), event)
  assert.equal(captureCoreAuditEvent({ ...event, metadata: { text: NOTE.text } }), null)
  assert.equal(captureCoreAuditEvent({ ...event, entityId: NOTE.id }), null)
})
