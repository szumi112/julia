import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FORBIDDEN_COPY, NETWORK_COPY, RATE_LIMIT_COPY, conflictCopy, loadFailureCopy, saveFailureCopy,
} from '../../src/save-failure-copy.js'

test('save failures name the cause and the next step', () => {
  assert.equal(saveFailureCopy({ code: 'NETWORK_ERROR', status: 0 }, { subject: 'sesji' }), NETWORK_COPY)
  assert.equal(saveFailureCopy({ code: 'RATE_LIMITED', status: 429 }), RATE_LIMIT_COPY)
  assert.equal(saveFailureCopy({ code: 'FORBIDDEN', status: 403 }), FORBIDDEN_COPY)
  assert.equal(saveFailureCopy({ code: 'VERSION_CONFLICT', status: 409 }), conflictCopy())
  assert.equal(saveFailureCopy({ code: 'INTERNAL_ERROR', status: 500 }, { subject: 'sesji' }),
    'Nie udało się zapisać sesji. Spróbuj ponownie za chwilę.')
  assert.equal(saveFailureCopy(new Error('boom'), { subject: 'wpłaty' }),
    'Nie udało się zapisać wpłaty. Spróbuj ponownie za chwilę.')
})

test('load failures use one plain template', () => {
  assert.equal(loadFailureCopy('Grafiku'), 'Nie udało się wczytać Grafiku. Spróbuj ponownie za chwilę.')
})
