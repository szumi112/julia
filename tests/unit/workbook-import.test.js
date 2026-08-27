import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'
import {
  normalizeWorkbookRows,
  parseWorkbookCsv,
  parseWorkbookFile,
} from '../../src/workbook-import.js'

const reconciliationFixture = JSON.parse(readFileSync(new URL(
  '../fixtures/workbook-reconciliation-v2.json', import.meta.url,
), 'utf8'))

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
    if (typeof value === 'object' && value.formula) {
      return `<c r="${ref}"><f>${xmlEscape(value.formula)}</f><v>${value.cached}</v></c>`
    }
    if (typeof value === 'object' && Number.isSafeInteger(value.sharedString)) {
      return `<c r="${ref}" t="s"><v>${value.sharedString}</v></c>`
    }
    if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`
    return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`
  }).join('')}</row>`
)).join('')}</sheetData></worksheet>`

const testWorkbook = ({ sheets = workbookSheets, sharedStrings = [], extraFiles = {},
  extraRelationships = '' } = {}) => {
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => (
  `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
)).join('')}</sheets></workbook>`
  const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => (
  `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
)).join('')}${extraRelationships}</Relationships>`
  const files = {
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(relationships),
    ...extraFiles,
  }
  if (sharedStrings.length) {
    files['xl/sharedStrings.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sharedStrings.map((value) => (
        `<si><t>${xmlEscape(value)}</t></si>`
      )).join('')}</sst>`)
  }
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheetXml(sheet.rows))
  })
  return zipSync(files)
}

test('normalizes transactions with civil-date accounting months', () => {
  const preview = normalizeWorkbookRows({
    filename: 'fictional.xlsx',
    fingerprint: 'a'.repeat(64),
    sheets: workbookSheets,
  })

  assert.deepEqual(preview.counts, {
    financeRows: 2,
    datedFinanceRows: 2,
    undatedFinanceRows: 0,
    tusRows: 1,
    englishRows: 2,
    costOrAncillaryRows: 3,
  })
  assert.deepEqual(preview.rows[0], {
    sourceKey: 'workbook:v1:0:2:0',
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
  assert.equal(undated, undefined)
  assert.deepEqual(preview.quarantinedRows.map(({ reasonCode, accountingMonth }) => ({
    reasonCode,
    accountingMonth,
  })), [{ reasonCode: 'SERVICE_DATE_MISSING', accountingMonth: '2024-09' }])
})

test('assigns every dated combined-sheet row to its civil month', () => {
  const preview = normalizeWorkbookRows({
    filename: 'fictional.xlsx',
    fingerprint: 'c'.repeat(64),
    sheets: [{
      name: 'SierpieńWrzesień',
      rows: [
        transactionHeader,
        ['Konsultacja', 180, 'Osoba Sierpniowa', '2024-08-20', '', '', ''],
        ['Konsultacja', 180, 'Osoba Wrześniowa', '2024-09-30', '', '', ''],
      ],
    }],
  })

  assert.deepEqual(preview.rows.map(({ accountingMonth, occurredOn }) => ({
    accountingMonth,
    occurredOn,
  })), [
    { accountingMonth: '2024-08', occurredOn: '2024-08-20' },
    { accountingMonth: '2024-09', occurredOn: '2024-09-30' },
  ])
})

test('returns stable quarantine reasons for populated candidates with unusable service dates', () => {
  const preview = normalizeWorkbookRows(reconciliationFixture)

  assert.deepEqual(preview.quarantinedRows?.map(({ rowNumber, reasonCode, accountingMonth }) => ({
    rowNumber,
    reasonCode,
    accountingMonth,
  })), [
    { rowNumber: 4, reasonCode: 'SERVICE_DATE_MISSING', accountingMonth: '2024-09' },
    { rowNumber: 5, reasonCode: 'SERVICE_DATE_INVALID', accountingMonth: '2024-09' },
  ])
  assert.equal(preview.reconciliation.sourceCandidates, 9)
  assert.equal(preview.reconciliation.acceptedRows, 7)
  assert.equal(preview.reconciliation.quarantinedRows, 2)
})

test('preserves additive prices and never infers months from monetary amounts', () => {
  const preview = normalizeWorkbookRows({
    filename: 'fictional-client-name.xlsx',
    fingerprint: 'e'.repeat(64),
    sheets: [{
      name: 'Wrzesień 2025',
      rows: [
        transactionHeader,
        ['Konsultacja', '200 + 20 na sesje', 'Osoba Testowa', '2025-09-02', '', '', ''],
      ],
    }, {
      name: 'Stałe koszty',
      rows: [
        ['Koszt', 'Cena'],
        ['Wynajem', 2200],
      ],
    }],
  })

  assert.equal(preview.rows[0].amountGrosze, 22_000)
  assert.equal(preview.rows[1].accountingMonth, null)
  assert.doesNotMatch(preview.rows[0].sourceKey, /fictional|client|\.xlsx|eeee/)
  assert.deepEqual(preview.warnings.find(({ code }) => code === 'ACCOUNTING_MONTH_UNKNOWN'), {
    code: 'ACCOUNTING_MONTH_UNKNOWN', count: 1,
  })
  assert.deepEqual(preview.warnings.find(({ code }) => code === 'AMOUNT_STORED_AS_TEXT'), {
    code: 'AMOUNT_STORED_AS_TEXT', count: 1,
  })
})

test('quarantines instead of silently dropping a populated transaction with an invalid price', () => {
  for (const price of ['do ustalenia', '200+20 na 2 sesje']) {
    const preview = normalizeWorkbookRows({
      filename: 'invalid.xlsx',
      fingerprint: 'f'.repeat(64),
      sheets: [{
        name: 'Maj 2025',
        rows: [transactionHeader, ['Konsultacja', price, 'Osoba Testowa', '2025-05-02']],
      }],
    })
    assert.equal(preview.rows.length, 0)
    assert.equal(preview.quarantinedRows?.[0]?.reasonCode, 'AMOUNT_INVALID')
  }
})

test('normalizes raw source strings before protected payload validation', () => {
  const preview = normalizeWorkbookRows({
    filename: 'whitespace.xlsx',
    fingerprint: '1'.repeat(64),
    sheets: [{
      name: 'Maj 2025',
      rows: [transactionHeader, ['  Konsultacja  ', 200, '  Osoba Testowa  ', '2025-05-02']],
    }],
  })

  assert.equal(preview.rows[0].raw.Usługa, 'Konsultacja')
  assert.equal(preview.rows[0].raw.Klient, 'Osoba Testowa')
})

test('normalizes TUS, English, expenses, and ancillary revenue as distinct records', () => {
  const preview = normalizeWorkbookRows({
    filename: 'fictional.xlsx',
    fingerprint: 'b'.repeat(64),
    sheets: workbookSheets,
  })
  const tus = preview.rows.find((row) => row.recordType === 'tus')
  assert.equal(tus.sourceLabel, 'Grupa TUS 5-6 lat')
  assert.equal(tus.accountingMonth, '2024-10')
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
  assert.equal(preview.counts.financeRows, 2)
  assert.equal(preview.rows.length, 7)
})

test('excludes formula-cache summaries but retains valid records after them', async () => {
  const fixtureSheets = reconciliationFixture.sheets.filter(({ name }) => name === 'Angielski Julia')
  const bytes = testWorkbook({ sheets: fixtureSheets })
  const preview = await parseWorkbookFile(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ), { filename: 'formula-cache.xlsx' })

  assert.deepEqual(preview.rows.map(({ counterparty }) => counterparty), [
    'Uczeń Pierwszy',
    'Uczeń Po Podsumowaniu',
  ])
  assert.equal(preview.reconciliation.excludedFormulaBlocks, 1)
})

test('quarantines a shared-string OOXML service date instead of coercing its text', async () => {
  const bytes = testWorkbook({
    sharedStrings: ['2025-09-02'],
    sheets: [{
      name: 'Wrzesień',
      rows: [
        transactionHeader,
        ['Konsultacja', 180, 'Osoba Testowa', { sharedString: 0 }],
      ],
    }],
  })
  const preview = await parseWorkbookFile(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ), { filename: 'shared-date.xlsx' })

  assert.equal(preview.rows.length, 0)
  assert.equal(preview.quarantinedRows[0].reasonCode, 'SERVICE_DATE_INVALID')
})

test('adds parser and materializer versions without changing transport format version', () => {
  const preview = normalizeWorkbookRows(reconciliationFixture)

  assert.equal(preview.formatVersion, 1)
  assert.equal(preview.parserVersion, 2)
  assert.equal(preview.materializerVersion, 2)
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

test('rejects unsafe workbook formats', async () => {
  await assert.rejects(
    parseWorkbookFile(new ArrayBuffer(8), { filename: 'unsafe.xlsm' }),
    /WORKBOOK_FORMAT_UNSUPPORTED/,
  )
})

test('rejects executable formulas and unsafe OOXML package relationships', async () => {
  const cases = [
    {
      name: 'macro.xlsx',
      bytes: testWorkbook({ extraFiles: { 'xl/vbaProject.bin': new Uint8Array([1]) } }),
      code: 'WORKBOOK_MACRO_FORBIDDEN',
    },
    {
      name: 'external.xlsx',
      bytes: testWorkbook({
        extraRelationships: '<Relationship Id="external" Type="externalLink" Target="https://example.test/source.xlsx" TargetMode="External"/>',
      }),
      code: 'WORKBOOK_EXTERNAL_RELATIONSHIP_FORBIDDEN',
    },
    {
      name: 'malformed-relationship.xlsx',
      bytes: testWorkbook({
        extraRelationships: '<Relationship Id="malformed" Type="worksheet"/>',
      }),
      code: 'WORKBOOK_RELATIONSHIP_INVALID',
    },
    {
      name: 'traversal.xlsx',
      bytes: testWorkbook({ extraFiles: { '../escape.txt': strToU8('unsafe') } }),
      code: 'WORKBOOK_ARCHIVE_PATH_INVALID',
    },
    {
      name: 'dde.xlsx',
      bytes: testWorkbook({ sheets: [{
        name: 'Maj 2025',
        rows: [
          transactionHeader,
          ['Konsultacja', { formula: 'DDE("cmd","/c calc")', cached: 180 }, 'Osoba Testowa', '2025-05-02'],
        ],
      }] }),
      code: 'WORKBOOK_FORMULA_FORBIDDEN',
    },
  ]

  for (const { name, bytes, code } of cases) {
    await assert.rejects(parseWorkbookFile(bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ), { filename: name }), new RegExp(code))
  }
})

test('rejects an archive whose decompressed payload exceeds the parser budget', async () => {
  const bytes = testWorkbook({
    extraFiles: { 'xl/media/oversized.bin': new Uint8Array(26 * 1024 * 1024) },
  })

  await assert.rejects(parseWorkbookFile(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ), { filename: 'oversized.xlsx' }), /WORKBOOK_DECOMPRESSED_SIZE_INVALID/)
})
