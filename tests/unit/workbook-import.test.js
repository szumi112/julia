import assert from 'node:assert/strict'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'
import {
  normalizeWorkbookRows,
  parseWorkbookCsv,
  parseWorkbookFile,
} from '../../src/workbook-import.js'

const transactionHeader = [
  'Usługa', 'Cena', 'Klient', 'Data zakupu', 'Sposób płatności', 'Status', 'Faktura',
]

const workbookSheets = [
  {
    name: 'SierpieńWrzesień',
    rows: [
      transactionHeader,
      ['Konsultacja psychologiczna', 160, 'Joanna Testowa', 45524, 'Przelew', 'Opłacona', 'Wystawiona - wysłana'],
      ['Webinar online', 120, 'Firma Testowa', '', 'BLIK', '', 'wystawić'],
    ],
  },
  {
    name: 'GRUPA TUS ',
    rows: [
      ['Wrzesień'],
      transactionHeader.slice(0, 6),
      ['Grupa TUS 5-6 lat', 300, 'Rodzic Testowy', 45567, 'Przelew', 'Opłacona'],
    ],
  },
  {
    name: 'Angielski Julia',
    rows: [
      ['Grudzień 2024', '', '', '', '', 'Styczeń 2025'],
      ['Imię i nazwisko', 'Ilość lekcji', 'Kwota', '', '', 'Imię i nazwisko', 'Ilość lekcji', 'Kwota'],
      ['Uczeń Pierwszy', 5, 275, '', '', 'Uczeń Pierwszy', 4, 220],
    ],
  },
  {
    name: 'Stałe koszty',
    rows: [
      ['Koszt', 'Cena', '', 'Koszt', 'Kwota', '', 'Przychód', 'Kwota'],
      ['Wynajem lokalu', 2200, '', 'Strona www', 300, '', 'TUS (5-6 lat)', 1500],
    ],
  },
]

const xmlEscape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')

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

const worksheetXml = (rows) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, rowIndex) => (
  `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const ref = `${columnName(columnIndex)}${rowIndex + 1}`
    if (value === '' || value === null || value === undefined) return `<c r="${ref}"/>`
    if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`
    return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`
  }).join('')}</row>`
)).join('')}</sheetData></worksheet>`

const testWorkbook = () => {
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets.map((sheet, index) => (
  `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
)).join('')}</sheets></workbook>`
  const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookSheets.map((_, index) => (
  `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
)).join('')}</Relationships>`
  const files = {
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(relationships),
  }
  workbookSheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheetXml(sheet.rows))
  })
  return zipSync(files)
}

test('normalizes transactions without inventing missing workbook facts', () => {
  const preview = normalizeWorkbookRows({
    filename: 'fictional.xlsx',
    fingerprint: 'a'.repeat(64),
    sheets: workbookSheets,
  })

  assert.deepEqual(preview.counts, {
    financeRows: 3,
    datedFinanceRows: 2,
    undatedFinanceRows: 1,
    tusRows: 1,
    englishRows: 2,
    costOrAncillaryRows: 3,
  })
  assert.deepEqual(preview.rows[0], {
    sourceKey: `fictional.xlsx:SierpieńWrzesień:2:${'a'.repeat(16)}`,
    sheet: 'SierpieńWrzesień',
    rowNumber: 2,
    recordType: 'income',
    accountingMonth: '2024-08',
    occurredOn: '2024-08-20',
    amountGrosze: 16000,
    counterparty: 'Joanna Testowa',
    sourceLabel: 'Konsultacja psychologiczna',
    paymentMethod: 'transfer',
    settlementStatus: 'paid',
    invoiceStatus: 'issued',
    invoiceNote: 'Wystawiona - wysłana',
    specialistName: null,
    lessonCount: null,
    raw: transactionHeader.reduce((result, header, index) => ({
      ...result,
      [header]: workbookSheets[0].rows[1][index],
    }), {}),
  })
  const undated = preview.rows.find((row) => row.sourceLabel === 'Webinar online')
  assert.equal(undated.occurredOn, null)
  assert.equal(undated.accountingMonth, '2024-09')
  assert.equal(undated.paymentMethod, 'blik')
  assert.equal(undated.settlementStatus, 'unknown')
  assert.equal(undated.invoiceStatus, 'action_required')
})

test('normalizes TUS, English, expenses, and ancillary revenue as distinct records', () => {
  const preview = normalizeWorkbookRows({
    filename: 'fictional.xlsx',
    fingerprint: 'b'.repeat(64),
    sheets: workbookSheets,
  })
  const tus = preview.rows.find((row) => row.recordType === 'tus')
  assert.equal(tus.sourceLabel, 'Grupa TUS 5-6 lat')
  assert.equal(tus.accountingMonth, '2024-09')
  const english = preview.rows.filter((row) => row.recordType === 'english')
  assert.deepEqual(english.map(({ accountingMonth, lessonCount, amountGrosze }) => (
    { accountingMonth, lessonCount, amountGrosze }
  )), [
    { accountingMonth: '2024-12', lessonCount: 5, amountGrosze: 27500 },
    { accountingMonth: '2025-01', lessonCount: 4, amountGrosze: 22000 },
  ])
  const fixed = preview.rows.filter((row) => row.sheet === 'Stałe koszty')
  assert.deepEqual(fixed.map(({ recordType, sourceLabel, amountGrosze }) => (
    { recordType, sourceLabel, amountGrosze }
  )), [
    { recordType: 'expense', sourceLabel: 'Wynajem lokalu', amountGrosze: 220000 },
    { recordType: 'expense', sourceLabel: 'Strona www', amountGrosze: 30000 },
    { recordType: 'income', sourceLabel: 'TUS (5-6 lat)', amountGrosze: 150000 },
  ])
})

test('parses a real OOXML zip and hashes its bytes before normalization', async () => {
  const bytes = testWorkbook()
  const preview = await parseWorkbookFile(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ), { filename: 'mini.xlsx' })
  assert.match(preview.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(preview.counts.financeRows, 3)
  assert.equal(preview.rows.length, 8)
})

test('parses CSV rows with quoted commas and stable source keys', async () => {
  const csv = [
    'Usługa,Cena,Klient,Data zakupu,Sposób płatności,Status,Faktura',
    '"Warsztaty, rodzice","300,00 zł","Mama, Testowa",2024-08-28,Przelew,Opłacona,Wystawiona',
  ].join('\n')
  const preview = await parseWorkbookCsv(csv, { filename: 'slice.csv' })
  assert.equal(preview.rows.length, 1)
  assert.equal(preview.rows[0].sourceLabel, 'Warsztaty, rodzice')
  assert.equal(preview.rows[0].counterparty, 'Mama, Testowa')
  assert.equal(preview.rows[0].occurredOn, '2024-08-28')
  assert.equal(preview.rows[0].amountGrosze, 30000)
})

test('preserves an English learner month with zero lessons and zero amount', () => {
  const preview = normalizeWorkbookRows({
    filename: 'zero.xlsx',
    fingerprint: 'd'.repeat(64),
    sheets: [{
      name: 'Angielski Julia',
      rows: [
        ['Lipiec 2025'],
        ['Imię i nazwisko', 'Ilość lekcji', 'Kwota'],
        ['Uczeń Bez Zajęć', 0, 0],
      ],
    }],
  })
  assert.equal(preview.rows.length, 1)
  assert.equal(preview.rows[0].lessonCount, 0)
  assert.equal(preview.rows[0].amountGrosze, 0)
})

test('rejects duplicate source rows and unsafe workbook formats', async () => {
  const duplicate = {
    name: 'SierpieńWrzesień',
    rows: [transactionHeader, workbookSheets[0].rows[1]],
  }
  assert.throws(() => normalizeWorkbookRows({
    filename: 'duplicate.xlsx',
    fingerprint: 'c'.repeat(64),
    sheets: [duplicate, duplicate],
  }), /WORKBOOK_DUPLICATE_ROW/)
  await assert.rejects(
    parseWorkbookFile(new ArrayBuffer(8), { filename: 'unsafe.xlsm' }),
    /WORKBOOK_FORMAT_UNSUPPORTED/,
  )
})
