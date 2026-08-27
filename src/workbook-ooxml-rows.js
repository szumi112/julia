import { strToU8 } from 'fflate'
import {
  columnName,
  readXml,
  relationshipEntries,
  resolveRelationshipTarget,
  xmlEscape,
  xmlText,
} from './workbook-ooxml-package.js'

const fail = (code) => { throw new TypeError(code) }

const referenceParts = (reference) => {
  const match = /^(\$?[A-Z]{1,3})(\$?)(\d+)$/.exec(reference)
  return match ? { column: match[1], absoluteRow: match[2], row: Number(match[3]) } : null
}

const shiftedReference = (reference, beforeRow, count) => {
  const parsed = referenceParts(reference)
  if (!parsed || parsed.row < beforeRow) return reference
  return `${parsed.column}${parsed.absoluteRow}${parsed.row + count}`
}

const sheetNameFromQualifier = (qualifier) => {
  if (!qualifier) return null
  const value = qualifier.slice(0, -1)
  return value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replaceAll("''", "'")
    : value
}

const shiftFormula = (formula, sheetName, beforeRow, count, { shiftUnqualified = true } = {}) => formula.replace(
  /"(?:[^"]|"")*"|(?<![A-Za-z0-9_.])((?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?(?![A-Za-z0-9_.(])/g,
  (match, qualifier, reference, rangeEnd) => {
    if (match.startsWith('"')) return match
    const qualifiedSheet = sheetNameFromQualifier(qualifier)
    if (qualifiedSheet === null && !shiftUnqualified) return match
    if (qualifiedSheet !== null && qualifiedSheet !== sheetName) return match
    return `${qualifier ?? ''}${shiftedReference(reference, beforeRow, count)}${
      rangeEnd ? `:${shiftedReference(rangeEnd, beforeRow, count)}` : ''
    }`
  },
)

const shiftFormulaCell = (cell, sheetName, beforeRow, count, {
  clearAllCaches = false,
  shiftFormulaRef = false,
  shiftUnqualified = true,
} = {}) => {
  let changed = false
  let result = shiftFormulaRef ? cell.replace(
    /<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*(?:\/>|>)/g,
    (open) => replaceAttribute(open, 'ref', (value) => {
      const shifted = shiftRange(value, beforeRow, count)
      changed ||= shifted !== value
      return shifted
    }),
  ) : cell
  result = result.replace(
    /(<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*>)([\s\S]*?)(<\/(?:[A-Za-z_][\w.-]*:)?f\s*>)/g,
    (_, open, formula, close) => {
      const source = xmlText(formula)
      const shifted = shiftFormula(source, sheetName, beforeRow, count, { shiftUnqualified })
      changed ||= shifted !== source
      return `${open}${xmlEscape(shifted)}${close}`
    },
  )
  if (changed || clearAllCaches) {
    result = result.replace(/<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?v\s*>/g, '')
  }
  return result
}

const replaceAttribute = (source, name, transform) => {
  const expression = new RegExp(`(\\b${name}\\s*=\\s*)(["'])([^"']*)(\\2)`)
  return source.replace(expression, (_, prefix, quote, value) => (
    `${prefix}${quote}${transform(value)}${quote}`
  ))
}

const shiftRowXml = (rowXml, sheetName, beforeRow, count) => {
  let shifted = replaceAttribute(rowXml, 'r', (value) => {
    const row = Number(value)
    return Number.isSafeInteger(row) && row >= beforeRow ? String(row + count) : value
  })
  shifted = shifted.replace(/<c\b[\s\S]*?(?:<\/c\s*>|\/>)/g, (cell) => {
    let result = replaceAttribute(cell, 'r', (reference) => (
      shiftedReference(reference, beforeRow, count)
    ))
    if (/<(?:[A-Za-z_][\w.-]*:)?f\b/.test(result)) {
      result = shiftFormulaCell(result, sheetName, beforeRow, count, {
        clearAllCaches: true,
        shiftFormulaRef: true,
      })
    }
    return result
  })
  return shifted
}

const shiftWorksheetFormulaReferences = (xml, sheetName, beforeRow, count) => xml.replace(
  /<c\b[\s\S]*?(?:<\/c\s*>|\/>)/g,
  (cell) => /<(?:[A-Za-z_][\w.-]*:)?f\b/.test(cell)
    ? shiftFormulaCell(cell, sheetName, beforeRow, count, { shiftUnqualified: false })
    : cell,
)

const shiftDefinedNames = (xml, sheetName, beforeRow, count) => xml.replace(
  /(<definedName\b[^>]*>)([\s\S]*?)(<\/definedName\s*>)/g,
  (_, open, formula, close) => {
    const source = xmlText(formula)
    const shifted = shiftFormula(source, sheetName, beforeRow, count, { shiftUnqualified: false })
    return shifted === source ? `${open}${formula}${close}` : `${open}${xmlEscape(shifted)}${close}`
  },
)

const shiftRange = (range, beforeRow, count) => range.split(':')
  .map((reference) => shiftedReference(reference, beforeRow, count)).join(':')

const shiftRangeAttributes = (xml, beforeRow, count) => xml.replace(
  /(<(?:dimension|mergeCell|autoFilter|hyperlink)\b[^>]*\bref\s*=\s*)(["'])([^"']+)(\2)/g,
  (_, prefix, quote, ranges) => `${prefix}${quote}${ranges.split(/\s+/)
    .map((range) => shiftRange(range, beforeRow, count)).join(' ')}${quote}`,
).replace(
  /(<(?:conditionalFormatting|dataValidation)\b[^>]*\bsqref\s*=\s*)(["'])([^"']+)(\2)/g,
  (_, prefix, quote, ranges) => `${prefix}${quote}${ranges.split(/\s+/)
    .map((range) => shiftRange(range, beforeRow, count)).join(' ')}${quote}`,
)

const insertedCell = (cell, index, rowNumber, xfCount) => {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) fail('PANEL_ROW_INSERT_CELL_INVALID')
  const styleId = cell.styleId ?? null
  if (styleId !== null && (!Number.isSafeInteger(styleId) || styleId < 0 || styleId >= xfCount)) {
    fail('PANEL_STYLE_ID_INVALID')
  }
  const reference = `${columnName(index)}${rowNumber}`
  const style = styleId === null ? '' : ` s="${styleId}"`
  if (cell.value === null || cell.value === undefined || cell.value === '') {
    return `<c r="${reference}"${style}/>`
  }
  if (cell.type === 'text') {
    if (typeof cell.value !== 'string') fail('PANEL_ROW_INSERT_CELL_INVALID')
    const value = cell.value.normalize('NFC')
    return `<c r="${reference}"${style} t="inlineStr"><is><t${/^\s|\s$/u.test(value) ? ' xml:space="preserve"' : ''}>${xmlEscape(value)}</t></is></c>`
  }
  if (cell.type === 'date') {
    if (typeof cell.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cell.value)) {
      fail('PANEL_ROW_INSERT_CELL_INVALID')
    }
    return `<c r="${reference}"${style} t="d"><v>${cell.value}</v></c>`
  }
  if (cell.type === 'boolean') {
    if (typeof cell.value !== 'boolean') fail('PANEL_ROW_INSERT_CELL_INVALID')
    return `<c r="${reference}"${style} t="b"><v>${cell.value ? 1 : 0}</v></c>`
  }
  if (cell.type === 'integer' || cell.type === 'cents') {
    if (!Number.isSafeInteger(cell.value)) fail('PANEL_ROW_INSERT_CELL_INVALID')
    return `<c r="${reference}"${style}><v>${cell.value}</v></c>`
  }
  fail('PANEL_ROW_INSERT_CELL_INVALID')
}

const insertedRowsXml = (rows, beforeRow, xfCount) => rows.map((row, index) => {
  if (!row || !Array.isArray(row.cells)) fail('PANEL_ROW_INSERT_INVALID')
  const rowNumber = beforeRow + index
  return `<row r="${rowNumber}">${row.cells.map((cell, column) => (
    insertedCell(cell, column, rowNumber, xfCount)
  )).join('')}</row>`
}).join('')

const insertIntoWorksheet = (xml, sheetName, { beforeRow, rows }, xfCount) => {
  if (!Number.isSafeInteger(beforeRow) || beforeRow < 1 || !Array.isArray(rows) || !rows.length) {
    fail('PANEL_ROW_INSERT_INVALID')
  }
  const sheetData = /(<sheetData\b[^>]*>)([\s\S]*?)(<\/sheetData\s*>)/.exec(xml)
  if (!sheetData) fail('WORKBOOK_WORKSHEET_INVALID')
  const count = rows.length
  const existingRows = [...sheetData[2].matchAll(/<row\b[\s\S]*?<\/row\s*>|<row\b[^>]*\/>/g)]
    .map((match) => shiftRowXml(match[0], sheetName, beforeRow, count))
  const beforeIndex = existingRows.findIndex((row) => {
    const value = Number(/<row\b[^>]*\br\s*=\s*["'](\d+)["']/.exec(row)?.[1])
    return Number.isSafeInteger(value) && value >= beforeRow + count
  })
  existingRows.splice(
    beforeIndex < 0 ? existingRows.length : beforeIndex,
    0,
    insertedRowsXml(rows, beforeRow, xfCount),
  )
  let result = xml.replace(sheetData[0], `${sheetData[1]}${existingRows.join('')}${sheetData[3]}`)
  result = shiftRangeAttributes(result, beforeRow, count)
  return result
}

const relationshipPathFor = (worksheetPath) => {
  const components = worksheetPath.split('/')
  const file = components.pop()
  return `${components.join('/')}/_rels/${file}.rels`
}

const shiftDrawingAnchors = (files, sheet, beforeRow, count) => {
  const relationshipPath = relationshipPathFor(sheet.path)
  if (!files[relationshipPath]) return
  const relationships = relationshipEntries(readXml(files, relationshipPath))
  for (const relationship of relationships) {
    if (!relationship.type?.endsWith('/drawing')) continue
    const path = resolveRelationshipTarget(sheet.path, relationship.target)
    if (!files[path]) fail('WORKBOOK_DRAWING_RELATIONSHIP_INVALID')
    const drawing = readXml(files, path).replace(
      /(<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*>)(\d+)(<\/(?:[A-Za-z_][\w.-]*:)?row\s*>)/g,
      (_, open, value, close) => {
        const row = Number(value)
        return `${open}${row >= beforeRow - 1 ? row + count : row}${close}`
      },
    )
    files[path] = strToU8(drawing)
  }
}

export const applyWorkbookRowInsertions = (files, sheets, insertions, xfCount) => {
  if (insertions === undefined) return
  if (!Array.isArray(insertions)) fail('PANEL_ROW_INSERTIONS_INVALID')
  const sheetsByName = new Map(sheets.map((sheet) => [sheet.name, sheet]))
  const bySheet = new Map()
  for (const insertion of insertions) {
    if (!insertion || typeof insertion.sheet !== 'string' || !sheetsByName.has(insertion.sheet)) {
      fail('PANEL_ROW_INSERT_SHEET_INVALID')
    }
    const list = bySheet.get(insertion.sheet) ?? []
    list.push(insertion)
    bySheet.set(insertion.sheet, list)
  }
  for (const [sheetName, sheetInsertions] of bySheet) {
    const sheet = sheetsByName.get(sheetName)
    let xml = readXml(files, sheet.path)
    for (const insertion of [...sheetInsertions].sort((left, right) => right.beforeRow - left.beforeRow)) {
      for (const otherSheet of sheets) {
        if (otherSheet.path === sheet.path) continue
        files[otherSheet.path] = strToU8(shiftWorksheetFormulaReferences(
          readXml(files, otherSheet.path),
          sheetName,
          insertion.beforeRow,
          insertion.rows.length,
        ))
      }
      files['xl/workbook.xml'] = strToU8(shiftDefinedNames(
        readXml(files, 'xl/workbook.xml'),
        sheetName,
        insertion.beforeRow,
        insertion.rows.length,
      ))
      xml = insertIntoWorksheet(xml, sheetName, insertion, xfCount)
      shiftDrawingAnchors(files, sheet, insertion.beforeRow, insertion.rows.length)
    }
    files[sheet.path] = strToU8(xml)
  }
}
