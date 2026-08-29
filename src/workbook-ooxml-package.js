import { strFromU8, unzipSync, zipSync } from 'fflate'

const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
const MAX_WORKBOOK_DECOMPRESSED_BYTES = 25 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 4096
const fail = (code) => { throw new TypeError(code) }

export const xmlEscape = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

export const xmlText = (value) => String(value ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&amp;', '&')
  .normalize('NFC')

export const xmlAttribute = (source, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`).exec(source)
  return match ? xmlText(match[1] ?? match[2]) : null
}

export const readXml = (files, path) => {
  const bytes = files[path]
  if (!(bytes instanceof Uint8Array)) fail('WORKBOOK_PART_MISSING')
  try { return strFromU8(bytes) } catch { fail('WORKBOOK_XML_INVALID') }
}

const workbookBytes = (source) => {
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  }
  fail('WORKBOOK_BYTES_INVALID')
}

const endOfCentralDirectory = (bytes) => {
  if (bytes.byteLength < 22) fail('WORKBOOK_ARCHIVE_INVALID')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minimum = Math.max(0, bytes.byteLength - 65_557)
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50
      && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) return offset
  }
  fail('WORKBOOK_ARCHIVE_INVALID')
}

const validArchivePath = (path) => {
  if (!path || path.length > 512 || path !== path.normalize('NFC') || path.startsWith('/')
    || path.includes('\\') || path.includes('\0') || /[\u0000-\u001f\u007f]/.test(path)
    || /%(?:2e|2f|5c)/i.test(path) || /[:?#]/.test(path)) return false
  const components = path.split('/')
  if (components.at(-1) === '') components.pop()
  return components.length > 0
    && components.every((component) => component && component !== '.' && component !== '..')
}

const archiveEntries = (bytes) => {
  if (bytes.byteLength > MAX_WORKBOOK_BYTES) fail('WORKBOOK_SIZE_INVALID')
  const end = endOfCentralDirectory(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0
    || view.getUint16(end + 8, true) !== view.getUint16(end + 10, true)) {
    fail('WORKBOOK_ARCHIVE_INVALID')
  }
  const count = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  let offset = view.getUint32(end + 16, true)
  const centralEnd = offset + centralSize
  if (!count || count === 0xffff || count > MAX_ARCHIVE_ENTRIES || centralEnd !== end) {
    fail('WORKBOOK_ARCHIVE_INVALID')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries = []
  const paths = new Set()
  const foldedPaths = new Set()
  let decompressedBytes = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > centralEnd || view.getUint32(offset, true) !== 0x02014b50) {
      fail('WORKBOOK_ARCHIVE_INVALID')
    }
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const nameStart = offset + 46
    const next = nameStart + nameLength + extraLength + commentLength
    if (next > centralEnd || !nameLength || (flags & 0x41) !== 0
      || (method !== 0 && method !== 8) || localOffset + 30 > offset
      || view.getUint32(localOffset, true) !== 0x04034b50) fail('WORKBOOK_ARCHIVE_INVALID')
    let path
    try { path = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)) } catch {
      fail('WORKBOOK_ARCHIVE_PATH_INVALID')
    }
    if (!validArchivePath(path)) fail('WORKBOOK_ARCHIVE_PATH_INVALID')
    const folded = path.toLocaleLowerCase('en-US')
    if (paths.has(path) || foldedPaths.has(folded)) fail('WORKBOOK_ARCHIVE_DUPLICATE_PATH')
    paths.add(path)
    foldedPaths.add(folded)

    const localFlags = view.getUint16(localOffset + 6, true)
    const localMethod = view.getUint16(localOffset + 8, true)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const localNameStart = localOffset + 30
    const dataStart = localNameStart + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    let localPath
    try { localPath = decoder.decode(bytes.subarray(localNameStart, localNameStart + localNameLength)) } catch {
      fail('WORKBOOK_ARCHIVE_PATH_INVALID')
    }
    if (localPath !== path || localFlags !== flags || localMethod !== method
      || dataStart > offset || dataEnd > offset) fail('WORKBOOK_ARCHIVE_INVALID')
    if ((flags & 0x08) === 0 && (view.getUint32(localOffset + 18, true) !== compressedSize
      || view.getUint32(localOffset + 22, true) !== uncompressedSize)) {
      fail('WORKBOOK_ARCHIVE_INVALID')
    }
    decompressedBytes += uncompressedSize
    if (!Number.isSafeInteger(decompressedBytes)
      || decompressedBytes > MAX_WORKBOOK_DECOMPRESSED_BYTES) {
      fail('WORKBOOK_DECOMPRESSED_SIZE_INVALID')
    }
    entries.push({ dataEnd, localOffset, path, uncompressedSize })
    offset = next
  }
  if (offset !== centralEnd) fail('WORKBOOK_ARCHIVE_INVALID')
  const localRanges = [...entries].sort((left, right) => left.localOffset - right.localOffset)
  for (let index = 1; index < localRanges.length; index++) {
    if (localRanges[index - 1].dataEnd > localRanges[index].localOffset) {
      fail('WORKBOOK_ARCHIVE_INVALID')
    }
  }
  return entries
}

const relationshipOwner = (path) => {
  if (path === '_rels/.rels') return '_package.xml'
  const match = /^(.*\/)_rels\/([^/]+)\.rels$/.exec(path)
  if (!match) fail('WORKBOOK_RELATIONSHIP_INVALID')
  return `${match[1]}${match[2]}`
}

const unsafeFormulaPipe = (formula) => {
  let quote = null
  let quotedIdentifierPipe = false
  for (let index = 0; index < formula.length; index++) {
    const character = formula[index]
    if (quote === '"') {
      if (character !== '"') continue
      if (formula[index + 1] === '"') index++
      else quote = null
      continue
    }
    if (quote === "'") {
      if (character === '|') quotedIdentifierPipe = true
      if (character !== "'") continue
      if (formula[index + 1] === "'") index++
      else {
        if (quotedIdentifierPipe && formula[index + 1] !== '!') return true
        quote = null
        quotedIdentifierPipe = false
      }
      continue
    }
    if (character === '"') quote = '"'
    else if (character === "'") quote = "'"
    else if (character === '|') return true
  }
  return quote !== null
}

const unsafeFormula = (formula) => /\b(?:CALL|DDE|EXEC|HYPERLINK|REGISTER|RTD|WEBSERVICE)\s*\(/i.test(formula)
  || /(?:https?|file|mailto):/i.test(formula)
  || /\[[^\]]+\][^!]{0,128}!/.test(formula)
  || unsafeFormulaPipe(formula)

export const safeWorkbookFormula = (formula) => {
  if (typeof formula !== 'string' || !formula || formula.length > 8192
    || unsafeFormula(formula)) fail('WORKBOOK_FORMULA_FORBIDDEN')
  return formula.normalize('NFC')
}

const validatePackageFiles = (files, entries) => {
  const names = Object.keys(files)
  if (names.length !== entries.length) fail('WORKBOOK_ARCHIVE_INVALID')
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]))
  let actualBytes = 0
  for (const [path, value] of Object.entries(files)) {
    const entry = entryByPath.get(path)
    if (!entry || !(value instanceof Uint8Array) || value.byteLength !== entry.uncompressedSize) {
      fail('WORKBOOK_ARCHIVE_INVALID')
    }
    actualBytes += value.byteLength
    if (/(?:^|\/)(?:vbaProject\.bin|macrosheets(?:\/|$)|activeX(?:\/|$)|embeddings(?:\/|$)|ctrlProps(?:\/|$)|customUI(?:\/|$)|externalLinks(?:\/|$)|connections\.xml$)/i.test(path)) {
      fail('WORKBOOK_MACRO_FORBIDDEN')
    }
    if (/\.(?:xml|rels)$/i.test(path)) {
      const xml = readXml(files, path)
      if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) fail('WORKBOOK_XML_INVALID')
    }
  }
  if (actualBytes > MAX_WORKBOOK_DECOMPRESSED_BYTES) {
    fail('WORKBOOK_DECOMPRESSED_SIZE_INVALID')
  }
  const contentTypes = readXml(files, '[Content_Types].xml')
  if (/(?:macroEnabled|vbaProject|activeX|oleObject|externalLink|connections)/i.test(contentTypes)) {
    fail('WORKBOOK_MACRO_FORBIDDEN')
  }
  for (const path of names.filter((name) => name.endsWith('.rels'))) {
    const owner = relationshipOwner(path)
    for (const relationship of relationshipEntries(readXml(files, path))) {
      const target = resolveRelationshipTarget(owner, relationship.target)
      if (!files[target]) fail('WORKBOOK_RELATIONSHIP_INVALID')
    }
  }
  for (const path of names.filter((name) => /^(?:xl\/worksheets\/|xl\/workbook\.xml$)/i.test(name)
    && name.endsWith('.xml'))) {
    const xml = readXml(files, path)
    for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?(?:f|definedName)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?(?:f|definedName)\s*>/g)) {
      safeWorkbookFormula(xmlText(match[1]))
    }
  }
}

export const openWorkbookPackage = (source) => {
  const bytes = workbookBytes(source)
  if (bytes.byteLength < 1) fail('WORKBOOK_SIZE_INVALID')
  const entries = archiveEntries(bytes)
  let files
  try { files = unzipSync(bytes) } catch { fail('WORKBOOK_ARCHIVE_INVALID') }
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
  ]) {
    if (!(files[required] instanceof Uint8Array)) fail('WORKBOOK_PART_MISSING')
  }
  validatePackageFiles(files, entries)
  return files
}

const CANONICAL_ZIP_MTIME = new Date(Date.UTC(1980, 0, 1))

export const closeWorkbookPackage = (files) => zipSync(Object.fromEntries(
  Object.entries(files).map(([name, bytes]) => [name, [bytes, {
    mtime: CANONICAL_ZIP_MTIME,
  }]]),
), { level: 6 })

export const relationshipEntries = (xml) => {
  const root = /<Relationships\b[^>]*>([\s\S]*?)<\/Relationships\s*>/.exec(xml)
  if (!root) fail('WORKBOOK_RELATIONSHIP_INVALID')
  const residue = xml.replace(/<\?xml\b[\s\S]*?\?>/g, '').replace(root[0], '').trim()
  const innerResidue = root[1].replace(/<Relationship\b[^>]*?\/>/g, '').trim()
  if (residue || innerResidue) fail('WORKBOOK_RELATIONSHIP_INVALID')
  const ids = new Set()
  return [...root[1].matchAll(/<Relationship\b([^>]*?)\/>/g)].map((match) => {
    const id = xmlAttribute(match[1], 'Id')
    const target = xmlAttribute(match[1], 'Target')
    const targetMode = xmlAttribute(match[1], 'TargetMode')
    const type = xmlAttribute(match[1], 'Type')
    if (!id || !target || !type || ids.has(id)) fail('WORKBOOK_RELATIONSHIP_INVALID')
    ids.add(id)
    if (targetMode && targetMode.toLowerCase() !== 'internal') {
      fail('WORKBOOK_EXTERNAL_RELATIONSHIP_FORBIDDEN')
    }
    if (/(?:externalLink|oleObject|attachedToolbars|vbaProject|activeX|hyperlink)$/i.test(type)
      || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
      fail('WORKBOOK_EXTERNAL_RELATIONSHIP_FORBIDDEN')
    }
    return { id, raw: match[0], target, targetMode, type }
  })
}

export const replaceRelationshipEntries = (xml, entries) => xml.replace(
  /(<Relationships\b[^>]*>)[\s\S]*?(<\/Relationships\s*>)/,
  `$1${entries.map(({ raw }) => raw).join('')}$2`,
)

export const resolveRelationshipTarget = (ownerPath, target) => {
  if (typeof target !== 'string' || !target || target.includes('\\') || target.includes('\0')) {
    fail('WORKBOOK_RELATIONSHIP_INVALID')
  }
  const components = target.startsWith('/')
    ? target.slice(1).split('/')
    : [...ownerPath.split('/').slice(0, -1), ...target.split('/')]
  const resolved = []
  for (const component of components) {
    if (!component || component === '.') continue
    if (component === '..') {
      if (!resolved.length) fail('WORKBOOK_RELATIONSHIP_INVALID')
      resolved.pop()
    } else {
      resolved.push(component)
    }
  }
  if (!resolved.length) fail('WORKBOOK_RELATIONSHIP_INVALID')
  return resolved.join('/')
}

export const relationshipPartPath = (relationships, ownerPath, typeSuffix) => {
  const matches = relationships.filter(({ type }) => type?.endsWith(typeSuffix))
  if (matches.length > 1) fail('WORKBOOK_RELATIONSHIP_INVALID')
  return matches.length
    ? resolveRelationshipTarget(ownerPath, matches[0].target)
    : null
}

export const workbookSheets = (files) => {
  const workbook = readXml(files, 'xl/workbook.xml')
  const relationships = relationshipEntries(readXml(files, 'xl/_rels/workbook.xml.rels'))
  const byId = new Map(relationships.map((relationship) => [relationship.id, relationship]))
  const root = /<sheets\b[^>]*>([\s\S]*?)<\/sheets\s*>/.exec(workbook)
  if (!root) fail('WORKBOOK_SHEETS_MISSING')
  const sheets = [...root[1].matchAll(/<sheet\b([^>]*?)\/>/g)].map((match) => {
    const name = xmlAttribute(match[1], 'name')
    const relationshipId = xmlAttribute(match[1], 'r:id')
    const sheetId = Number(xmlAttribute(match[1], 'sheetId'))
    const relationship = byId.get(relationshipId)
    if (!name || !relationship || !Number.isSafeInteger(sheetId) || sheetId < 1
      || !relationship.type?.endsWith('/worksheet')) fail('WORKBOOK_SHEETS_INVALID')
    return {
      name,
      path: resolveRelationshipTarget('xl/workbook.xml', relationship.target),
      raw: match[0],
      relationship,
      relationshipId,
      sheetId,
      state: xmlAttribute(match[1], 'state'),
    }
  })
  if (!sheets.length) fail('WORKBOOK_SHEETS_MISSING')
  return { relationships, sheets, workbook }
}

export const replaceWorkbookSheets = (xml, rawSheets) => xml.replace(
  /(<sheets\b[^>]*>)[\s\S]*?(<\/sheets\s*>)/,
  `$1${rawSheets.join('')}$2`,
)

export const forceWorkbookRecalculation = (xml) => {
  const calc = '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>'
  if (/<calcPr\b[^>]*(?:\/>|>[\s\S]*?<\/calcPr\s*>)/.test(xml)) {
    return xml.replace(/<calcPr\b[^>]*(?:\/>|>[\s\S]*?<\/calcPr\s*>)/, calc)
  }
  return xml.replace(/<\/workbook\s*>/, `${calc}</workbook>`)
}

export const withoutContentTypePart = (xml, partName) => xml.replace(
  new RegExp(`<Override\\b(?=[^>]*\\bPartName=(?:"${partName}"|'${partName}'))[^>]*/>`, 'g'),
  '',
)

export const ensureContentTypePart = (xml, partName, contentType) => {
  if ([...xml.matchAll(/<Override\b([^>]*?)\/>/g)]
    .some((match) => xmlAttribute(match[1], 'PartName') === partName)) return xml
  return xml.replace(/<\/Types\s*>/, `<Override PartName="${xmlEscape(partName)}" ContentType="${xmlEscape(contentType)}"/></Types>`)
}

export const columnName = (index) => {
  let value = index + 1
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}
