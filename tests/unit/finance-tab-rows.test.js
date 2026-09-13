import { test } from 'node:test'
import assert from 'node:assert/strict'

import { financeIncomeSettlement, financeRowsForSettlement, financeRowsForTab } from '../../src/finance-tab-rows.js'

test('payment tab contains only finance rows canonically linked to appointments', () => {
  const appointment = { id: 'fin_appointment', appointmentId: 'apt_1', kind: 'income' }
  const imported = { id: 'fin_imported', appointmentId: null, kind: 'income' }
  const expense = { id: 'fin_expense', appointmentId: null, kind: 'expense' }
  const rows = [appointment, imported, expense]

  assert.deepEqual(financeRowsForTab(rows, 'payments'), [appointment])
  assert.deepEqual(financeRowsForTab(rows, 'entries'), rows)
})

test('one income list keeps ordinary entries and appointment payments distinct', () => {
  const appointment = { id: 'fin_appointment', appointmentId: 'apt_1', kind: 'income', receivableGrosze: 18_000, collectedGrosze: 0 }
  const imported = { id: 'fin_imported', appointmentId: null, kind: 'income', receivableGrosze: 12_000, collectedGrosze: 0 }
  const paid = { id: 'fin_paid', appointmentId: 'apt_2', kind: 'income', receivableGrosze: 10_000, collectedGrosze: 10_000 }
  const expense = { id: 'fin_expense', appointmentId: null, kind: 'expense', receivableGrosze: 0, collectedGrosze: 0 }
  const rows = [appointment, imported, paid, expense]

  assert.deepEqual(financeRowsForTab(rows, 'income'), [appointment, imported, paid])
  assert.deepEqual(financeRowsForTab(rows, 'expenses'), [expense])
  assert.deepEqual(financeRowsForSettlement(rows, true), [appointment, imported])
  assert.deepEqual(financeRowsForSettlement(rows, false), [appointment, imported, paid])
})

test('income settlement leaves an imported unknown payment amount unasserted', () => {
  const imported = { id: 'fin_imported', kind: 'income', appointmentId: null,
    invoiceStatus: 'unknown', settlementStatus: 'unknown', receivableGrosze: 18_000, collectedGrosze: 0 }
  const issued = { id: 'fin_issued', kind: 'income', appointmentId: null,
    invoiceStatus: 'issued', settlementStatus: 'paid', receivableGrosze: 18_000, collectedGrosze: 18_000 }
  const excluded = { id: 'fin_excluded', kind: 'income', appointmentId: null,
    invoiceStatus: 'not_required', settlementStatus: 'unpaid', receivableGrosze: 18_000, collectedGrosze: 0 }

  assert.deepEqual(financeIncomeSettlement(imported), { amountsKnown: false, outstandingGrosze: 18_000 })
  assert.deepEqual(financeIncomeSettlement(issued), { amountsKnown: true, outstandingGrosze: 0 })
  assert.deepEqual(financeRowsForTab([imported, issued, excluded], 'invoices'), [imported, issued])
})
