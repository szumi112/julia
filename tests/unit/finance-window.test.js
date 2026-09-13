import test from 'node:test'
import assert from 'node:assert/strict'

import { financeWindowPresentation } from '../../src/views/use-finance-window.js'

const windowFor = (selectedMonth) => ({ selectedMonth })

test('finance window keeps verified data visible only while it belongs to the selected month', () => {
  assert.deepEqual(financeWindowPresentation({
    selectedMonth: '2026-08', requestMonth: '2026-08', status: 'ready',
    data: windowFor('2026-08'), error: null,
  }), { phase: 'ready', isCurrent: true, isStale: false })

  assert.deepEqual(financeWindowPresentation({
    selectedMonth: '2026-09', requestMonth: '2026-09', status: 'refreshing',
    data: windowFor('2026-08'), error: null,
  }), { phase: 'refreshing', isCurrent: false, isStale: false })
})

test('finance window distinguishes initial and refresh failures without inventing current facts', () => {
  assert.deepEqual(financeWindowPresentation({
    selectedMonth: '2026-08', requestMonth: '2026-08', status: 'loading', data: null, error: null,
  }), { phase: 'loading', isCurrent: false, isStale: false })

  assert.deepEqual(financeWindowPresentation({
    selectedMonth: '2026-08', requestMonth: '2026-08', status: 'error', data: null, error: Error('offline'),
  }), { phase: 'error', isCurrent: false, isStale: false })

  assert.deepEqual(financeWindowPresentation({
    selectedMonth: '2026-08', requestMonth: '2026-08', status: 'error',
    data: windowFor('2026-08'), error: Error('offline'),
  }), { phase: 'refresh-error', isCurrent: true, isStale: true })

  assert.deepEqual(financeWindowPresentation({
    selectedMonth: '2026-09', requestMonth: '2026-09', status: 'error',
    data: windowFor('2026-08'), error: Error('offline'),
  }), { phase: 'error', isCurrent: false, isStale: false })
})
