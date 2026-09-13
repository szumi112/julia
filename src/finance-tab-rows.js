export function financeRowsForTab(rows, tab) {
  if (!Array.isArray(rows)) return []
  if (tab === 'income') return rows.filter(({ kind }) => kind === 'income')
  if (tab === 'expenses') return rows.filter(({ kind }) => kind === 'expense')
  if (tab === 'invoices') return rows.filter(({ kind, invoiceStatus }) => (
    kind === 'income' && invoiceStatus !== 'not_required'
  ))
  if (tab === 'entries') return rows
  if (tab === 'payments') return rows.filter(({ appointmentId }) => (
    typeof appointmentId === 'string' && appointmentId.length > 0
  ))
  return []
}

export function financeRowsForSettlement(rows, unpaidOnly) {
  const income = financeRowsForTab(rows, 'income')
  if (!unpaidOnly) return income
  return income.filter((row) => row.receivableGrosze - row.collectedGrosze > 0)
}

export function financeIncomeSettlement(row) {
  return {
    amountsKnown: row?.settlementStatus !== 'unknown',
    outstandingGrosze: row.receivableGrosze - row.collectedGrosze,
  }
}
