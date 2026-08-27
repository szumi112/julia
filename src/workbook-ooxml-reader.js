import { verifyPanelMetadata } from './workbook-panel-meta.js'
import {
  openWorkbookPackage,
  readXml,
  relationshipPartPath,
  workbookSheets,
  xmlAttribute,
  xmlText,
} from './workbook-ooxml-package.js'
import {
  PANEL_META_SHEET,
  PANEL_PERMISSIONS_SHEET,
  PANEL_VISIBLE_SHEETS,
} from './workbook-ooxml-engine.js'

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/

const fail = (code) => { throw new TypeError(code) }

const columnIndex = (reference) => {
  const letters = /^([A-Z]{1,3})\d+$/.exec(reference)?.[1]
  if (!letters) fail('WORKBOOK_CELL_REFERENCE_INVALID')
  let value = 0
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64
  return value - 1
}

const sharedStringsFrom = (files, path) => {
  if (!path) return []
  const xml = readXml(files, path)
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si\s*>/g)].map((match) => (
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t\s*>/g)]
      .map((textMatch) => xmlText(textMatch[1])).join('').normalize('NFC')
  ))
}

const cellValue = (attributes, body, sharedStrings) => {
  const type = xmlAttribute(attributes, 't')
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t\s*>/g)]
      .map((match) => xmlText(match[1])).join('').normalize('NFC')
  }
  const raw = /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v\s*>/.exec(body)?.[1]
  if (raw === undefined) return null
  const value = xmlText(raw)
  if (type === 's') {
    const index = Number(value)
    if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) {
      fail('WORKBOOK_SHARED_STRING_INVALID')
    }
    return sharedStrings[index]
  }
  if (type === 'str' || type === 'd') return value.normalize('NFC')
  if (type === 'b') {
    if (value !== '0' && value !== '1') fail('WORKBOOK_CELL_VALUE_INVALID')
    return value === '1'
  }
  if (type && type !== 'n') fail('WORKBOOK_CELL_TYPE_INVALID')
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) fail('WORKBOOK_CELL_VALUE_INVALID')
  return numeric
}

const worksheetRows = (xml, sharedStrings) => {
  const rows = new Map()
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)>([\s\S]*?)<\/row\s*>|<row\b([^>]*?)\/>/g)) {
    const attributes = rowMatch[1] ?? rowMatch[3] ?? ''
    const rowNumber = Number(xmlAttribute(attributes, 'r'))
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rows.has(rowNumber)) {
      fail('WORKBOOK_ROW_INVALID')
    }
    const cells = new Map()
    const body = rowMatch[2] ?? ''
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)>([\s\S]*?)<\/c\s*>|<c\b([^>]*?)\/>/g)) {
      const cellAttributes = cellMatch[1] ?? cellMatch[3] ?? ''
      const reference = xmlAttribute(cellAttributes, 'r')
      const referenceRow = Number(/^[A-Z]{1,3}([1-9]\d*)$/.exec(reference)?.[1])
      if (!Number.isSafeInteger(referenceRow) || referenceRow !== rowNumber) {
        fail('WORKBOOK_CELL_REFERENCE_INVALID')
      }
      const column = columnIndex(reference)
      if (cells.has(column)) fail('WORKBOOK_CELL_DUPLICATE')
      const cellBody = cellMatch[2] ?? ''
      cells.set(column, {
        formula: /<(?:[A-Za-z_][\w.-]*:)?f\b/.test(cellBody),
        value: cellValue(cellAttributes, cellBody, sharedStrings),
      })
    }
    rows.set(rowNumber, cells)
  }
  return rows
}

const requiredStringCell = (rows, rowNumber, column) => {
  const cell = rows.get(rowNumber)?.get(column)
  if (!cell || cell.formula || typeof cell.value !== 'string') fail('PANEL_META_INVALID')
  return cell.value
}

const metadataDimension = (xml) => {
  const dimensions = [...xml.matchAll(/<dimension\b([^>]*?)(?:\/>|>[\s\S]*?<\/dimension\s*>)/g)]
  if (!dimensions.length) return
  if (dimensions.length !== 1) fail('PANEL_META_INVALID')
  const reference = xmlAttribute(dimensions[0][1], 'ref')
  const references = reference?.split(':') ?? []
  if (!references.length || references.length > 2) fail('PANEL_META_INVALID')
  const bounds = references.map((value) => {
    const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(value)
    if (!match) fail('PANEL_META_INVALID')
    const row = Number(match[2])
    if (!Number.isSafeInteger(row)) fail('PANEL_META_INVALID')
    return { column: columnIndex(value), row }
  })
  const [start, end = start] = bounds
  if (start.column > end.column || start.row > end.row
    || start.column > 0 || start.row > 1 || end.column < 0 || end.row < 3) {
    fail('PANEL_META_INVALID')
  }
}

const readSignedMetadata = async (files, metaSheet, sharedStrings, verify) => {
  const xml = readXml(files, metaSheet.path)
  metadataDimension(xml)
  const rows = worksheetRows(xml, sharedStrings)
  if (rows.size !== 3 || [...rows.entries()].some(([rowNumber, cells]) => (
    rowNumber < 1 || rowNumber > 3 || cells.size !== 1 || !cells.has(0)
  ))) fail('PANEL_META_INVALID')
  if (requiredStringCell(rows, 1, 0) !== 'Panel-v2') fail('PANEL_META_INVALID')
  return verifyPanelMetadata({
    payload: requiredStringCell(rows, 2, 0),
    signature: requiredStringCell(rows, 3, 0),
  }, verify)
}

const isResidualMetadataCandidate = (files, sheet, sharedStrings) => {
  if (sheet.state !== 'veryHidden' || !sheet.relationship.type?.endsWith('/worksheet')
    || (sheet.relationship.targetMode
      && sheet.relationship.targetMode.toLowerCase() !== 'internal')) return false
  const xml = readXml(files, sheet.path)
  for (const match of xml.matchAll(/<c\b([^>]*?)>([\s\S]*?)<\/c\s*>/g)) {
    const reference = xmlAttribute(match[1], 'r')
    if (reference !== 'A1' || /<(?:[A-Za-z_][\w.-]*:)?f\b/.test(match[2])) continue
    try {
      if (cellValue(match[1], match[2], sharedStrings) === 'Panel-v2') return true
    } catch {}
  }
  return false
}

const headerColumns = (rows) => {
  const header = rows.get(1)
  if (!header?.size || header.get(0)?.value !== '__id' || header.get(0)?.formula) {
    fail('PANEL_HEADER_INVALID')
  }
  const result = new Map()
  for (const [column, cell] of header) {
    if (cell.formula || typeof cell.value !== 'string') fail('PANEL_HEADER_INVALID')
    const key = cell.value.normalize('NFC')
    if ((column > 0 && !SAFE_KEY.test(key)) || result.has(key)) fail('PANEL_HEADER_INVALID')
    result.set(key, column)
  }
  return result
}

const editsFromSheet = (files, sheet, sharedStrings, signedRows, seenIds) => {
  const rows = worksheetRows(readXml(files, sheet.path), sharedStrings)
  const columns = headerColumns(rows)
  const edits = []
  for (const [rowNumber, cells] of rows) {
    if (rowNumber <= 2) continue
    const idCell = cells.get(columns.get('__id'))
    const populated = [...cells.values()].some(({ value }) => value !== null)
    if (!idCell || idCell.formula || typeof idCell.value !== 'string') {
      if (populated) fail('PANEL_ROW_ID_INVALID')
      continue
    }
    const id = idCell.value
    const signed = signedRows.get(id)
    if (!signed) fail('PANEL_ROW_ID_UNSIGNED')
    if (seenIds.has(id)) fail('PANEL_ROW_ID_DUPLICATE')
    seenIds.add(id)
    const values = {}
    for (const [key, column] of columns) {
      if (key === '__id' || !cells.has(column)) continue
      if (!Object.hasOwn(signed.fieldDigests, key)) fail('PANEL_FIELD_UNSIGNED')
      const cell = cells.get(column)
      if (cell.formula) fail('PANEL_EDIT_FORMULA_FORBIDDEN')
      if (typeof cell.value === 'number' && !Number.isSafeInteger(cell.value)) {
        fail('PANEL_EDIT_NUMBER_INVALID')
      }
      values[key] = typeof cell.value === 'string' ? cell.value.normalize('NFC') : cell.value
    }
    edits.push({ id, sheet: sheet.name, values })
  }
  return edits
}

export const readPanelWorkbook = async (source, { verify } = {}) => {
  const files = openWorkbookPackage(source)
  const catalog = workbookSheets(files)
  const sharedStrings = sharedStringsFrom(files, relationshipPartPath(
    catalog.relationships, 'xl/workbook.xml', '/sharedStrings',
  ))
  const recognized = new Set([...PANEL_VISIBLE_SHEETS, PANEL_PERMISSIONS_SHEET, PANEL_META_SHEET])
  const panelSheets = catalog.sheets.filter(({ name }) => recognized.has(name))
  const residualCandidates = catalog.sheets.filter((sheet) => (
    isResidualMetadataCandidate(files, sheet, sharedStrings)
  ))
  const hasPanelArtifacts = panelSheets.length > 0
    || catalog.sheets.some(({ name }) => name.startsWith('Panel — '))
    || residualCandidates.length > 0
  if (!hasPanelArtifacts) {
    return { edits: [], kind: 'legacy', metadata: null, voidIds: [] }
  }
  const metaSheets = panelSheets.filter(({ name }) => name === PANEL_META_SHEET)
  if (metaSheets.length !== 1) {
    if (residualCandidates.length === 1) {
      await readSignedMetadata(files, residualCandidates[0], sharedStrings, verify)
    }
    fail('PANEL_META_REQUIRED')
  }
  if (residualCandidates.some(({ path }) => path !== metaSheets[0].path)) {
    fail('PANEL_META_INVALID')
  }
  const names = new Set()
  for (const sheet of panelSheets) {
    if (names.has(sheet.name)) fail('PANEL_SHEET_DUPLICATE')
    names.add(sheet.name)
  }
  const metadata = await readSignedMetadata(files, metaSheets[0], sharedStrings, verify)
  const signedRows = new Map(metadata.rows.map((row) => [row.id, row]))
  const seenIds = new Set()
  const edits = panelSheets
    .filter(({ name }) => name !== PANEL_META_SHEET && name !== 'Panel — Podsumowanie')
    .flatMap((sheet) => editsFromSheet(files, sheet, sharedStrings, signedRows, seenIds))
    .sort((left, right) => left.id.localeCompare(right.id))
  if (metadata.voidIds.some((id) => seenIds.has(id))) fail('PANEL_VOID_ROW_PRESENT')
  return {
    edits,
    kind: 'panel-v2',
    metadata,
    voidIds: [...metadata.voidIds],
  }
}
