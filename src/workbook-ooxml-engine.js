import { strToU8 } from 'fflate'
import { canonicalPanelMetadata, signPanelMetadata } from './workbook-panel-meta.js'
import { applyWorkbookRowInsertions } from './workbook-ooxml-rows.js'
import {
  closeWorkbookPackage,
  columnName,
  ensureContentTypePart,
  forceWorkbookRecalculation,
  openWorkbookPackage,
  readXml,
  relationshipEntries,
  relationshipPartPath,
  replaceRelationshipEntries,
  replaceWorkbookSheets,
  safeWorkbookFormula,
  workbookSheets,
  withoutContentTypePart,
  xmlAttribute,
  xmlEscape,
  xmlText,
} from './workbook-ooxml-package.js'

export const PANEL_VISIBLE_SHEETS = Object.freeze([
  'Panel — Podsumowanie',
  'Panel — Wizyty',
  'Panel — Klienci',
  'Panel — Zespół',
  'Panel — TUS',
  'Panel — Angielski',
])

export const PANEL_PERMISSIONS_SHEET = 'Panel — Uprawnienia'
export const PANEL_META_SHEET = 'Panel — Meta'
export const LEGACY_ADDITIONS_SHEET = 'BWM — korekty eksportu'

const WORKSHEET_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
const SHARED_STRINGS_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings'
const WORKSHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const SHARED_STRINGS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const fail = (code) => { throw new TypeError(code) }

const cellXfCount = (files, path) => {
  const styles = path ? readXml(files, path) : ''
  const match = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs\s*>/.exec(styles)
  return match ? [...match[1].matchAll(/<xf\b/g)].length : 1
}

const plainSharedString = (value) => `<si><t${/^\s|\s$/u.test(value) ? ' xml:space="preserve"' : ''}>${xmlEscape(value)}</t></si>`

const sharedStringValues = (xml) => [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si\s*>/g)]
  .map((match) => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t\s*>/g)]
    .map((textMatch) => xmlText(textMatch[1])).join('').normalize('NFC'))

const sharedStringPool = (files, path = 'xl/sharedStrings.xml') => {
  const existing = files[path] ? readXml(files, path) : null
  const existingValues = existing ? sharedStringValues(existing) : []
  const additions = []
  const addedIndexes = new Map()
  return {
    add(value) {
      const normalized = String(value).normalize('NFC')
      if (addedIndexes.has(normalized)) return addedIndexes.get(normalized)
      const index = existingValues.length + additions.length
      additions.push(normalized)
      addedIndexes.set(normalized, index)
      return index
    },
    finish() {
      if (!existing && !additions.length) return
      const count = Object.entries(files)
        .filter(([filePath]) => /^xl\/worksheets\/[^/]+\.xml$/i.test(filePath))
        .reduce((total, [filePath]) => total
          + (readXml(files, filePath).match(/<c\b(?=[^>]*\bt=["']s["'])[^>]*>/g) ?? []).length, 0)
      const uniqueCount = existingValues.length + additions.length
      let xml = existing ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></sst>'
      xml = xml.replace(/<\/sst\s*>/, `${additions.map(plainSharedString).join('')}</sst>`)
      if (/\bcount="\d+"/.test(xml)) xml = xml.replace(/\bcount="\d+"/, `count="${count}"`)
      else xml = xml.replace(/<sst\b/, `<sst count="${count}"`)
      if (/\buniqueCount="\d+"/.test(xml)) {
        xml = xml.replace(/\buniqueCount="\d+"/, `uniqueCount="${uniqueCount}"`)
      } else {
        xml = xml.replace(/<sst\b/, `<sst uniqueCount="${uniqueCount}"`)
      }
      files[path] = strToU8(xml)
    },
  }
}

const normalizeColumns = (definition, xfCount) => {
  if (!Array.isArray(definition.columns)) fail('PANEL_SHEET_COLUMNS_INVALID')
  const seen = new Set()
  return definition.columns.map((column) => {
    if (!column || typeof column !== 'object' || Array.isArray(column)
      || typeof column.key !== 'string' || !SAFE_KEY.test(column.key) || seen.has(column.key)
      || !['boolean', 'cents', 'date', 'enum', 'formula', 'integer', 'text'].includes(column.type)) {
      fail('PANEL_SHEET_COLUMN_INVALID')
    }
    seen.add(column.key)
    const styleId = column.styleId ?? null
    if (styleId !== null && (!Number.isSafeInteger(styleId) || styleId < 0 || styleId >= xfCount)) {
      fail('PANEL_STYLE_ID_INVALID')
    }
    if (column.type === 'enum' && (!Array.isArray(column.values)
      || !column.values.length || new Set(column.values).size !== column.values.length
      || column.values.some((value) => typeof value !== 'string'))) {
      fail('PANEL_ENUM_VALUES_INVALID')
    }
    const width = column.width ?? null
    if (width !== null && (typeof width !== 'number' || !Number.isFinite(width)
      || width <= 0 || width > 255)) fail('PANEL_COLUMN_WIDTH_INVALID')
    return {
      key: column.key,
      label: typeof column.label === 'string' ? column.label.normalize('NFC') : column.key,
      styleId,
      type: column.type,
      values: column.values ? [...column.values] : null,
      width,
    }
  })
}

const normalizeSheet = (definition, xfCount) => {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)
    || typeof definition.name !== 'string' || !Array.isArray(definition.rows)) {
    fail('PANEL_SHEET_INVALID')
  }
  const columns = normalizeColumns(definition, xfCount)
  const keys = new Set(columns.map(({ key }) => key))
  const ids = new Set()
  const rows = definition.rows.map((row) => {
    if (!row || typeof row.id !== 'string' || !SAFE_ID.test(row.id) || ids.has(row.id)
      || !row.values || Array.isArray(row.values) || typeof row.values !== 'object'
      || Object.keys(row.values).some((key) => !keys.has(key))) fail('PANEL_SHEET_ROW_INVALID')
    ids.add(row.id)
    return { id: row.id, values: row.values }
  })
  return { columns, name: definition.name, rows }
}

const legacyAdditionSheet = (values, xfCount) => {
  if (values === undefined) return null
  if (!Array.isArray(values) || values.length > 5_000) fail('PANEL_LEGACY_ADDITIONS_INVALID')
  const fields = {
    paidAmountGrosze: 'Zapłacono (gr)',
    record: 'Rekord',
    specialistDisplayName: 'Specjalista',
  }
  const seen = new Set()
  const rows = values.map((value, index) => {
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || Reflect.ownKeys(value).length !== 4
      || !['action', 'field', 'id', 'value'].every((key) => Object.hasOwn(value, key))
      || typeof value.id !== 'string' || !SAFE_ID.test(value.id)
      || !['update', 'void'].includes(value.action)
      || typeof value.field !== 'string' || !Object.hasOwn(fields, value.field)
      || typeof value.value !== 'string' || value.value !== value.value.normalize('NFC')
      || new TextEncoder().encode(value.value).byteLength > 512) {
      fail('PANEL_LEGACY_ADDITION_INVALID')
    }
    const key = `${value.id}\n${value.action}\n${value.field}`
    if (seen.has(key)) fail('PANEL_LEGACY_ADDITION_DUPLICATE')
    seen.add(key)
    return {
      id: `legacy_correction_${index + 1}`,
      values: {
        action: value.action === 'void' ? 'Unieważnienie' : 'Aktualizacja',
        field: fields[value.field],
        recordId: value.id,
        value: value.value,
      },
    }
  })
  if (!rows.length) return null
  return normalizeSheet({
    name: LEGACY_ADDITIONS_SHEET,
    columns: [
      { key: 'recordId', label: 'ID rekordu', type: 'text', width: 30 },
      { key: 'action', label: 'Działanie', type: 'text', width: 18 },
      { key: 'field', label: 'Pole', type: 'text', width: 22 },
      { key: 'value', label: 'Wartość', type: 'text', width: 48 },
    ],
    rows,
  }, xfCount)
}

const cellStyle = (column) => column.styleId === null ? '' : ` s="${column.styleId}"`

const scalarCell = (reference, value, column, strings, { stripFormulas = false } = {}) => {
  const style = cellStyle(column)
  if (value === undefined) return ''
  if (value === null || value === '') return `<c r="${reference}"${style}/>`
  if (column.type === 'text' || column.type === 'enum') {
    if (typeof value !== 'string' || (column.type === 'enum' && !column.values.includes(value))) {
      fail('PANEL_CELL_VALUE_INVALID')
    }
    return `<c r="${reference}"${style} t="s"><v>${strings.add(value)}</v></c>`
  }
  if (column.type === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fail('PANEL_CELL_VALUE_INVALID')
    }
    const date = new Date(`${value}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      fail('PANEL_CELL_VALUE_INVALID')
    }
    return `<c r="${reference}"${style} t="d"><v>${value}</v></c>`
  }
  if (column.type === 'boolean') {
    if (typeof value !== 'boolean') fail('PANEL_CELL_VALUE_INVALID')
    return `<c r="${reference}"${style} t="b"><v>${value ? 1 : 0}</v></c>`
  }
  if (column.type === 'cents' || column.type === 'integer') {
    if (!Number.isSafeInteger(value)) fail('PANEL_CELL_VALUE_INVALID')
    return `<c r="${reference}"${style}><v>${value}</v></c>`
  }
  if (column.type === 'formula') {
    if (stripFormulas) return ''
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('PANEL_CELL_VALUE_INVALID')
    }
    const formula = safeWorkbookFormula(value.formula)
    const cached = value.cached
    if (typeof cached === 'number' && Number.isFinite(cached)) {
      return `<c r="${reference}"${style}><f>${xmlEscape(formula)}</f><v>${cached}</v></c>`
    }
    if (typeof cached === 'string') {
      return `<c r="${reference}"${style} t="str"><f>${xmlEscape(formula)}</f><v>${xmlEscape(cached.normalize('NFC'))}</v></c>`
    }
    fail('PANEL_FORMULA_CACHE_INVALID')
  }
  fail('PANEL_CELL_VALUE_INVALID')
}

const legacyHeader = (value) => String(value ?? '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replaceAll('ł', 'l')
  .trim()
  .toLowerCase()

const legacyColumnIndex = (reference) => {
  const letters = /^([A-Z]{1,3})\d+$/.exec(reference)?.[1]
  if (!letters) fail('PANEL_LEGACY_CELL_INVALID')
  let result = 0
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64
  return result - 1
}

const legacyCellText = (cell, sharedValues) => {
  const attributes = /^<c\b([^>]*?)(?:\/>|>)/.exec(cell)?.[1]
  if (attributes === undefined) fail('PANEL_LEGACY_CELL_INVALID')
  const type = xmlAttribute(attributes, 't')
  const body = /^<c\b[^>]*>([\s\S]*?)<\/c\s*>$/.exec(cell)?.[1] ?? ''
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t\s*>/g)]
      .map((match) => xmlText(match[1])).join('').normalize('NFC')
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v\s*>/.exec(body)?.[1] ?? ''
  if (type === 's' && /^\d+$/.test(raw)) return sharedValues[Number(raw)] ?? ''
  return xmlText(raw)
}

const legacyRowsFrom = (xml) => [...xml.matchAll(/<row\b[\s\S]*?<\/row\s*>|<row\b[^>]*\/>/g)]
  .map((match) => {
    const rowNumber = Number(xmlAttribute(/^<row\b([^>]*)/.exec(match[0])?.[1] ?? '', 'r'))
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) fail('PANEL_LEGACY_ROW_INVALID')
    return { rowNumber, source: match[0] }
  })

const legacyCellsFrom = (row) => [...row.matchAll(/<c\b[\s\S]*?(?:<\/c\s*>|\/\s*>)/g)]
  .map((match) => {
    const source = match[0]
    const attributes = /^<c\b([^>]*)/.exec(source)?.[1] ?? ''
    const reference = xmlAttribute(attributes, 'r')
    return { column: legacyColumnIndex(reference), reference, source }
  })

const legacyTransactionHeader = (xml, beforeRow, sharedValues) => {
  let selected = { columns: new Map(), rowNumber: null }
  for (const row of legacyRowsFrom(xml)) {
    if (row.rowNumber >= beforeRow) break
    const headers = new Map()
    for (const cell of legacyCellsFrom(row.source)) {
      const value = legacyHeader(legacyCellText(cell.source, sharedValues))
      if (value) headers.set(value, cell.column)
    }
    if (headers.has('usluga') && headers.has('cena') && headers.has('klient')) {
      selected = { columns: headers, rowNumber: row.rowNumber }
    }
  }
  return selected
}

const legacyStyle = (cell) => {
  const attributes = /^<c\b([^>]*)/.exec(cell)?.[1] ?? ''
  const style = xmlAttribute(attributes, 's')
  return style === null ? '' : ` s="${xmlEscape(style)}"`
}

const legacyValueCell = (reference, field, value, prior, strings) => {
  const style = prior ? legacyStyle(prior) : ''
  if (value === null || value === '') return `<c r="${reference}"${style}/>`
  if (field === 'amountGrosze') {
    if (!Number.isSafeInteger(value)) fail('PANEL_LEGACY_VALUE_INVALID')
    return `<c r="${reference}"${style}><v>${value / 100}</v></c>`
  }
  if (field === 'accountingMonth') {
    if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) {
      fail('PANEL_LEGACY_VALUE_INVALID')
    }
    return `<c r="${reference}"${style} t="s"><v>${strings.add(value)}</v></c>`
  }
  if (field === 'occurredOn') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fail('PANEL_LEGACY_VALUE_INVALID')
    }
    return `<c r="${reference}"${style} t="d"><v>${value}</v></c>`
  }
  const values = {
    invoiceStatus: {
      action_required: 'Do wystawienia', issued: 'Wystawiona',
      not_issued: 'Brak', not_required: 'Nie wymaga', unknown: '',
    },
    paymentMethod: {
      blik: 'BLIK', card: 'Karta', cash: 'Gotówka', monthly: 'Miesięcznie',
      other: 'Inne', transfer: 'Przelew', unknown: '',
    },
    settlementStatus: {
      paid: 'Opłacona', partial: 'Częściowo opłacona', unknown: '', unpaid: 'Nieopłacona',
    },
  }[field]
  if (values) {
    if (typeof value !== 'string' || !Object.hasOwn(values, value)) {
      fail('PANEL_LEGACY_VALUE_INVALID')
    }
    const rendered = values[value]
    return rendered === ''
      ? `<c r="${reference}"${style}/>`
      : `<c r="${reference}"${style} t="s"><v>${strings.add(rendered)}</v></c>`
  }
  if (field === 'specialistDisplayName') {
    if (typeof value !== 'string' || value !== value.trim().normalize('NFC') || !value) {
      fail('PANEL_LEGACY_VALUE_INVALID')
    }
    return `<c r="${reference}"${style} t="s"><v>${strings.add(value)}</v></c>`
  }
  fail('PANEL_LEGACY_FIELD_INVALID')
}

const legacyFieldColumn = (patch, field, headers) => {
  if (field === 'amountGrosze' && patch.blockIndex > 0) {
    return patch.blockIndex - 1 + (patch.recordType === 'english' ? 2 : 1)
  }
  const names = {
    accountingMonth: ['miesiac ksiegowy'],
    amountGrosze: ['cena', 'kwota'],
    invoiceStatus: ['faktura'],
    occurredOn: ['data zakupu'],
    paymentMethod: ['sposob platnosci'],
    settlementStatus: ['status'],
    specialistDisplayName: ['psycholog'],
  }[field]
  const column = names?.map((name) => headers.get(name)).find((value) => value !== undefined)
  if (column === undefined) fail('PANEL_LEGACY_FIELD_MISSING')
  return column
}

const replaceLegacyRow = (xml, rowNumber, transform) => {
  let found = false
  const result = xml.replace(/<row\b[\s\S]*?<\/row\s*>|<row\b[^>]*\/>/g, (row) => {
    const actual = Number(xmlAttribute(/^<row\b([^>]*)/.exec(row)?.[1] ?? '', 'r'))
    if (actual !== rowNumber) return row
    if (found) fail('PANEL_LEGACY_ROW_INVALID')
    found = true
    return transform(row)
  })
  if (!found) fail('PANEL_LEGACY_ROW_MISSING')
  return result
}

const expandLegacyDimension = (xml, column) => xml.replace(
  /<dimension\b([^>]*?)\bref=(["'])([A-Z]{1,3}\d+)(?::([A-Z]{1,3})(\d+))?\2([^>]*)\/>/,
  (source, before, quote, start, endColumn, endRow, after) => {
    if (!endColumn || !endRow || legacyColumnIndex(`${endColumn}${endRow}`) >= column) return source
    return `<dimension${before}ref=${quote}${start}:${columnName(column)}${endRow}${quote}${after}/>`
  },
)

const ensureLegacyColumn = (xml, header, normalizedName, displayName) => {
  if (header.columns.has(normalizedName)) return { header, xml }
  if (header.rowNumber === null) fail('PANEL_LEGACY_FIELD_MISSING')
  const column = Math.max(-1, ...header.columns.values()) + 1
  const nextXml = expandLegacyDimension(replaceLegacyRow(
    xml,
    header.rowNumber,
    (row) => {
      if (/\/>\s*$/.test(row)) fail('PANEL_LEGACY_ROW_INVALID')
      const cells = legacyCellsFrom(row)
      const prior = cells.sort((left, right) => right.column - left.column)[0]?.source
      const reference = `${columnName(column)}${header.rowNumber}`
      const cell = `<c r="${reference}"${prior ? legacyStyle(prior) : ''} t="inlineStr"><is><t>${xmlEscape(displayName)}</t></is></c>`
      return row.replace(/<\/row\s*>/, `${cell}</row>`)
    },
  ), column)
  return {
    header: {
      columns: new Map([...header.columns, [normalizedName, column]]),
      rowNumber: header.rowNumber,
    },
    xml: nextXml,
  }
}

const updateLegacyRow = (xml, patch, sharedValues, strings) => {
  let header = legacyTransactionHeader(xml, patch.rowNumber, sharedValues)
  if (patch.blockIndex === 0) {
    for (const [field, normalizedName, displayName] of [
      ['specialistDisplayName', 'psycholog', 'Psycholog'],
      ['accountingMonth', 'miesiac ksiegowy', 'Miesiąc księgowy'],
    ]) if (Object.hasOwn(patch.values, field)) {
      const prepared = ensureLegacyColumn(xml, header, normalizedName, displayName)
      xml = prepared.xml
      header = prepared.header
    }
  }
  return replaceLegacyRow(xml, patch.rowNumber, (row) => {
    if (/\/>\s*$/.test(row)) fail('PANEL_LEGACY_ROW_INVALID')
    const cells = legacyCellsFrom(row)
    const byColumn = new Map(cells.map((cell) => [cell.column, cell]))
    const replacements = new Map()
    for (const [field, value] of Object.entries(patch.values)) {
      const column = legacyFieldColumn(patch, field, header.columns)
      const reference = `${columnName(column)}${patch.rowNumber}`
      const nearestPrior = cells.filter((cell) => cell.column < column)
        .sort((left, right) => right.column - left.column)[0]?.source
      replacements.set(column, legacyValueCell(
        reference, field, value, byColumn.get(column)?.source ?? nearestPrior, strings,
      ))
    }
    const next = new Map(cells.map((cell) => [cell.column, cell.source]))
    for (const [column, cell] of replacements) next.set(column, cell)
    const content = [...next.entries()].sort(([left], [right]) => left - right)
      .map(([, cell]) => cell).join('')
    return row.replace(/(<row\b[^>]*>)[\s\S]*?(<\/row\s*>)/, `$1${content}$2`)
  })
}

const voidLegacyRow = (xml, patch) => replaceLegacyRow(xml, patch.rowNumber, (row) => {
  if (/\/>\s*$/.test(row)) return row
  if (patch.blockIndex === 0) {
    return row.replace(/(<row\b[^>]*>)[\s\S]*?(<\/row\s*>)/, '$1$2')
  }
  const start = patch.blockIndex - 1
  const width = patch.recordType === 'english' ? 3 : 2
  return row.replace(/<c\b[\s\S]*?(?:<\/c\s*>|\/\s*>)/g, (cell) => {
    const reference = xmlAttribute(/^<c\b([^>]*)/.exec(cell)?.[1] ?? '', 'r')
    const column = legacyColumnIndex(reference)
    return column >= start && column < start + width ? '' : cell
  })
})

const legacyHeaderFromRow = (row, sharedValues) => {
  const columns = new Map()
  for (const cell of legacyCellsFrom(row.source)) {
    const value = legacyHeader(legacyCellText(cell.source, sharedValues))
    if (value) columns.set(value, cell.column)
  }
  return columns.has('usluga') && columns.has('cena') && columns.has('klient')
    ? { columns, rowNumber: row.rowNumber }
    : null
}

const applyLegacySheetPatches = (xml, rows, voids, sharedValues, strings) => {
  const targetsByRow = new Map()
  for (const patch of rows) {
    const target = targetsByRow.get(patch.rowNumber) ?? { rows: [], voids: [] }
    target.rows.push(patch)
    targetsByRow.set(patch.rowNumber, target)
  }
  for (const patch of voids) {
    const target = targetsByRow.get(patch.rowNumber) ?? { rows: [], voids: [] }
    target.voids.push(patch)
    targetsByRow.set(patch.rowNumber, target)
  }
  const headers = new Map()
  const targetHeaders = new Map()
  let currentHeader = null
  for (const row of legacyRowsFrom(xml)) {
    const found = legacyHeaderFromRow(row, sharedValues)
    if (found) {
      currentHeader = found
      headers.set(row.rowNumber, found)
    }
    for (const patch of targetsByRow.get(row.rowNumber)?.rows ?? []) {
      if (patch.blockIndex === 0) targetHeaders.set(patch, currentHeader)
    }
  }
  const additions = new Map()
  let widestColumn = -1
  for (const patch of rows) {
    if (patch.blockIndex !== 0) continue
    const header = targetHeaders.get(patch)
    if (!header) fail('PANEL_LEGACY_FIELD_MISSING')
    for (const [field, normalizedName, displayName] of [
      ['specialistDisplayName', 'psycholog', 'Psycholog'],
      ['accountingMonth', 'miesiac ksiegowy', 'Miesiąc księgowy'],
    ]) {
      if (!Object.hasOwn(patch.values, field) || header.columns.has(normalizedName)) continue
      const column = Math.max(-1, ...header.columns.values()) + 1
      header.columns.set(normalizedName, column)
      const pending = additions.get(header.rowNumber) ?? []
      pending.push({ column, displayName })
      additions.set(header.rowNumber, pending)
      widestColumn = Math.max(widestColumn, column)
    }
  }
  let foundTargets = 0
  const result = xml.replace(/<row\b[\s\S]*?<\/row\s*>|<row\b[^>]*\/>/g, (row) => {
    const rowNumber = Number(xmlAttribute(/^<row\b([^>]*)/.exec(row)?.[1] ?? '', 'r'))
    const target = targetsByRow.get(rowNumber)
    const headerAdditions = additions.get(rowNumber)
    if (!target && !headerAdditions) return row
    if (target) foundTargets++
    if (/\/>\s*$/.test(row)) {
      if (target?.rows.length || headerAdditions?.length) fail('PANEL_LEGACY_ROW_INVALID')
      return row
    }
    const cells = legacyCellsFrom(row)
    const next = new Map(cells.map((cell) => [cell.column, cell.source]))
    if (headerAdditions?.length) {
      const prior = cells.sort((left, right) => right.column - left.column)[0]?.source
      for (const { column, displayName } of headerAdditions) {
        const reference = `${columnName(column)}${rowNumber}`
        next.set(column, `<c r="${reference}"${prior ? legacyStyle(prior) : ''} t="inlineStr"><is><t>${xmlEscape(displayName)}</t></is></c>`)
      }
    }
    for (const patch of target?.rows ?? []) {
      const header = targetHeaders.get(patch) ?? { columns: new Map() }
      for (const [field, value] of Object.entries(patch.values)) {
        const column = legacyFieldColumn(patch, field, header.columns)
        const reference = `${columnName(column)}${rowNumber}`
        const nearestPrior = [...next.entries()].filter(([candidate]) => candidate < column)
          .sort(([left], [right]) => right - left)[0]?.[1]
        next.set(column, legacyValueCell(
          reference, field, value, next.get(column) ?? nearestPrior, strings,
        ))
      }
    }
    for (const patch of target?.voids ?? []) {
      if (patch.blockIndex === 0) next.clear()
      else {
        const start = patch.blockIndex - 1
        const width = patch.recordType === 'english' ? 3 : 2
        for (let column = start; column < start + width; column++) next.delete(column)
      }
    }
    const content = [...next.entries()].sort(([left], [right]) => left - right)
      .map(([, cell]) => cell).join('')
    return row.replace(/(<row\b[^>]*>)[\s\S]*?(<\/row\s*>)/, `$1${content}$2`)
  })
  if (foundTargets !== targetsByRow.size) fail('PANEL_LEGACY_ROW_MISSING')
  return widestColumn < 0 ? result : expandLegacyDimension(result, widestColumn)
}

const applyLegacyPatches = (files, sheets, rows, voids, sharedValues, strings) => {
  if (!Array.isArray(rows ?? []) || !Array.isArray(voids ?? [])) {
    fail('PANEL_LEGACY_PATCHES_INVALID')
  }
  const sheetsByName = new Map(sheets.map((sheet) => [sheet.name, sheet]))
  const sheetFor = (patch) => {
    const indexed = patch.sheetIndex === undefined ? null : sheets[patch.sheetIndex]
    if (patch.sheetIndex !== undefined
      && (!Number.isSafeInteger(patch.sheetIndex) || patch.sheetIndex < 0 || !indexed)) {
      fail('PANEL_LEGACY_PATCH_INVALID')
    }
    const sheet = indexed ?? sheetsByName.get(patch.sheet)
    if (!sheet || (indexed
      && indexed.name.trim().normalize('NFC') !== patch.sheet.trim().normalize('NFC'))) {
      fail('PANEL_LEGACY_PATCH_INVALID')
    }
    return sheet
  }
  const targets = new Set()
  const capture = (patch, valuesRequired) => {
    if (!patch || typeof patch.sheet !== 'string'
      || !Number.isSafeInteger(patch.rowNumber) || patch.rowNumber < 1
      || !Number.isSafeInteger(patch.blockIndex) || patch.blockIndex < 0
      || !['english', 'expense', 'income', 'tus'].includes(patch.recordType)
      || (valuesRequired && (!patch.values || Array.isArray(patch.values)
        || typeof patch.values !== 'object' || !Object.keys(patch.values).length))) {
      fail('PANEL_LEGACY_PATCH_INVALID')
    }
    const sheet = sheetFor(patch)
    const key = `${sheet.path}\n${patch.rowNumber}\n${patch.blockIndex}`
    if (targets.has(key)) fail('PANEL_LEGACY_PATCH_DUPLICATE')
    targets.add(key)
  }
  for (const patch of rows ?? []) capture(patch, true)
  for (const patch of voids ?? []) capture(patch, false)
  const bySheet = new Map()
  for (const patch of rows ?? []) {
    const sheet = sheetFor(patch)
    const value = bySheet.get(sheet.path) ?? { rows: [], sheet, voids: [] }
    value.rows.push(patch)
    bySheet.set(sheet.path, value)
  }
  for (const patch of voids ?? []) {
    const sheet = sheetFor(patch)
    const value = bySheet.get(sheet.path) ?? { rows: [], sheet, voids: [] }
    value.voids.push(patch)
    bySheet.set(sheet.path, value)
  }
  for (const patches of bySheet.values()) {
    const { sheet } = patches
    files[sheet.path] = strToU8(applyLegacySheetPatches(
      readXml(files, sheet.path), patches.rows, patches.voids, sharedValues, strings,
    ))
  }
  if ((rows?.length ?? 0) + (voids?.length ?? 0) > 0) {
    for (const sheet of sheets) {
      files[sheet.path] = strToU8(readXml(files, sheet.path).replace(
        /<c\b[\s\S]*?(?:<\/c\s*>|\/\s*>)/g,
        (cell) => /<f\b/.test(cell)
          ? cell.replace(/<v\b[^>]*>[\s\S]*?<\/v\s*>/g, '')
          : cell,
      ))
    }
  }
}

const stringCell = (reference, value, strings, { hidden = false } = {}) => (
  `<c r="${reference}" t="s"${hidden ? ' s="0"' : ''}><v>${strings.add(value)}</v></c>`
)

const worksheetXml = (definition, strings, options = {}) => {
  const columns = [{ key: '__id', label: 'ID', type: 'text', styleId: null, width: 20 }, ...definition.columns]
  const lastColumn = columnName(Math.max(0, columns.length - 1))
  const lastRow = Math.max(2, definition.rows.length + 2)
  const machineHeader = columns.map((column, index) => (
    stringCell(`${columnName(index)}1`, column.key, strings, { hidden: true })
  )).join('')
  const labelHeader = columns.map((column, index) => (
    stringCell(`${columnName(index)}2`, column.label, strings)
  )).join('')
  const dataRows = definition.rows.map((row, rowIndex) => {
    const number = rowIndex + 3
    const cells = [stringCell(`A${number}`, row.id, strings)]
    definition.columns.forEach((column, index) => {
      const cell = scalarCell(
        `${columnName(index + 1)}${number}`,
        row.values[column.key],
        column,
        strings,
        options,
      )
      if (cell) cells.push(cell)
    })
    return `<row r="${number}">${cells.join('')}</row>`
  }).join('')
  const widthXml = columns.map((column, index) => column.width === null
    ? ''
    : `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/>${widthXml ? `<cols>${widthXml}</cols>` : ''}<sheetData><row r="1" hidden="1">${machineHeader}</row><row r="2">${labelHeader}</row>${dataRows}</sheetData></worksheet>`
}

const metadataWorksheetXml = ({ payload, signature }, strings) => (
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A3"/><sheetData><row r="1">${stringCell('A1', 'Panel-v2', strings)}</row><row r="2">${stringCell('A2', payload, strings)}</row><row r="3">${stringCell('A3', signature, strings)}</row></sheetData></worksheet>`
)

const relationshipIdNumber = (id) => Number(/^rId(\d+)$/.exec(id)?.[1] ?? 0)
const sheetPathNumber = (path) => Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(path)?.[1] ?? 0)

const removePartRelationship = (relationships, suffix) => relationships.filter((relationship) => (
  !relationship.type?.endsWith(suffix)
))

const upsertSharedStringsRelationship = (relationships) => {
  if (relationships.some(({ type }) => type?.endsWith('/sharedStrings'))) return relationships
  const next = Math.max(0, ...relationships.map(({ id }) => relationshipIdNumber(id))) + 1
  return [...relationships, {
    id: `rId${next}`,
    raw: `<Relationship Id="rId${next}" Type="${SHARED_STRINGS_TYPE}" Target="sharedStrings.xml"/>`,
    target: 'sharedStrings.xml',
    type: SHARED_STRINGS_TYPE,
  }]
}

export const patchPanelWorkbook = async (source, options, callbacks = {}) => {
  if (!options || !Array.isArray(options.sheets)) fail('PANEL_PATCH_INPUT_INVALID')
  const outputMode = options.outputMode ?? 'panel-v2'
  if (!['legacy', 'panel-v2'].includes(outputMode)
    || (outputMode === 'legacy' && (options.sheets.length > 0
      || options.includePermissions === true || options.metadata !== undefined))) {
    fail('PANEL_PATCH_INPUT_INVALID')
  }
  const files = openWorkbookPackage(source)
  const catalog = workbookSheets(files)
  const stylesPath = relationshipPartPath(
    catalog.relationships, 'xl/workbook.xml', '/styles',
  )
  const sharedStringsPath = relationshipPartPath(
    catalog.relationships, 'xl/workbook.xml', '/sharedStrings',
  ) ?? 'xl/sharedStrings.xml'
  const allPanelNames = new Set([...PANEL_VISIBLE_SHEETS, PANEL_PERMISSIONS_SHEET, PANEL_META_SHEET])
  const generatedNames = new Set([...allPanelNames, LEGACY_ADDITIONS_SHEET])
  const existingGenerated = new Map(catalog.sheets.filter(({ name }) => generatedNames.has(name))
    .map((sheet) => [sheet.name, sheet]))
  const legacySheets = catalog.sheets.filter(({ name }) => !generatedNames.has(name))
  if (outputMode === 'legacy' && !legacySheets.length) fail('PANEL_LEGACY_SHEET_MISSING')
  const xfCount = cellXfCount(files, stylesPath)
  applyWorkbookRowInsertions(files, legacySheets, options.rowInsertions, xfCount)
  const additionSheet = outputMode === 'legacy'
    ? legacyAdditionSheet(options.legacyAdditions, xfCount)
    : null
  if (outputMode === 'panel-v2' && options.legacyAdditions !== undefined) {
    fail('PANEL_LEGACY_ADDITIONS_INVALID')
  }
  const definitions = new Map()
  for (const definition of options.sheets) {
    const normalized = normalizeSheet(definition, xfCount)
    if (!PANEL_VISIBLE_SHEETS.includes(normalized.name)
      && normalized.name !== PANEL_PERMISSIONS_SHEET) fail('PANEL_SHEET_NAME_INVALID')
    if (definitions.has(normalized.name)) fail('PANEL_SHEET_DUPLICATE')
    definitions.set(normalized.name, normalized)
  }
  const visibleNames = outputMode === 'panel-v2' ? [...PANEL_VISIBLE_SHEETS] : []
  if (outputMode === 'panel-v2' && options.includePermissions === true) {
    visibleNames.push(PANEL_PERMISSIONS_SHEET)
  }
  if (outputMode === 'panel-v2' && options.includePermissions !== true
    && definitions.has(PANEL_PERMISSIONS_SHEET)) {
    fail('PANEL_PERMISSIONS_FORBIDDEN')
  }
  const panelNames = outputMode === 'panel-v2' ? [...visibleNames, PANEL_META_SHEET] : []
  const outputSheetNames = additionSheet ? [LEGACY_ADDITIONS_SHEET] : panelNames
  const signedMetadata = outputMode === 'panel-v2'
    ? await signPanelMetadata(options.metadata, callbacks.sign)
    : null
  const strings = sharedStringPool(files, sharedStringsPath)
  const sharedValues = files[sharedStringsPath]
    ? sharedStringValues(readXml(files, sharedStringsPath))
    : []
  if (outputMode === 'legacy') {
    applyLegacyPatches(
      files,
      legacySheets,
      options.legacyRows,
      options.legacyVoids,
      sharedValues,
      strings,
    )
  } else if (options.legacyRows !== undefined || options.legacyVoids !== undefined) {
    fail('PANEL_LEGACY_PATCHES_INVALID')
  }
  let nextRelationship = Math.max(
    0,
    ...catalog.relationships.map(({ id }) => relationshipIdNumber(id)),
  ) + 1
  let nextSheetId = Math.max(0, ...catalog.sheets.map(({ sheetId }) => sheetId)) + 1
  let nextPath = Math.max(0, ...Object.keys(files).map(sheetPathNumber)) + 1

  for (const sheet of existingGenerated.values()) {
    delete files[sheet.path]
    delete files[sheet.path.replace('/worksheets/', '/worksheets/_rels/') + '.rels']
  }
  delete files['xl/calcChain.xml']

  let relationships = catalog.relationships.filter((relationship) => (
    !existingGenerated.has(catalog.sheets.find(({ relationshipId }) => relationshipId === relationship.id)?.name)
  ))
  relationships = removePartRelationship(relationships, '/calcChain')
  const generated = []

  for (const name of outputSheetNames) {
    const previous = existingGenerated.get(name)
    const relationshipId = previous?.relationshipId ?? `rId${nextRelationship++}`
    const sheetId = previous?.sheetId ?? nextSheetId++
    const path = previous?.path ?? `xl/worksheets/sheet${nextPath++}.xml`
    const target = path.replace(/^xl\//, '')
    const definition = name === LEGACY_ADDITIONS_SHEET
      ? additionSheet
      : definitions.get(name) ?? { columns: [], name, rows: [] }
    files[path] = strToU8(name === PANEL_META_SHEET
      ? metadataWorksheetXml(signedMetadata, strings)
      : worksheetXml(definition, strings))
    generated.push({ name, path, relationshipId, sheetId })
    relationships.push({
      id: relationshipId,
      raw: `<Relationship Id="${xmlEscape(relationshipId)}" Type="${WORKSHEET_TYPE}" Target="${xmlEscape(target)}"/>`,
      target,
      type: WORKSHEET_TYPE,
    })
  }

  strings.finish()
  relationships = upsertSharedStringsRelationship(relationships)
  const rawSheets = [
    ...legacySheets.map(({ raw }) => raw),
    ...generated.map(({ name, relationshipId, sheetId }) => (
      `<sheet name="${xmlEscape(name)}"${name === PANEL_META_SHEET ? ' state="veryHidden"' : ''} sheetId="${sheetId}" r:id="${xmlEscape(relationshipId)}"/>`
    )),
  ]
  let workbook = replaceWorkbookSheets(readXml(files, 'xl/workbook.xml'), rawSheets)
  workbook = forceWorkbookRecalculation(workbook)
  files['xl/workbook.xml'] = strToU8(workbook)
  files['xl/_rels/workbook.xml.rels'] = strToU8(replaceRelationshipEntries(
    readXml(files, 'xl/_rels/workbook.xml.rels'), relationships,
  ))

  let contentTypes = readXml(files, '[Content_Types].xml')
  contentTypes = withoutContentTypePart(contentTypes, '/xl/calcChain.xml')
  for (const { path } of existingGenerated.values()) {
    contentTypes = withoutContentTypePart(contentTypes, `/${path}`)
  }
  for (const { path } of generated) {
    contentTypes = ensureContentTypePart(contentTypes, `/${path}`, WORKSHEET_CONTENT_TYPE)
  }
  contentTypes = ensureContentTypePart(
    contentTypes, `/${sharedStringsPath}`, SHARED_STRINGS_CONTENT_TYPE,
  )
  files['[Content_Types].xml'] = strToU8(contentTypes)
  return closeWorkbookPackage(files)
}

const SCOPED_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'

const scopedFiles = () => ({
  'xl/sharedStrings.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"></sst>'),
  'xl/styles.xml': strToU8(SCOPED_STYLES),
})

const validatedAllowlist = (values, allowed, code) => {
  if (!Array.isArray(values) || new Set(values).size !== values.length
    || values.some((value) => typeof value !== 'string' || !allowed(value))) fail(code)
  return new Set(values)
}

const withoutStyleId = (column) => {
  if (!column || typeof column !== 'object' || Array.isArray(column)) return column
  const { styleId: _styleId, ...result } = column
  return result
}

const scopedSheetPolicies = (values) => {
  if (!Array.isArray(values)) fail('PANEL_SCOPED_SHEETS_INVALID')
  const policies = new Map()
  for (const value of values) {
    if (!value || Array.isArray(value) || typeof value !== 'object'
      || typeof value.name !== 'string'
      || !Array.isArray(value.columns)
      || (!PANEL_VISIBLE_SHEETS.includes(value.name) && value.name !== PANEL_PERMISSIONS_SHEET)
      || policies.has(value.name)) fail('PANEL_SCOPED_SHEETS_INVALID')
    const columns = normalizeColumns({
      columns: value.columns.map(withoutStyleId),
    }, 1)
    policies.set(value.name, { columns, name: value.name })
  }
  return policies
}

export const createScopedPanelWorkbook = async (input, callbacks = {}) => {
  if (!input || !Array.isArray(input.sheets)) fail('PANEL_SCOPED_INPUT_INVALID')
  canonicalPanelMetadata(input.metadata)
  const sheetPolicies = scopedSheetPolicies(input.allowedSheets)
  const allowedRowSet = validatedAllowlist(
    input.allowedRowIds,
    (id) => SAFE_ID.test(id),
    'PANEL_SCOPED_ROWS_INVALID',
  )
  const metadataIds = new Set(input.metadata.rows.map(({ id }) => id))
  if ([...allowedRowSet].some((id) => !metadataIds.has(id))) fail('PANEL_SCOPED_ROW_UNSIGNED')
  const sourceDefinitions = new Map()
  for (const sourceDefinition of input.sheets) {
    if (!sourceDefinition || typeof sourceDefinition.name !== 'string'
      || sourceDefinitions.has(sourceDefinition.name)) fail('PANEL_SHEET_DUPLICATE')
    sourceDefinitions.set(sourceDefinition.name, sourceDefinition)
  }
  const signedRows = new Map(input.metadata.rows.map((row) => [row.id, row]))
  const normalizedSources = new Map()
  for (const policy of sheetPolicies.values()) {
    const sourceDefinition = sourceDefinitions.get(policy.name)
    if (!sourceDefinition) continue
    const normalized = normalizeSheet({
      ...sourceDefinition,
      columns: sourceDefinition.columns?.map(withoutStyleId),
    }, 1)
    normalizedSources.set(policy.name, normalized)
  }
  const rowPolicies = new Map()
  for (const policy of sheetPolicies.values()) {
    const source = normalizedSources.get(policy.name)
    for (const row of source?.rows ?? []) {
      if (!allowedRowSet.has(row.id)) continue
      if (rowPolicies.has(row.id)) fail('PANEL_SCOPED_ROW_SHEET_AMBIGUOUS')
      rowPolicies.set(row.id, policy)
    }
  }
  if ([...allowedRowSet].some((id) => !rowPolicies.has(id))) {
    fail('PANEL_SCOPED_ROW_SHEET_AMBIGUOUS')
  }
  const metadata = {
    format: 'Panel-v2',
    rows: input.metadata.rows.filter(({ id }) => allowedRowSet.has(id)).map((row) => {
      const authorizedFields = new Set(rowPolicies.get(row.id).columns.map(({ key }) => key))
      const fieldDigests = Object.fromEntries(Object.entries(row.fieldDigests)
        .filter(([key]) => authorizedFields.has(key)))
      if (!Object.keys(fieldDigests).length) fail('PANEL_SCOPED_ROW_FIELDS_INVALID')
      return { ...row, fieldDigests }
    }),
    scope: input.metadata.scope,
    voidIds: input.metadata.voidIds.filter((id) => allowedRowSet.has(id)),
  }
  const signedMetadata = await signPanelMetadata(metadata, callbacks.sign)
  const definitions = new Map()
  for (const policy of sheetPolicies.values()) {
    const source = normalizedSources.get(policy.name)
    const rows = (source?.rows ?? []).filter(({ id }) => allowedRowSet.has(id)).map((row) => {
      const signed = signedRows.get(row.id)
      const values = {}
      for (const { key } of policy.columns) {
        if (Object.hasOwn(signed.fieldDigests, key) && Object.hasOwn(row.values, key)) {
          values[key] = row.values[key]
        }
      }
      return { id: row.id, values }
    })
    definitions.set(policy.name, normalizeSheet({
      columns: policy.columns,
      name: policy.name,
      rows,
    }, 1))
  }
  const visibleNames = [...PANEL_VISIBLE_SHEETS, PANEL_PERMISSIONS_SHEET]
    .filter((name) => sheetPolicies.has(name))
  const files = scopedFiles()
  const strings = sharedStringPool(files)
  const generated = []
  for (const [index, name] of [...visibleNames, PANEL_META_SHEET].entries()) {
    const path = `xl/worksheets/sheet${index + 1}.xml`
    const definition = definitions.get(name) ?? { columns: [], name, rows: [] }
    files[path] = strToU8(name === PANEL_META_SHEET
      ? metadataWorksheetXml(signedMetadata, strings)
      : worksheetXml(definition, strings, { stripFormulas: true }))
    generated.push({ name, path, relationshipId: `rId${index + 1}`, sheetId: index + 1 })
  }
  strings.finish()
  const stylesRelationshipId = `rId${generated.length + 1}`
  const stringsRelationshipId = `rId${generated.length + 2}`
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  files['xl/workbook.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${generated.map(({ name, relationshipId, sheetId }) => `<sheet name="${xmlEscape(name)}"${name === PANEL_META_SHEET ? ' state="veryHidden"' : ''} sheetId="${sheetId}" r:id="${relationshipId}"/>`).join('')}</sheets><calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`)
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${generated.map(({ path, relationshipId }) => `<Relationship Id="${relationshipId}" Type="${WORKSHEET_TYPE}" Target="${path.replace(/^xl\//, '')}"/>`).join('')}<Relationship Id="${stylesRelationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="${stringsRelationshipId}" Type="${SHARED_STRINGS_TYPE}" Target="sharedStrings.xml"/></Relationships>`)
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${SHARED_STRINGS_CONTENT_TYPE}"/>${generated.map(({ path }) => `<Override PartName="/${path}" ContentType="${WORKSHEET_CONTENT_TYPE}"/>`).join('')}</Types>`)
  return closeWorkbookPackage(files)
}
