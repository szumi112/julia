const fail = (code) => { throw new TypeError(code) }

const MISSING = Symbol('panel-missing')

const civilDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('PANEL_MERGE_DATE_INVALID')
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail('PANEL_MERGE_DATE_INVALID')
  }
  return value
}

const normalizedValue = (value, field) => {
  if (value === MISSING) return MISSING
  if (value === null || value === '') return null
  if (field?.type === 'date') return civilDate(value)
  if (field?.type === 'cents') {
    if (!Number.isSafeInteger(value)) fail('PANEL_MERGE_CENTS_INVALID')
    return value
  }
  if (field?.type === 'enum') {
    if (typeof value !== 'string' || !Array.isArray(field.values)
      || !field.values.includes(value)) fail('PANEL_MERGE_ENUM_INVALID')
    return value
  }
  if (field?.type === 'text') {
    if (typeof value !== 'string') fail('PANEL_MERGE_TEXT_INVALID')
    return value.normalize('NFC')
  }
  fail('PANEL_MERGE_FIELD_TYPE_INVALID')
}

const rowsById = (rows) => {
  if (!Array.isArray(rows)) fail('PANEL_MERGE_ROWS_INVALID')
  const result = new Map()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.values || Array.isArray(row.values)
      || typeof row.values !== 'object' || result.has(row.id)) fail('PANEL_MERGE_ROW_INVALID')
    result.set(row.id, row)
  }
  return result
}

const valueFrom = (row, fieldName) => Object.hasOwn(row.values, fieldName)
  ? row.values[fieldName]
  : MISSING

const sameValue = (left, right) => Object.is(left, right)

export const mergePanelEdits = ({ baseRows, currentRows, editedRows, fields, voidIds = [] }) => {
  const baseById = rowsById(baseRows)
  const currentById = rowsById(currentRows)
  const editedById = rowsById(editedRows)
  if (!fields || Array.isArray(fields) || typeof fields !== 'object') {
    fail('PANEL_MERGE_FIELDS_INVALID')
  }
  const conflicts = []
  const unchangedIds = []
  const updates = []

  for (const editedRow of editedById.values()) {
    const baseRow = baseById.get(editedRow.id)
    const currentRow = currentById.get(editedRow.id)
    if (!baseRow || !currentRow) fail('PANEL_MERGE_ROW_INVALID')
    const values = {}
    for (const [fieldName, field] of Object.entries(fields)) {
      if (!Object.hasOwn(editedRow.values, fieldName)) continue
      const base = normalizedValue(valueFrom(baseRow, fieldName), field)
      const current = normalizedValue(valueFrom(currentRow, fieldName), field)
      const edited = normalizedValue(valueFrom(editedRow, fieldName), field)
      if (sameValue(edited, base) || sameValue(edited, current)) continue
      if (sameValue(current, base)) values[fieldName] = edited
      else conflicts.push({
        id: editedRow.id,
        field: fieldName,
        base,
        current,
        edited,
        reason: 'concurrent_edit',
      })
    }
    if (Object.keys(values).length) updates.push({ id: editedRow.id, values })
    else if (!conflicts.some(({ id }) => id === editedRow.id)) unchangedIds.push(editedRow.id)
  }

  if (!Array.isArray(voidIds) || new Set(voidIds).size !== voidIds.length) {
    fail('PANEL_MERGE_VOID_IDS_INVALID')
  }
  const voids = []
  for (const id of voidIds) {
    const baseRow = baseById.get(id)
    const currentRow = currentById.get(id)
    if (!baseRow || !currentRow || editedById.has(id)) fail('PANEL_MERGE_VOID_ID_INVALID')
    const concurrentlyChanged = Object.entries(fields).some(([fieldName, field]) => (
      !sameValue(
        normalizedValue(valueFrom(baseRow, fieldName), field),
        normalizedValue(valueFrom(currentRow, fieldName), field),
      )
    ))
    if (concurrentlyChanged) {
      conflicts.push({ id, field: null, reason: 'concurrent_void' })
    } else {
      voids.push(id)
    }
  }

  return { conflicts, unchangedIds, updates, voids }
}
