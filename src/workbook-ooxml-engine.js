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
  const files = openWorkbookPackage(source)
  const catalog = workbookSheets(files)
  const stylesPath = relationshipPartPath(
    catalog.relationships, 'xl/workbook.xml', '/styles',
  )
  const sharedStringsPath = relationshipPartPath(
    catalog.relationships, 'xl/workbook.xml', '/sharedStrings',
  ) ?? 'xl/sharedStrings.xml'
  const allPanelNames = new Set([...PANEL_VISIBLE_SHEETS, PANEL_PERMISSIONS_SHEET, PANEL_META_SHEET])
  const existingPanel = new Map(catalog.sheets.filter(({ name }) => allPanelNames.has(name))
    .map((sheet) => [sheet.name, sheet]))
  const legacySheets = catalog.sheets.filter(({ name }) => !allPanelNames.has(name))
  const xfCount = cellXfCount(files, stylesPath)
  applyWorkbookRowInsertions(files, legacySheets, options.rowInsertions, xfCount)
  const definitions = new Map()
  for (const definition of options.sheets) {
    const normalized = normalizeSheet(definition, xfCount)
    if (!PANEL_VISIBLE_SHEETS.includes(normalized.name)
      && normalized.name !== PANEL_PERMISSIONS_SHEET) fail('PANEL_SHEET_NAME_INVALID')
    if (definitions.has(normalized.name)) fail('PANEL_SHEET_DUPLICATE')
    definitions.set(normalized.name, normalized)
  }
  const visibleNames = [...PANEL_VISIBLE_SHEETS]
  if (options.includePermissions === true) visibleNames.push(PANEL_PERMISSIONS_SHEET)
  if (options.includePermissions !== true && definitions.has(PANEL_PERMISSIONS_SHEET)) {
    fail('PANEL_PERMISSIONS_FORBIDDEN')
  }
  const panelNames = [...visibleNames, PANEL_META_SHEET]
  const signedMetadata = await signPanelMetadata(options.metadata, callbacks.sign)
  const strings = sharedStringPool(files, sharedStringsPath)
  let nextRelationship = Math.max(
    0,
    ...catalog.relationships.map(({ id }) => relationshipIdNumber(id)),
  ) + 1
  let nextSheetId = Math.max(0, ...catalog.sheets.map(({ sheetId }) => sheetId)) + 1
  let nextPath = Math.max(0, ...Object.keys(files).map(sheetPathNumber)) + 1

  for (const sheet of existingPanel.values()) {
    delete files[sheet.path]
    delete files[sheet.path.replace('/worksheets/', '/worksheets/_rels/') + '.rels']
  }
  delete files['xl/calcChain.xml']

  let relationships = catalog.relationships.filter((relationship) => (
    !existingPanel.has(catalog.sheets.find(({ relationshipId }) => relationshipId === relationship.id)?.name)
  ))
  relationships = removePartRelationship(relationships, '/calcChain')
  const generated = []

  for (const name of panelNames) {
    const previous = existingPanel.get(name)
    const relationshipId = previous?.relationshipId ?? `rId${nextRelationship++}`
    const sheetId = previous?.sheetId ?? nextSheetId++
    const path = previous?.path ?? `xl/worksheets/sheet${nextPath++}.xml`
    const target = path.replace(/^xl\//, '')
    const definition = definitions.get(name) ?? { columns: [], name, rows: [] }
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
      `<sheet name="${xmlEscape(name)}"${name === PANEL_META_SHEET ? ' state="hidden"' : ''} sheetId="${sheetId}" r:id="${xmlEscape(relationshipId)}"/>`
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
  for (const { path } of existingPanel.values()) {
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
  const authorizedFieldSet = new Set([...sheetPolicies.values()]
    .flatMap(({ columns }) => columns.map(({ key }) => key)))
  const metadata = {
    format: 'Panel-v2',
    rows: input.metadata.rows.filter(({ id }) => allowedRowSet.has(id)).map((row) => {
      const fieldDigests = Object.fromEntries(Object.entries(row.fieldDigests)
        .filter(([key]) => authorizedFieldSet.has(key)))
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
  files['xl/workbook.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${generated.map(({ name, relationshipId, sheetId }) => `<sheet name="${xmlEscape(name)}"${name === PANEL_META_SHEET ? ' state="hidden"' : ''} sheetId="${sheetId}" r:id="${relationshipId}"/>`).join('')}</sheets><calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`)
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${generated.map(({ path, relationshipId }) => `<Relationship Id="${relationshipId}" Type="${WORKSHEET_TYPE}" Target="${path.replace(/^xl\//, '')}"/>`).join('')}<Relationship Id="${stylesRelationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="${stringsRelationshipId}" Type="${SHARED_STRINGS_TYPE}" Target="sharedStrings.xml"/></Relationships>`)
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${SHARED_STRINGS_CONTENT_TYPE}"/>${generated.map(({ path }) => `<Override PartName="/${path}" ContentType="${WORKSHEET_CONTENT_TYPE}"/>`).join('')}</Types>`)
  return closeWorkbookPackage(files)
}
