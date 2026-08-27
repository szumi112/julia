import { strFromU8, unzipSync } from 'fflate'

const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
const MAX_WORKBOOK_DECOMPRESSED_BYTES = 25 * 1024 * 1024
const FINGERPRINT = /^[0-9a-f]{64}$/
const MONTH_KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/
export const WORKBOOK_PARSER_VERSION = 2
export const WORKBOOK_MATERIALIZER_VERSION = 2
const POLISH_MONTHS = Object.freeze({
  styczen: 1,
  luty: 2,
  marzec: 3,
  kwiecien: 4,
  maj: 5,
  czerwiec: 6,
  lipiec: 7,
  sierpien: 8,
  wrzesien: 9,
  pazdziernik: 10,
  listopad: 11,
  grudzien: 12,
})

const fail = (code) => { throw new TypeError(code) }

const text = (value) => value === null || value === undefined
  ? ''
  : String(value).trim().normalize('NFC')

const rawScalar = (value) => typeof value === 'string' ? text(value) : value

const formulaValue = (value) => value && typeof value === 'object'
  && !Array.isArray(value) && typeof value.formula === 'string'

const FORMULA_ELEMENT = /<(?:[A-Za-z_][\w.-]*:)?f\b/
const FORMULA_CONTENT = /<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f\s*>/

const scalar = (value) => formulaValue(value) ? '' : value

const searchText = (value) => text(value).normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replaceAll('ł', 'l')
  .toLowerCase()

const xmlText = (value) => String(value ?? '')
  .replace(/<[^>]*>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&amp;', '&')
  .normalize('NFC')

const attribute = (source, name) => {
  const match = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`).exec(source)
  return match ? xmlText(match[1]) : null
}

const columnIndex = (reference) => {
  const letters = /^[A-Z]+/.exec(reference)?.[0]
  if (!letters) fail('WORKBOOK_CELL_INVALID')
  let value = 0
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64
  return value - 1
}

const sha256 = async (bytes) => {
  if (!globalThis.crypto?.subtle) fail('WORKBOOK_CRYPTO_UNAVAILABLE')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

const excelDate = (value) => {
  const serial = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null
  const date = new Date(Date.UTC(1899, 11, 30) + Math.trunc(serial) * 86_400_000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

const civilDate = (value) => {
  const source = text(value)
  if (source === '') return null
  if (/^\d+(?:\.0+)?$/.test(source)) return excelDate(Number(source))
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source)
  const polish = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(source)
  const candidate = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : polish
      ? `${polish[3]}-${polish[2].padStart(2, '0')}-${polish[1].padStart(2, '0')}`
      : null
  if (!candidate) return null
  const date = new Date(`${candidate}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate
    ? candidate
    : null
}

const amountGrosze = (value, { allowZero = false } = {}) => {
  const source = text(value).replace(/\s*(?:zł|pln)$/iu, '').replaceAll(' ', '')
  const additive = /^(\d+(?:[.,]\d+)?(?:\+\d+(?:[.,]\d+)?)*)[^\d+]*$/u.exec(source)
  const additiveExpression = additive?.[1]?.includes('+') ? additive[1] : null
  const normalized = typeof value === 'number'
    ? value
    : additiveExpression
      ? additiveExpression.split('+')
        .reduce((sum, part) => sum + Number(part.replace(',', '.')), 0)
      : Number(source.replace(',', '.'))
  if (!Number.isFinite(normalized) || normalized < 0 || (!allowZero && normalized === 0)) return null
  const grosze = Math.round(normalized * 100)
  return Number.isSafeInteger(grosze) ? grosze : null
}

const integer = (value, { allowZero = false } = {}) => {
  const parsed = typeof value === 'number' ? value : Number(text(value).replace(',', '.'))
  return Number.isSafeInteger(parsed) && (parsed > 0 || (allowZero && parsed === 0)) ? parsed : null
}

const paymentMethod = (value) => {
  const normalized = searchText(value)
  if (!normalized) return 'unknown'
  if (normalized.includes('terminal') || normalized.includes('karta')) return 'card'
  if (normalized.includes('gotow')) return 'cash'
  if (normalized.includes('przelew')) return 'transfer'
  if (normalized.includes('miesiecz')) return 'monthly'
  if (normalized.includes('blik')) return 'blik'
  return 'other'
}

const settlementStatus = (value) => {
  const normalized = searchText(value)
  if (!normalized) return 'unknown'
  if (normalized.includes('czesci')) return 'partial'
  if (normalized.includes('nieoplac') || normalized.includes('niezaplac')) return 'unpaid'
  if (normalized.includes('oplac') || normalized.includes('zaplac')) return 'paid'
  return 'unknown'
}

const invoiceStatus = (value) => {
  const normalized = searchText(value)
  if (!normalized) return 'unknown'
  if (normalized.includes('nie wymaga')) return 'not_required'
  if (normalized.includes('wystawiona') || normalized.includes('wystawione')
    || normalized.includes('wyslana')) return 'issued'
  if (normalized.includes('wystawic') || normalized.includes('do wystawienia')) {
    return 'action_required'
  }
  if (normalized.includes('brak')) return 'not_issued'
  return 'unknown'
}

const monthKey = (year, month) => Number.isSafeInteger(year) && year >= 2000 && year <= 2100
  && Number.isSafeInteger(month) && month >= 1 && month <= 12
  ? `${year}-${String(month).padStart(2, '0')}`
  : null

const monthFromValue = (value, fallbackYear = null, { allowSerial = false } = {}) => {
  if (allowSerial && (typeof value === 'number' || /^\d+(?:\.0+)?$/.test(text(value)))) {
    const date = excelDate(value)
    return date?.slice(0, 7) ?? null
  }
  const normalized = searchText(value)
  const explicit = /(20\d{2})[-/.](0?[1-9]|1[0-2])/.exec(normalized)
  if (explicit) return monthKey(Number(explicit[1]), Number(explicit[2]))
  const year = Number(/\b(20\d{2})\b/.exec(normalized)?.[1] ?? fallbackYear)
  const monthName = Object.keys(POLISH_MONTHS).find((name) => normalized.includes(name))
  return monthName ? monthKey(year, POLISH_MONTHS[monthName]) : null
}

const inferredSheetMonth = (sheet, datedMonths) => {
  const years = [...new Set(datedMonths.map((value) => Number(value.slice(0, 4))))]
  const fallbackYear = years.length === 1 ? years[0] : null
  const firstCell = sheet.rows.flat().find((value) => monthFromValue(value, fallbackYear))
  if (searchText(sheet.name).includes('sierpienwrzesien')) return monthKey(fallbackYear, 9)
  return monthFromValue(firstCell, fallbackYear)
    ?? monthFromValue(sheet.name, fallbackYear)
    ?? (datedMonths.length === 1 ? datedMonths[0] : null)
}

const columnName = (index) => {
  let value = index + 1
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

const formulaCellSet = (sheet) => new Set(Array.isArray(sheet.formulaCells)
  ? sheet.formulaCells
  : [])

const hasFormula = (sheet, formulas, rowIndex, column) => formulaValue(
  sheet.rows[rowIndex]?.[column],
) || formulas.has(`${columnName(column)}${rowIndex + 1}`)

const cellType = (sheet, rowIndex, column) => sheet.cellTypes?.[
  `${columnName(column)}${rowIndex + 1}`
] ?? null

const headerMap = (row) => new Map(row.map((value, index) => [searchText(value), index]))

const transactionHeaderIndex = (rows) => rows.findIndex((row) => {
  const headers = new Set(row.map(searchText))
  return headers.has('usluga') && headers.has('cena') && headers.has('klient')
})

const valueAt = (row, headers, name) => {
  const index = headers.get(name)
  return index === undefined ? '' : row[index]
}

const rawRecord = (headers, row) => {
  const result = {}
  headers.forEach((header, index) => {
    const key = text(header)
    if (key && !formulaValue(row[index])) result[key] = rawScalar(scalar(row[index] ?? ''))
  })
  return result
}

const makeSourceKey = ({ sheetIndex, rowNumber, block = 0 }) => (
  `workbook:v1:${sheetIndex}:${rowNumber}:${block}`
)

const sourcePeriod = ({ occurredOn = null, month = null }) => occurredOn
  ? { periodPrecision: 'day', periodMonth: occurredOn.slice(0, 7) }
  : month && MONTH_KEY.test(month)
    ? { periodPrecision: 'month', periodMonth: month }
    : { periodPrecision: 'unknown', periodMonth: null }

const baseRow = ({ sourceKey, sheet, rowNumber, recordType, accountingMonth,
  occurredOn = null, amount, counterparty, sourceLabel, method = 'unknown',
  settlement = 'unknown', invoice = 'unknown', invoiceNote = '', specialistName = '',
  lessonCount = null, warningCodes = [], sourcePeriodMonth = null, raw }) => ({
  sourceKey,
  sheet: text(sheet),
  rowNumber,
  recordType,
  accountingMonth: accountingMonth && MONTH_KEY.test(accountingMonth) ? accountingMonth : null,
  occurredOn,
  ...sourcePeriod({ occurredOn, month: sourcePeriodMonth }),
  amountGrosze: amount,
  counterparty: text(counterparty),
  sourceLabel: text(sourceLabel),
  paymentMethod: method,
  settlementStatus: settlement,
  invoiceStatus: invoice,
  invoiceNote: text(invoiceNote),
  specialistName: text(specialistName) || null,
  lessonCount,
  raw,
  ...(warningCodes.length ? { warningCodes: Object.freeze([...warningCodes]) } : {}),
})

const quarantineRow = ({ sourceKey, sheet, rowNumber, recordType, accountingMonth,
  occurredOn = null, sourcePeriodMonth = null, reasonCode, reasonCodes = [reasonCode], raw }) => ({
  sourceKey,
  sheet: text(sheet),
  rowNumber,
  recordType,
  accountingMonth: accountingMonth && MONTH_KEY.test(accountingMonth) ? accountingMonth : null,
  occurredOn,
  ...sourcePeriod({ occurredOn, month: sourcePeriodMonth }),
  reasonCode,
  reasonCodes: Object.freeze([...reasonCodes]),
  raw,
})

const normalizedResult = (rows = [], quarantinedRows = [], sourceCandidates = 0,
  excludedFormulaBlocks = 0, excludedFormulaRows = 0) => ({
  rows,
  quarantinedRows,
  sourceCandidates,
  excludedFormulaBlocks,
  excludedFormulaRows,
})

const normalizeTransactions = (sheet, context) => {
  const headerIndex = transactionHeaderIndex(sheet.rows)
  if (headerIndex < 0) return normalizedResult()
  const headersRow = sheet.rows[headerIndex]
  const headers = headerMap(headersRow)
  const formulas = formulaCellSet(sheet)
  const candidates = []
  let excludedFormulaBlocks = 0
  let excludedFormulaRows = 0
  sheet.rows.slice(headerIndex + 1).forEach((row, index) => {
    const rowIndex = headerIndex + index + 1
    const service = text(scalar(valueAt(row, headers, 'usluga')))
    const client = text(scalar(valueAt(row, headers, 'klient')))
    const amountValue = scalar(valueAt(row, headers, 'cena'))
    const dateValue = scalar(valueAt(row, headers, 'data zakupu'))
    const accountingMonthValue = valueAt(row, headers, 'miesiac ksiegowy')
    const candidateColumns = ['usluga', 'cena', 'klient', 'data zakupu']
      .map((name) => headers.get(name))
      .filter((column) => column !== undefined)
    if (candidateColumns.some((column) => hasFormula(sheet, formulas, rowIndex, column))) {
      excludedFormulaBlocks++
      const amountColumn = headers.get('cena')
      if (service && amountColumn !== undefined
        && hasFormula(sheet, formulas, rowIndex, amountColumn)) excludedFormulaRows++
      return
    }
    if (searchText(service) === 'usluga' && searchText(client) === 'klient') return
    const populatedCoreCells = [service, client, text(amountValue), text(dateValue)]
      .filter(Boolean).length
    if (populatedCoreCells < 2 || (!client && !text(dateValue))) return
    candidates.push({
      row,
      rowNumber: headerIndex + index + 2,
      amountValue,
      accountingMonthValue,
      dateValue,
      dateCellType: headers.has('data zakupu')
        ? cellType(sheet, rowIndex, headers.get('data zakupu'))
        : null,
      occurredOn: civilDate(dateValue),
      amount: amountGrosze(amountValue),
    })
  })
  const datedMonths = candidates.map(({ occurredOn }) => occurredOn?.slice(0, 7)).filter(Boolean)
  const sheetMonth = inferredSheetMonth(sheet, datedMonths)
  const accountingMonthColumn = headers.get('miesiac ksiegowy')
  const sourcePeriodSheet = accountingMonthColumn === undefined
    ? sheet
    : {
        ...sheet,
        rows: sheet.rows.map((row) => row.map((value, column) => (
          column === accountingMonthColumn ? '' : value
        ))),
      }
  const sourceSheetMonth = inferredSheetMonth(sourcePeriodSheet, datedMonths)
  const tusSheet = searchText(sheet.name).includes('grupa tus')
  const rows = []
  const quarantinedRows = []
  candidates.forEach(({ row, rowNumber, amountValue, accountingMonthValue, dateValue,
    dateCellType, occurredOn, amount }) => {
    const label = valueAt(row, headers, 'usluga')
    const isTus = tusSheet || searchText(label).startsWith('grupa tus')
    const explicitMonth = text(scalar(accountingMonthValue))
    const explicitMonthPresent = formulaValue(accountingMonthValue) || explicitMonth !== ''
    const accountingMonth = explicitMonthPresent
      ? MONTH_KEY.test(explicitMonth) ? explicitMonth : null
      : occurredOn?.slice(0, 7) ?? sheetMonth
    const sourcePeriodMonth = isTus && occurredOn === null ? sourceSheetMonth : null
    const sourceKey = makeSourceKey({ ...context, sheet: sheet.name, rowNumber })
    const reasonCodes = []
    if (explicitMonthPresent && !MONTH_KEY.test(explicitMonth)) {
      reasonCodes.push('ACCOUNTING_MONTH_INVALID')
    }
    if (!text(label)) reasonCodes.push('SERVICE_MISSING')
    if (!text(valueAt(row, headers, 'klient'))) reasonCodes.push('COUNTERPARTY_MISSING')
    if (text(amountValue) === '') reasonCodes.push('AMOUNT_MISSING')
    else if (amount === null) reasonCodes.push('AMOUNT_INVALID')
    if (!isTus && text(dateValue) === '') reasonCodes.push('SERVICE_DATE_MISSING')
    else if (!isTus && (occurredOn === null
      || (dateCellType !== null && !['n', 'd'].includes(dateCellType)))) {
      reasonCodes.push('SERVICE_DATE_INVALID')
    }
    if (reasonCodes.length) {
      quarantinedRows.push(quarantineRow({
        sourceKey,
        sheet: sheet.name,
        rowNumber,
        recordType: isTus ? 'tus' : 'income',
        accountingMonth,
        occurredOn,
        sourcePeriodMonth,
        reasonCode: reasonCodes[0],
        reasonCodes,
        raw: rawRecord(headersRow, row),
      }))
      return
    }
    rows.push(baseRow({
      sourceKey,
      sheet: sheet.name,
      rowNumber,
      recordType: isTus ? 'tus' : 'income',
      accountingMonth,
      occurredOn,
      sourcePeriodMonth,
      amount,
      counterparty: valueAt(row, headers, 'klient'),
      sourceLabel: label,
      method: paymentMethod(scalar(valueAt(row, headers, 'sposob platnosci'))),
      settlement: settlementStatus(scalar(valueAt(row, headers, 'status'))),
      invoice: invoiceStatus(scalar(valueAt(row, headers, 'faktura'))),
      invoiceNote: scalar(valueAt(row, headers, 'faktura')),
      specialistName: scalar(valueAt(row, headers, 'psycholog')),
      warningCodes: typeof amountValue === 'string' ? ['AMOUNT_STORED_AS_TEXT'] : [],
      raw: rawRecord(headersRow, row),
    }))
  })
  return normalizedResult(
    rows,
    quarantinedRows,
    candidates.length,
    excludedFormulaBlocks,
    excludedFormulaRows,
  )
}

const normalizeEnglish = (sheet, context) => {
  if (!searchText(sheet.name).includes('angielski') || sheet.rows.length < 3) {
    return normalizedResult()
  }
  const monthRow = sheet.rows[0]
  const headerRow = sheet.rows[1]
  const rows = []
  const quarantinedRows = []
  const formulas = formulaCellSet(sheet)
  let sourceCandidates = 0
  let excludedFormulaBlocks = 0
  headerRow.forEach((value, column) => {
    if (searchText(value) !== 'imie i nazwisko') return
    const accountingMonth = monthFromValue(monthRow[column], null, { allowSerial: true })
    for (let index = 2; index < sheet.rows.length; index++) {
      const block = sheet.rows[index].slice(column, column + 3)
      if ([column, column + 1, column + 2].some((cellColumn) => (
        hasFormula(sheet, formulas, index, cellColumn)
      ))) {
        excludedFormulaBlocks++
        continue
      }
      if (block.every((item) => text(scalar(item)) === '')) continue
      const counterparty = text(scalar(sheet.rows[index][column]))
      const lessons = integer(scalar(sheet.rows[index][column + 1]), { allowZero: true })
      const amount = amountGrosze(scalar(sheet.rows[index][column + 2]), { allowZero: true })
      sourceCandidates++
      if (!counterparty || lessons === null || amount === null) {
        const reasonCode = !counterparty
          ? 'COUNTERPARTY_MISSING'
          : lessons === null ? 'LESSON_COUNT_INVALID' : 'AMOUNT_INVALID'
        quarantinedRows.push(quarantineRow({
          sourceKey: makeSourceKey({ ...context, sheet: sheet.name, rowNumber: index + 1, block: column + 1 }),
          sheet: sheet.name,
          rowNumber: index + 1,
          recordType: 'english',
          accountingMonth,
          sourcePeriodMonth: accountingMonth,
          reasonCode,
          raw: {
            'Imię i nazwisko': counterparty,
            'Ilość lekcji': rawScalar(scalar(sheet.rows[index][column + 1])),
            Kwota: rawScalar(scalar(sheet.rows[index][column + 2])),
          },
        }))
        continue
      }
      rows.push(baseRow({
        sourceKey: makeSourceKey({ ...context, sheet: sheet.name, rowNumber: index + 1, block: column + 1 }),
        sheet: sheet.name,
        rowNumber: index + 1,
        recordType: 'english',
        accountingMonth,
        sourcePeriodMonth: accountingMonth,
        amount,
        counterparty,
        sourceLabel: 'Lekcje języka angielskiego',
        lessonCount: lessons,
        raw: {
          'Imię i nazwisko': counterparty,
          'Ilość lekcji': lessons,
          Kwota: rawScalar(sheet.rows[index][column + 2]),
        },
      }))
    }
  })
  return normalizedResult(rows, quarantinedRows, sourceCandidates, excludedFormulaBlocks)
}

const normalizeFixedCosts = (sheet, context) => {
  if (!searchText(sheet.name).includes('stale koszty') || sheet.rows.length < 2) {
    return normalizedResult()
  }
  const headers = sheet.rows[0]
  const rows = []
  const quarantinedRows = []
  const formulas = formulaCellSet(sheet)
  let sourceCandidates = 0
  let excludedFormulaBlocks = 0
  headers.forEach((value, column) => {
    const normalized = searchText(value)
    if (normalized !== 'koszt' && normalized !== 'przychod') return
    for (let index = 1; index < sheet.rows.length; index++) {
      const labelValue = scalar(sheet.rows[index][column])
      const amountValue = scalar(sheet.rows[index][column + 1])
      if ([column, column + 1].some((cellColumn) => (
        hasFormula(sheet, formulas, index, cellColumn)
      ))) {
        excludedFormulaBlocks++
        continue
      }
      if (!text(amountValue)) continue
      const label = text(labelValue)
      const amount = amountGrosze(amountValue)
      sourceCandidates++
      const nearby = sheet.rows[index].slice(Math.max(0, column - 1), column + 4)
      const accountingMonth = nearby.map((item) => monthFromValue(scalar(item))).find(Boolean)
        ?? monthFromValue(sheet.name)
      const reasonCodes = []
      if (!label) reasonCodes.push('ORPHAN_AMOUNT')
      if (amount === null) reasonCodes.push('AMOUNT_INVALID')
      const sourceKey = makeSourceKey({
        ...context,
        sheet: sheet.name,
        rowNumber: index + 1,
        block: column + 1,
      })
      const raw = {
        [text(value)]: label,
        [text(headers[column + 1]) || 'Kwota']: rawScalar(sheet.rows[index][column + 1]),
      }
      if (reasonCodes.length) {
        quarantinedRows.push(quarantineRow({
          sourceKey,
          sheet: sheet.name,
          rowNumber: index + 1,
          recordType: normalized === 'koszt' ? 'expense' : 'income',
          accountingMonth,
          sourcePeriodMonth: accountingMonth,
          reasonCode: reasonCodes[0],
          reasonCodes,
          raw,
        }))
        continue
      }
      rows.push(baseRow({
        sourceKey,
        sheet: sheet.name,
        rowNumber: index + 1,
        recordType: normalized === 'koszt' ? 'expense' : 'income',
        accountingMonth,
        sourcePeriodMonth: accountingMonth,
        amount,
        counterparty: '',
        sourceLabel: label,
        raw,
      }))
    }
  })
  return normalizedResult(rows, quarantinedRows, sourceCandidates, excludedFormulaBlocks)
}

const warningsFor = (rows) => {
  const warnings = []
  const unknownMonths = rows.filter((row) => row.accountingMonth === null).length
  const unknownMethods = rows.filter((row) => row.paymentMethod === 'unknown').length
  if (unknownMonths) warnings.push({ code: 'ACCOUNTING_MONTH_UNKNOWN', count: unknownMonths })
  if (unknownMethods) warnings.push({ code: 'PAYMENT_METHOD_UNKNOWN', count: unknownMethods })
  const textAmounts = rows.filter(({ warningCodes }) => (
    warningCodes?.includes('AMOUNT_STORED_AS_TEXT')
  )).length
  if (textAmounts) warnings.push({ code: 'AMOUNT_STORED_AS_TEXT', count: textAmounts })
  return warnings
}

export function normalizeWorkbookRows({ filename, fingerprint, sheets }) {
  if (typeof filename !== 'string' || filename.trim() !== filename || !filename
    || typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)
    || !Array.isArray(sheets) || sheets.length === 0) fail('WORKBOOK_INPUT_INVALID')
  const context = { filename, fingerprint }
  const rows = []
  const quarantinedRows = []
  let sourceCandidates = 0
  let excludedFormulaBlocks = 0
  let excludedFormulaRows = 0
  for (const [sheetIndex, sheet] of sheets.entries()) {
    if (!sheet || typeof sheet.name !== 'string' || !Array.isArray(sheet.rows)) {
      fail('WORKBOOK_SHEET_INVALID')
    }
    const sheetContext = { ...context, sheetIndex }
    const english = normalizeEnglish(sheet, sheetContext)
    const fixed = normalizeFixedCosts(sheet, sheetContext)
    const normalized = english.sourceCandidates || english.excludedFormulaBlocks
      ? english
      : fixed.sourceCandidates || fixed.excludedFormulaBlocks
        ? fixed
        : normalizeTransactions(sheet, sheetContext)
    rows.push(...normalized.rows)
    quarantinedRows.push(...normalized.quarantinedRows)
    sourceCandidates += normalized.sourceCandidates
    excludedFormulaBlocks += normalized.excludedFormulaBlocks
    excludedFormulaRows += normalized.excludedFormulaRows
  }
  const sourceKeys = new Set()
  for (const row of [...rows, ...quarantinedRows]) {
    if (sourceKeys.has(row.sourceKey)) fail('WORKBOOK_DUPLICATE_ROW')
    sourceKeys.add(row.sourceKey)
  }
  const finance = rows.filter((row) => !['english', 'expense'].includes(row.recordType)
    && row.sheet !== 'Stałe koszty')
  const counts = {
    financeRows: finance.length,
    datedFinanceRows: finance.filter((row) => row.occurredOn !== null).length,
    undatedFinanceRows: finance.filter((row) => row.occurredOn === null).length,
    tusRows: finance.filter((row) => row.recordType === 'tus').length,
    englishRows: rows.filter((row) => row.recordType === 'english').length,
    costOrAncillaryRows: rows.filter((row) => searchText(row.sheet).includes('stale koszty')).length,
  }
  return Object.freeze({
    formatVersion: 1,
    parserVersion: WORKBOOK_PARSER_VERSION,
    materializerVersion: WORKBOOK_MATERIALIZER_VERSION,
    fingerprint,
    filename,
    counts: Object.freeze(counts),
    warnings: Object.freeze(warningsFor(rows)),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    quarantinedRows: Object.freeze(quarantinedRows.map((row) => Object.freeze(row))),
    reconciliation: Object.freeze({
      sourceCandidates,
      acceptedRows: rows.length,
      quarantinedRows: quarantinedRows.length,
      excludedFormulaBlocks,
      excludedFormulaRows,
    }),
  })
}

const parseSharedStrings = (xml) => {
  const values = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    values.push([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((part) => xmlText(part[1])).join(''))
  }
  return values
}

const parseWorksheet = (xml, sharedStrings) => {
  const rows = []
  const formulaCells = []
  const cellTypes = {}
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attribute(rowMatch[1], 'r'))
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) fail('WORKBOOK_ROW_INVALID')
    const row = []
    const cells = rowMatch[2]
    for (const cellMatch of cells.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attribute(cellMatch[1], 'r')
      const type = attribute(cellMatch[1], 't')
      const body = cellMatch[2] ?? ''
      if (FORMULA_ELEMENT.test(body)) formulaCells.push(ref)
      cellTypes[ref] = type ?? 'n'
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
      let value = ''
      if (type === 's' && /^\d+$/.test(raw)) value = sharedStrings[Number(raw)] ?? ''
      else if (type === 'inlineStr') value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((part) => xmlText(part[1])).join('')
      else if (type === 'str') value = xmlText(raw)
      else if (raw !== '' && Number.isFinite(Number(raw))) value = Number(raw)
      else value = xmlText(raw)
      const formulaElement = FORMULA_ELEMENT.test(body)
      const formula = FORMULA_CONTENT.exec(body)?.[1] ?? ''
      row[columnIndex(ref)] = !formulaElement
        ? value
        : { formula: xmlText(formula), cached: value }
    }
    while (rows.length < rowNumber - 1) rows.push([])
    rows.push(row)
  }
  return { rows, formulaCells, cellTypes }
}

const zipEntryPaths = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.byteLength - 22
  const minimum = Math.max(0, bytes.byteLength - 65_557)
  while (end >= minimum && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < minimum || view.getUint16(end + 4, true) !== 0
    || view.getUint16(end + 6, true) !== 0) fail('WORKBOOK_ARCHIVE_INVALID')
  const entries = view.getUint16(end + 10, true)
  const centralSize = view.getUint32(end + 12, true)
  let offset = view.getUint32(end + 16, true)
  const centralEnd = offset + centralSize
  if (entries === 0xffff || centralEnd > end || offset < 0) fail('WORKBOOK_ARCHIVE_INVALID')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const paths = []
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > centralEnd || view.getUint32(offset, true) !== 0x02014b50) {
      fail('WORKBOOK_ARCHIVE_INVALID')
    }
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nameStart = offset + 46
    const next = nameStart + nameLength + extraLength + commentLength
    if (next > centralEnd) fail('WORKBOOK_ARCHIVE_INVALID')
    let path
    try { path = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)) } catch {
      fail('WORKBOOK_ARCHIVE_PATH_INVALID')
    }
    paths.push({ path, uncompressedSize: view.getUint32(offset + 24, true) })
    offset = next
  }
  if (offset !== centralEnd) fail('WORKBOOK_ARCHIVE_INVALID')
  return paths
}

const validateRelationshipXml = (xml) => {
  const root = /<Relationships\b[^>]*>([\s\S]*?)<\/Relationships>/.exec(xml)
  if (!root) fail('WORKBOOK_RELATIONSHIP_INVALID')
  const declarationsRemoved = xml
    .replace(/<\?xml\b[\s\S]*?\?>/g, '')
    .replace(root[0], '')
    .trim()
  if (declarationsRemoved) fail('WORKBOOK_RELATIONSHIP_INVALID')
  const relationships = [...root[1].matchAll(/<Relationship\b([^>]*?)\/>/g)]
  const residue = root[1].replace(/<Relationship\b[^>]*?\/>/g, '').trim()
  if (residue) fail('WORKBOOK_RELATIONSHIP_INVALID')
  const ids = new Set()
  for (const match of relationships) {
    const id = attribute(match[1], 'Id')
    const type = attribute(match[1], 'Type')
    const target = attribute(match[1], 'Target')
    if (!id || !type || !target || ids.has(id)) fail('WORKBOOK_RELATIONSHIP_INVALID')
    ids.add(id)
    if (searchText(attribute(match[1], 'TargetMode')) === 'external'
      || /(?:external|oleobject|attachedtoolbars)/i.test(type)) {
      fail('WORKBOOK_EXTERNAL_RELATIONSHIP_FORBIDDEN')
    }
  }
}

const validateArchiveEntries = (bytes) => {
  const entries = zipEntryPaths(bytes)
  const seen = new Set()
  let decompressedBytes = 0
  for (const { path, uncompressedSize } of entries) {
    if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || path.split('/').some((component) => component === '..' || component === '.')) {
      fail('WORKBOOK_ARCHIVE_PATH_INVALID')
    }
    if (seen.has(path)) fail('WORKBOOK_ARCHIVE_DUPLICATE_PATH')
    seen.add(path)
    decompressedBytes += uncompressedSize
    if (decompressedBytes > MAX_WORKBOOK_DECOMPRESSED_BYTES) {
      fail('WORKBOOK_DECOMPRESSED_SIZE_INVALID')
    }
    if (/(?:^|\/)(?:vbaProject\.bin|macrosheets\/|activeX\/|embeddings\/)/i.test(path)) {
      fail('WORKBOOK_MACRO_FORBIDDEN')
    }
  }
  return decompressedBytes
}

const validateArchiveFiles = (files, decompressedBytes) => {
  if (Object.values(files).reduce((total, value) => total + value.byteLength, 0)
    !== decompressedBytes) fail('WORKBOOK_ARCHIVE_INVALID')
  for (const [path, value] of Object.entries(files)) {
    if (path.endsWith('.rels')) validateRelationshipXml(strFromU8(value))
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(path)) {
      const xml = strFromU8(value)
      for (const formula of xml.matchAll(new RegExp(FORMULA_CONTENT.source, 'g'))) {
        if (/\bDDE\s*\(/i.test(xmlText(formula[1]))) fail('WORKBOOK_FORMULA_FORBIDDEN')
      }
    }
  }
}

const workbookSheetsFrom = (files) => {
  const read = (path, required = true) => {
    const bytes = files[path]
    if (!bytes) {
      if (required) fail('WORKBOOK_ARCHIVE_INVALID')
      return ''
    }
    return strFromU8(bytes)
  }
  const workbook = read('xl/workbook.xml')
  const relationships = read('xl/_rels/workbook.xml.rels')
  const sharedStrings = parseSharedStrings(read('xl/sharedStrings.xml', false))
  const targets = new Map()
  for (const match of relationships.matchAll(/<Relationship\b([^>]*?)\/>/g)) {
    const id = attribute(match[1], 'Id')
    const target = attribute(match[1], 'Target')
    if (id && target) targets.set(id, target)
  }
  const sheets = []
  for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/>/g)) {
    const name = attribute(match[1], 'name')
    const id = attribute(match[1], 'r:id')
    const target = targets.get(id)
    if (!name || !target || target.includes('..')) fail('WORKBOOK_RELATIONSHIP_INVALID')
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`
    sheets.push({ name, ...parseWorksheet(read(path), sharedStrings) })
  }
  if (!sheets.length) fail('WORKBOOK_SHEETS_MISSING')
  return sheets
}

export async function parseWorkbookFile(arrayBuffer, { filename } = {}) {
  if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.xlsx')) {
    fail('WORKBOOK_FORMAT_UNSUPPORTED')
  }
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 1
    || arrayBuffer.byteLength > MAX_WORKBOOK_BYTES) fail('WORKBOOK_SIZE_INVALID')
  const bytes = new Uint8Array(arrayBuffer)
  const decompressedBytes = validateArchiveEntries(bytes)
  let files
  try { files = unzipSync(bytes) } catch { fail('WORKBOOK_ARCHIVE_INVALID') }
  validateArchiveFiles(files, decompressedBytes)
  return normalizeWorkbookRows({
    filename,
    fingerprint: await sha256(bytes),
    sheets: workbookSheetsFrom(files),
  })
}

const csvRows = (source) => {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index <= source.length; index++) {
    const char = index === source.length ? '\n' : source[index]
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"'
        index++
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field === '') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''))
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
      field = ''
    } else field += char
  }
  if (quoted) fail('WORKBOOK_CSV_INVALID')
  return rows
}

export async function parseWorkbookCsv(source, { filename } = {}) {
  if (typeof source !== 'string' || typeof filename !== 'string'
    || !filename.toLowerCase().endsWith('.csv')) fail('WORKBOOK_FORMAT_UNSUPPORTED')
  const bytes = new TextEncoder().encode(source)
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_WORKBOOK_BYTES) fail('WORKBOOK_SIZE_INVALID')
  return normalizeWorkbookRows({
    filename,
    fingerprint: await sha256(bytes),
    sheets: [{ name: filename.replace(/\.csv$/i, ''), rows: csvRows(source) }],
  })
}
