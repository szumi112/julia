import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { parseWorkbookFile } from '../../src/workbook-import.js'

const workbookOoxml = () => import('../../src/workbook-ooxml.js')

test('three-way merge keeps a concurrent current date when the workbook date is unchanged', async () => {
  const { mergePanelEdits } = await workbookOoxml()

  const result = mergePanelEdits({
    baseRows: [{ id: 'visit_1', values: { occurredOn: '2026-08-20' } }],
    currentRows: [{ id: 'visit_1', values: { occurredOn: '2026-08-21' } }],
    editedRows: [{ id: 'visit_1', values: { occurredOn: '2026-08-20' } }],
    fields: { occurredOn: { type: 'date' } },
  })

  assert.deepEqual(result, {
    conflicts: [],
    unchangedIds: ['visit_1'],
    updates: [],
    voids: [],
  })
})

test('three-way merge accepts typed workbook edits and normalizes text to NFC', async () => {
  const { mergePanelEdits } = await workbookOoxml()

  const result = mergePanelEdits({
    baseRows: [{
      id: 'visit_1',
      values: {
        amountCents: 18_000,
        occurredOn: '2026-08-20',
        status: 'scheduled',
        note: 'Cafe',
      },
    }],
    currentRows: [{
      id: 'visit_1',
      values: {
        amountCents: 18_000,
        occurredOn: '2026-08-20',
        status: 'scheduled',
        note: 'Cafe',
      },
    }],
    editedRows: [{
      id: 'visit_1',
      values: {
        amountCents: 20_000,
        occurredOn: '2026-08-22',
        status: 'completed',
        note: 'Cafe\u0301',
      },
    }],
    fields: {
      amountCents: { type: 'cents' },
      occurredOn: { type: 'date' },
      status: { type: 'enum', values: ['cancelled', 'completed', 'scheduled'] },
      note: { type: 'text' },
    },
  })

  assert.deepEqual(result, {
    conflicts: [],
    unchangedIds: [],
    updates: [{
      id: 'visit_1',
      values: {
        amountCents: 20_000,
        occurredOn: '2026-08-22',
        status: 'completed',
        note: 'Caf\u00e9',
      },
    }],
    voids: [],
  })
})

test('three-way merge distinguishes an omitted field from an explicit blank', async () => {
  const { mergePanelEdits } = await workbookOoxml()

  const result = mergePanelEdits({
    baseRows: [
      { id: 'client_1', values: { note: 'Pozostaje' } },
      { id: 'client_2', values: { note: 'Usu\u0144' } },
    ],
    currentRows: [
      { id: 'client_1', values: { note: 'Pozostaje' } },
      { id: 'client_2', values: { note: 'Usu\u0144' } },
    ],
    editedRows: [
      { id: 'client_1', values: {} },
      { id: 'client_2', values: { note: null } },
    ],
    fields: { note: { type: 'text' } },
  })

  assert.deepEqual(result, {
    conflicts: [],
    unchangedIds: ['client_1'],
    updates: [{ id: 'client_2', values: { note: null } }],
    voids: [],
  })
})

test('three-way merge reports field conflicts without overwriting current values', async () => {
  const { mergePanelEdits } = await workbookOoxml()

  const result = mergePanelEdits({
    baseRows: [{ id: 'visit_1', values: { amountCents: 18_000 } }],
    currentRows: [{ id: 'visit_1', values: { amountCents: 19_000 } }],
    editedRows: [{ id: 'visit_1', values: { amountCents: 20_000 } }],
    fields: { amountCents: { type: 'cents' } },
  })

  assert.deepEqual(result, {
    conflicts: [{
      id: 'visit_1',
      field: 'amountCents',
      base: 18_000,
      current: 19_000,
      edited: 20_000,
      reason: 'concurrent_edit',
    }],
    unchangedIds: [],
    updates: [],
    voids: [],
  })
})

test('three-way merge never infers voids from missing rows', async () => {
  const { mergePanelEdits } = await workbookOoxml()
  const input = {
    baseRows: [{ id: 'visit_1', values: { status: 'scheduled' } }],
    currentRows: [{ id: 'visit_1', values: { status: 'scheduled' } }],
    editedRows: [],
    fields: { status: { type: 'enum', values: ['scheduled'] } },
  }

  assert.deepEqual(mergePanelEdits(input), {
    conflicts: [],
    unchangedIds: [],
    updates: [],
    voids: [],
  })
  assert.deepEqual(mergePanelEdits({ ...input, voidIds: ['visit_1'] }), {
    conflicts: [],
    unchangedIds: [],
    updates: [],
    voids: ['visit_1'],
  })
})

test('three-way merge rejects invalid cents and enum values', async () => {
  const { mergePanelEdits } = await workbookOoxml()
  const rows = [{ id: 'visit_1', values: { amountCents: 18_000, status: 'scheduled' } }]

  assert.throws(() => mergePanelEdits({
    baseRows: rows,
    currentRows: rows,
    editedRows: [{ id: 'visit_1', values: { amountCents: 180.5, status: 'scheduled' } }],
    fields: {
      amountCents: { type: 'cents' },
      status: { type: 'enum', values: ['scheduled'] },
    },
  }), /PANEL_MERGE_CENTS_INVALID/)
  assert.throws(() => mergePanelEdits({
    baseRows: rows,
    currentRows: rows,
    editedRows: [{ id: 'visit_1', values: { amountCents: 18_000, status: 'executed' } }],
    fields: {
      amountCents: { type: 'cents' },
      status: { type: 'enum', values: ['scheduled'] },
    },
  }), /PANEL_MERGE_ENUM_INVALID/)
})

const panelMeta = (overrides = {}) => ({
  format: 'Panel-v2',
  scope: { type: 'centre', id: 'centre_1' },
  rows: [{
    id: 'visit_1',
    type: 'appointment',
    baseVersion: 3,
    fieldDigests: {
      occurredOn: 'digest_occurredOn_1234',
      amountCents: 'digest_amountCents_1234',
    },
  }],
  voidIds: [],
  ...overrides,
})

test('canonical Meta signs deterministic privacy-safe UTF-8 bytes through an injected callback', async () => {
  const { signPanelMetadata } = await workbookOoxml()
  let signedText = null

  const signed = await signPanelMetadata(panelMeta(), async (payloadBytes) => {
    signedText = new TextDecoder().decode(payloadBytes)
    return 'signature_fixture_1'
  })

  assert.equal(signedText, '{"format":"Panel-v2","rows":[{"baseVersion":3,"fieldDigests":{"amountCents":"digest_amountCents_1234","occurredOn":"digest_occurredOn_1234"},"id":"visit_1","type":"appointment"}],"scope":{"id":"centre_1","type":"centre"},"voidIds":[]}')
  assert.deepEqual(signed, {
    payload: signedText,
    signature: 'signature_fixture_1',
  })
})

test('canonical Meta is stable across input ordering and rejects secret-bearing extras', async () => {
  const { canonicalPanelMetadata } = await workbookOoxml()
  const first = canonicalPanelMetadata(panelMeta({
    rows: [
      {
        id: 'visit_2', type: 'appointment', baseVersion: 2,
        fieldDigests: { note: 'digest_note_visit_2' },
      },
      panelMeta().rows[0],
    ],
    voidIds: ['visit_2', 'visit_1'],
  }))
  const second = canonicalPanelMetadata(panelMeta({
    rows: [
      panelMeta().rows[0],
      {
        fieldDigests: { note: 'digest_note_visit_2' }, baseVersion: 2,
        type: 'appointment', id: 'visit_2',
      },
    ],
    voidIds: ['visit_1', 'visit_2'],
  }))

  assert.deepEqual(first, second)
  assert.throws(() => canonicalPanelMetadata({
    ...panelMeta(),
    signingKey: 'must-never-enter-Meta',
  }), /PANEL_META_SCHEMA_INVALID/)
})

const legacyStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="8"><xf/><xf numFmtId="14"/><xf/><xf/><xf/><xf applyFill="1"/><xf applyNumberFormat="1"/><xf applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0"/></cellStyles></styleSheet>`

const syntheticTemplateFiles = (overrides = {}) => ({
  '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>`),
  '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
  'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Arkusz A" sheetId="1" r:id="rId1"/><sheet name="Arkusz B" sheetId="7" r:id="rId4"/></sheets><definedNames><definedName name="LegacyRange">'Arkusz A'!$B$2:$B$3</definedName></definedNames><calcPr calcId="124519"/></workbook>`),
  'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>`),
  'xl/styles.xml': strToU8(legacyStyles),
  'xl/sharedStrings.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>Nag\u0142\u00f3wek</t></si><si><t>Klient Dozwolony</t></si><si><t>Klient Drugi</t></si></sst>`),
  'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:E4"/><cols><col min="1" max="1" width="23.75" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/></cols><sheetData><row r="1" ht="24" customHeight="1"><c r="A1" s="5" t="s"><v>0</v></c></row><row r="2"><c r="A2" s="5" t="s"><v>1</v></c><c r="B2" s="6"><v>100</v></c></row><row r="3"><c r="A3" s="5" t="s"><v>2</v></c><c r="B3" s="6"><v>200</v></c></row><row r="4"><c r="A4" s="5" t="inlineStr"><is><t>Suma</t></is></c><c r="B4" s="7"><f>SUM(B2:B3)</f><v>300</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="D3:E3"/></mergeCells><drawing r:id="rIdDrawing"/></worksheet>`),
  'xl/worksheets/sheet2.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="7"><v>42</v></c></row><row r="2"><c r="B2" s="7"><f>SUM('Arkusz A'!B2:B3)</f><v>300</v></c></row></sheetData></worksheet>`),
  'xl/worksheets/_rels/sheet1.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`),
  'xl/drawings/drawing1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>2</xdr:row></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:row>2</xdr:row></xdr:to><xdr:sp/><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`),
  'xl/calcChain.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B4" i="1"/></calcChain>`),
  ...overrides,
})

const syntheticTemplate = (overrides = {}) => zipSync(syntheticTemplateFiles(overrides))

const relocateWorkbookPart = (files, { from, relationshipTarget, to }) => {
  files[to] = files[from]
  delete files[from]
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    strFromU8(files['xl/_rels/workbook.xml.rels'])
      .replace(`Target="${from.replace(/^xl\//, '')}"`, `Target="${relationshipTarget}"`),
  )
  files['[Content_Types].xml'] = strToU8(
    strFromU8(files['[Content_Types].xml'])
      .replace(`PartName="/${from}"`, `PartName="/${to}"`),
  )
  return files
}

const workbookSheetNames = (xml) => [...xml.matchAll(/<sheet\b([^>]*?)\/>/g)]
  .map((match) => /\bname="([^"]+)"/.exec(match[1])?.[1]
    .replaceAll('&amp;', '&').replaceAll('&quot;', '"'))

const panelSheets = () => [{
  name: 'Panel \u2014 Podsumowanie',
  columns: [{ key: 'total', label: 'Suma', type: 'formula' }],
  rows: [{
    id: 'summary_1',
    values: { total: { formula: "SUM('Panel \u2014 Wizyty'!C3:C3)", cached: 18_000 } },
  }],
}, {
  name: 'Panel \u2014 Wizyty',
  columns: [
    { key: 'occurredOn', label: 'Data', type: 'date', width: 14, styleId: 1 },
    { key: 'amountCents', label: 'Kwota (gr)', type: 'cents', width: 15, styleId: 6 },
    {
      key: 'status', label: 'Status', type: 'enum',
      values: ['cancelled', 'completed', 'scheduled'],
    },
    { key: 'note', label: 'Notatka', type: 'text', width: 28 },
  ],
  rows: [{
    id: 'visit_1',
    values: {
      occurredOn: '2026-08-20',
      amountCents: 18_000,
      status: 'scheduled',
      note: '=2+2',
    },
  }],
}]

const signatureFor = (payloadBytes) => `sig_${createHash('sha256')
  .update('synthetic-signing-key-not-metadata')
  .update(payloadBytes)
  .digest('base64url')}`

const signingCallbacks = {
  sign: async (payloadBytes) => signatureFor(payloadBytes),
  verify: async (payloadBytes, signature) => signature === signatureFor(payloadBytes),
}

const panelMetadata = (overrides = {}) => panelMeta({
  rows: [{
    ...panelMeta().rows[0],
    fieldDigests: {
      amountCents: 'digest_amountCents_1234',
      note: 'digest_note_12345678',
      occurredOn: 'digest_occurredOn_1234',
      status: 'digest_status_123456',
    },
  }],
  ...overrides,
})

const patchedPanelWorkbook = async (overrides = {}) => {
  const { patchPanelWorkbook } = await workbookOoxml()
  return patchPanelWorkbook(syntheticTemplate(), {
    sheets: panelSheets(),
    metadata: panelMetadata(),
    ...overrides,
  }, { sign: signingCallbacks.sign })
}

test('full-centre patch appends Panel-v2 while preserving legacy OOXML semantics', async () => {
  const { patchPanelWorkbook } = await workbookOoxml()
  const sourceFiles = syntheticTemplateFiles()
  const patched = await patchPanelWorkbook(syntheticTemplate(), {
    sheets: panelSheets(),
    metadata: panelMeta({
      rows: [{
        ...panelMeta().rows[0],
        fieldDigests: {
          amountCents: 'digest_amountCents_1234',
          note: 'digest_note_12345678',
          occurredOn: 'digest_occurredOn_1234',
          status: 'digest_status_123456',
        },
      }],
    }),
    includePermissions: true,
  }, { sign: async () => 'signature_fixture_1' })
  const files = unzipSync(patched)
  const workbook = strFromU8(files['xl/workbook.xml'])
  const relationships = strFromU8(files['xl/_rels/workbook.xml.rels'])
  const contentTypes = strFromU8(files['[Content_Types].xml'])

  assert.deepEqual(workbookSheetNames(workbook), [
    'Arkusz A',
    'Arkusz B',
    'Panel \u2014 Podsumowanie',
    'Panel \u2014 Wizyty',
    'Panel \u2014 Klienci',
    'Panel \u2014 Zesp\u00f3\u0142',
    'Panel \u2014 TUS',
    'Panel \u2014 Angielski',
    'Panel \u2014 Uprawnienia',
    'Panel \u2014 Meta',
  ])
  assert.match(workbook, /name="Panel \u2014 Meta"[^>]*state="veryHidden"/)
  assert.match(workbook, /<calcPr\b[^>]*calcMode="auto"[^>]*fullCalcOnLoad="1"[^>]*forceFullCalc="1"/)
  assert.equal(files['xl/calcChain.xml'], undefined)
  assert.doesNotMatch(relationships, /calcChain/)
  assert.doesNotMatch(contentTypes, /calcChain/)
  assert.deepEqual(files['xl/styles.xml'], sourceFiles['xl/styles.xml'])
  assert.deepEqual(files['xl/worksheets/sheet1.xml'], sourceFiles['xl/worksheets/sheet1.xml'])
  assert.deepEqual(
    files['xl/worksheets/_rels/sheet1.xml.rels'],
    sourceFiles['xl/worksheets/_rels/sheet1.xml.rels'],
  )
  assert.deepEqual(files['xl/drawings/drawing1.xml'], sourceFiles['xl/drawings/drawing1.xml'])
  const sharedStrings = strFromU8(files['xl/sharedStrings.xml'])
  assert.ok(sharedStrings.indexOf('Nag\u0142\u00f3wek') < sharedStrings.indexOf('Klient Dozwolony'))
  assert.ok(sharedStrings.indexOf('Klient Dozwolony') < sharedStrings.indexOf('Klient Drugi'))
  assert.match(sharedStrings, /<t>=2\+2<\/t>/)
  assert.match(contentTypes, /PartName="\/xl\/worksheets\/sheet3\.xml"/)
  assert.doesNotMatch(strFromU8(files['xl/worksheets/sheet1.xml']), /Panel \u2014/)
})

test('legacy patch keeps original sheet/row shape while applying canonical values and explicit voids', async () => {
  const { patchPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const transactionSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:E4"/><sheetData>
<row r="1" ht="24" customHeight="1"><c r="A1" s="5" t="inlineStr"><is><t>Usługa</t></is></c><c r="B1" s="6" t="inlineStr"><is><t>Cena</t></is></c><c r="C1" s="5" t="inlineStr"><is><t>Klient</t></is></c><c r="D1" s="6" t="inlineStr"><is><t>Data zakupu</t></is></c><c r="E1" s="5" t="inlineStr"><is><t>Miesiąc księgowy</t></is></c></row>
<row r="2" ht="20" customHeight="1"><c r="A2" s="5" t="inlineStr"><is><t>Konsultacja</t></is></c><c r="B2" s="6"><v>180</v></c><c r="C2" s="5" t="inlineStr"><is><t>Fikcyjna osoba</t></is></c><c r="D2" s="6" t="d"><v>2025-09-02</v></c><c r="E2" s="5" t="inlineStr"><is><t>2025-09</t></is></c></row>
<row r="3" ht="20" customHeight="1"><c r="A3" s="5" t="inlineStr"><is><t>Wiersz do unieważnienia</t></is></c><c r="B3" s="6"><v>90</v></c><c r="C3" s="5" t="inlineStr"><is><t>Fikcyjna osoba 2</t></is></c><c r="D3" s="6" t="d"><v>2025-09-03</v></c><c r="E3" s="5" t="inlineStr"><is><t>2025-09</t></is></c></row>
<row r="4"><c r="A4" s="5" t="inlineStr"><is><t>Suma</t></is></c><c r="B4" s="7"><f>SUM(B2:B3)</f><v>270</v></c></row>
</sheetData></worksheet>`
  const result = unzipSync(await patchPanelWorkbook(syntheticTemplate({
    'xl/worksheets/sheet1.xml': strToU8(transactionSheet),
  }), {
    outputMode: 'legacy',
    sheets: [],
    legacyRows: [{
      sheet: 'Arkusz A', rowNumber: 2, blockIndex: 0, recordType: 'income',
      values: { accountingMonth: '2025-10', amountGrosze: 20_000 },
    }],
    legacyVoids: [{
      sheet: 'Arkusz A', rowNumber: 3, blockIndex: 0, recordType: 'income',
    }],
  }))
  const worksheet = strFromU8(result['xl/worksheets/sheet1.xml'])
  const workbook = strFromU8(result['xl/workbook.xml'])

  assert.deepEqual(workbookSheetNames(workbook), ['Arkusz A', 'Arkusz B'])
  assert.match(worksheet, /<row r="2" ht="20" customHeight="1">/)
  assert.match(worksheet, /<c r="B2" s="6"><v>200<\/v><\/c>/)
  assert.match(worksheet, /<c r="E2" s="5" t="s"><v>\d+<\/v><\/c>/)
  assert.match(strFromU8(result['xl/sharedStrings.xml']), /2025-10/)
  assert.match(worksheet, /<row r="3" ht="20" customHeight="1"><\/row>/)
  assert.doesNotMatch(worksheet, /Wiersz do unieważnienia|Fikcyjna osoba 2|<c r="B3"/)
  assert.match(worksheet, /<c r="B4" s="7"><f>SUM\(B2:B3\)<\/f><\/c>/)
  assert.equal(result['xl/calcChain.xml'], undefined)
  assert.deepEqual(await readPanelWorkbook(zipSync(result), {
    verify: () => { throw new Error('legacy export must not verify Panel metadata') },
  }), { edits: [], kind: 'legacy', metadata: null, voidIds: [] })
})

test('legacy patch adds a styled accounting-month column to an approved transaction table', async () => {
  const { patchPanelWorkbook } = await workbookOoxml()
  const transactionSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:H2"/><sheetData>
<row r="1"><c r="A1" s="5" t="inlineStr"><is><t>Usługa</t></is></c><c r="B1" s="6" t="inlineStr"><is><t>Cena</t></is></c><c r="C1" s="5" t="inlineStr"><is><t>Klient</t></is></c><c r="D1" s="6" t="inlineStr"><is><t>Data zakupu</t></is></c><c r="E1" s="5" t="inlineStr"><is><t>Sposób płatności</t></is></c><c r="F1" s="5" t="inlineStr"><is><t>Status</t></is></c><c r="G1" s="5" t="inlineStr"><is><t>Faktura</t></is></c><c r="H1" s="5" t="inlineStr"><is><t>Psycholog</t></is></c></row>
<row r="2" ht="20" customHeight="1"><c r="A2" s="5" t="inlineStr"><is><t>Konsultacja</t></is></c><c r="B2" s="6"><v>180</v></c><c r="C2" s="5" t="inlineStr"><is><t>Fikcyjna osoba</t></is></c><c r="D2" s="6" t="d"><v>2025-09-02</v></c><c r="E2" s="5" t="inlineStr"><is><t>Gotówka</t></is></c><c r="F2" s="5" t="inlineStr"><is><t>Opłacona</t></is></c><c r="G2" s="5"/><c r="H2" s="5" t="inlineStr"><is><t>Julia</t></is></c></row>
</sheetData></worksheet>`
  const result = unzipSync(await patchPanelWorkbook(syntheticTemplate({
    'xl/worksheets/sheet1.xml': strToU8(transactionSheet),
  }), {
    outputMode: 'legacy',
    sheets: [],
    legacyRows: [{
      sheet: 'Arkusz A', rowNumber: 2, blockIndex: 0, recordType: 'income',
      values: {
        accountingMonth: '2025-10',
        invoiceStatus: 'action_required',
        paymentMethod: 'transfer',
        settlementStatus: 'partial',
        specialistDisplayName: 'Julia Wolanin',
      },
    }],
  }))
  const worksheet = strFromU8(result['xl/worksheets/sheet1.xml'])
  const sharedStrings = strFromU8(result['xl/sharedStrings.xml'])

  assert.match(worksheet, /<dimension ref="A1:I2"\/>/)
  assert.match(worksheet, /<c r="I1" s="5" t="inlineStr"><is><t>Miesiąc księgowy<\/t><\/is><\/c>/)
  assert.match(worksheet, /<c r="I2" s="5" t="s"><v>\d+<\/v><\/c>/)
  assert.match(sharedStrings, /2025-10/)
  assert.match(sharedStrings, /Do wystawienia/)
  assert.match(sharedStrings, /Przelew/)
  assert.match(sharedStrings, /Częściowo opłacona/)
  assert.match(sharedStrings, /Julia Wolanin/)
  assert.match(worksheet, /<c r="E2" s="5" t="s"><v>\d+<\/v><\/c>/)
  assert.match(worksheet, /<c r="F2" s="5" t="s"><v>\d+<\/v><\/c>/)
  assert.match(worksheet, /<c r="G2" s="5" t="s"><v>\d+<\/v><\/c>/)
  assert.match(worksheet, /<c r="H2" s="5" t="s"><v>\d+<\/v><\/c>/)
})

test('legacy patch surfaces non-native canonical facts in a dedicated non-Panel correction sheet', async () => {
  const { patchPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const bytes = await patchPanelWorkbook(syntheticTemplate(), {
    outputMode: 'legacy',
    sheets: [],
    legacyAdditions: [{
      action: 'update', field: 'paidAmountGrosze', id: 'fin_non_native_paid',
      value: '9000',
    }, {
      action: 'void', field: 'record', id: 'fin_unlinked_void',
      value: 'Unieważniono w podpisanym pliku Panel-v2',
    }],
  })
  const files = unzipSync(bytes)
  const workbook = strFromU8(files['xl/workbook.xml'])
  const allText = Object.values(files).map((value) => strFromU8(value)).join('\n')

  assert.deepEqual(workbookSheetNames(workbook), [
    'Arkusz A', 'Arkusz B', 'BWM — korekty eksportu',
  ])
  assert.match(allText, /Zapłacono \(gr\)/)
  assert.match(allText, /fin_non_native_paid/)
  assert.match(allText, /Unieważniono w podpisanym pliku Panel-v2/)
  assert.doesNotMatch(workbook, /Panel — Meta/)
  assert.equal((await readPanelWorkbook(bytes)).kind, 'legacy')
})

test('exact approved legacy workbook preserves audited aggregates across coordinate patches', {
  skip: !process.env.BWM_APPROVED_WORKBOOK_PATH,
}, async () => {
  const { patchPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const source = new Uint8Array(await readFile(process.env.BWM_APPROVED_WORKBOOK_PATH))
  const parsed = await parseWorkbookFile(source.buffer.slice(
    source.byteOffset, source.byteOffset + source.byteLength,
  ), { filename: 'approved.xlsx' })
  assert.equal(parsed.fingerprint, 'f4bd7138e84971325b5453dd7c8e7c817fc1ff7ded56c3c4a98419d2df3fe99a')
  const periodCounts = {}
  for (const [disposition, rows] of [
    ['accepted', parsed.rows],
    ['quarantined', parsed.quarantinedRows],
  ]) for (const row of rows) {
    const key = `${disposition}:${row.recordType}:${row.periodPrecision}`
    periodCounts[key] = (periodCounts[key] ?? 0) + 1
  }
  assert.deepEqual(periodCounts, {
    'accepted:income:day': 1_997,
    'accepted:tus:day': 2,
    'accepted:tus:month': 23,
    'accepted:english:month': 165,
    'accepted:expense:unknown': 39,
    'accepted:income:unknown': 3,
    'accepted:expense:month': 3,
    'quarantined:income:day': 1,
    'quarantined:income:unknown': 1,
    'quarantined:expense:unknown': 1,
  })
  const coordinates = (row, values) => ({
    sheet: row.sheet,
    sheetIndex: Number(row.sourceKey.split(':')[2]),
    rowNumber: row.rowNumber,
    blockIndex: Number(row.sourceKey.split(':').at(-1)),
    recordType: row.recordType,
    values,
  })
  const transactionRows = parsed.rows.filter((row) => (
    ['income', 'tus'].includes(row.recordType)
    && row.sheet !== 'Stałe koszty'
    && row.sourceKey.endsWith(':0')
  ))
  const monthRows = transactionRows.filter(({ recordType }) => recordType === 'income').slice(0, 45)
  const fixedExpense = parsed.rows.find(({ recordType }) => recordType === 'expense')
  const fixedRevenue = parsed.rows.find((row) => (
    row.recordType === 'income' && row.sheet === 'Stałe koszty'
  ))
  const english = parsed.rows.find(({ recordType }) => recordType === 'english')
  const tus = parsed.rows.find(({ recordType }) => recordType === 'tus')
  assert.ok(fixedExpense && fixedRevenue && english && tus)
  const monthTarget = '2026-12'
  const legacyRows = [
    ...monthRows.map((row, index) => coordinates(row, {
      accountingMonth: monthTarget,
      ...(index === 0 ? { specialistDisplayName: 'Julia Wolanin' } : {}),
    })),
    coordinates(fixedExpense, { amountGrosze: fixedExpense.amountGrosze + 100 }),
    coordinates(fixedRevenue, { amountGrosze: fixedRevenue.amountGrosze + 100 }),
    coordinates(english, { amountGrosze: english.amountGrosze + 100 }),
    coordinates(tus, { amountGrosze: tus.amountGrosze + 100 }),
  ]
  const output = await patchPanelWorkbook(source, {
    outputMode: 'legacy', sheets: [], legacyRows,
  })
  const reparsed = await parseWorkbookFile(output.buffer.slice(
    output.byteOffset, output.byteOffset + output.byteLength,
  ), { filename: 'approved-export.xlsx' })
  const reparsedBySource = new Map(reparsed.rows.map((row) => [row.sourceKey, row]))

  assert.equal((await readPanelWorkbook(output)).kind, 'legacy')
  assert.deepEqual(reparsed.counts, parsed.counts)
  assert.deepEqual(reparsed.reconciliation, parsed.reconciliation)
  assert.equal(reparsed.rows.length, 2_232)
  assert.equal(reparsed.quarantinedRows.length, 3)
  assert.equal(reparsed.reconciliation.excludedFormulaRows, 5)
  assert.ok(monthRows.every((row) => (
    reparsedBySource.get(row.sourceKey)?.accountingMonth === monthTarget
  )))
  assert.equal(reparsedBySource.get(monthRows[0].sourceKey)?.specialistName, 'Julia Wolanin')
  for (const row of [fixedExpense, fixedRevenue, english, tus]) {
    assert.equal(reparsedBySource.get(row.sourceKey)?.amountGrosze, row.amountGrosze + 100)
  }
  assert.deepEqual(reparsed.quarantinedRows.map(({ reasonCode }) => reasonCode).sort(),
    parsed.quarantinedRows.map(({ reasonCode }) => reasonCode).sort())
  const files = unzipSync(output)
  const worksheetText = Object.entries(files)
    .filter(([path]) => /^xl\/worksheets\/[^/]+\.xml$/.test(path))
    .map(([, bytes]) => strFromU8(bytes)).join('\n')
  assert.doesNotMatch(worksheetText, /<f\b[^>]*>[\s\S]*?<\/f>\s*<v\b/)
  assert.doesNotMatch(strFromU8(files['xl/workbook.xml']), /Panel — Meta/)
})

test('patch resolves and preserves a relocated styles part from workbook relationships', async () => {
  const { patchPanelWorkbook } = await workbookOoxml()
  const sourceFiles = relocateWorkbookPart(syntheticTemplateFiles(), {
    from: 'xl/styles.xml',
    relationshipTarget: 'parts/styles-main.xml',
    to: 'xl/parts/styles-main.xml',
  })
  const patched = unzipSync(await patchPanelWorkbook(zipSync(sourceFiles), {
    sheets: panelSheets(),
    metadata: panelMetadata(),
  }, { sign: signingCallbacks.sign }))

  assert.equal(patched['xl/styles.xml'], undefined)
  assert.deepEqual(patched['xl/parts/styles-main.xml'], strToU8(legacyStyles))
  assert.match(strFromU8(patched['xl/_rels/workbook.xml.rels']), /Target="parts\/styles-main\.xml"/)
  assert.match(strFromU8(patched['[Content_Types].xml']), /PartName="\/xl\/parts\/styles-main\.xml"/)
})

test('patch and read use a relocated shared-string part without creating an orphan', async () => {
  const { patchPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const sourceFiles = relocateWorkbookPart(syntheticTemplateFiles(), {
    from: 'xl/sharedStrings.xml',
    relationshipTarget: 'parts/strings-main.xml',
    to: 'xl/parts/strings-main.xml',
  })
  const patchedBytes = await patchPanelWorkbook(zipSync(sourceFiles), {
    sheets: panelSheets(),
    metadata: panelMetadata(),
  }, { sign: signingCallbacks.sign })
  const patched = unzipSync(patchedBytes)
  const stringsXml = strFromU8(patched['xl/parts/strings-main.xml'])
  const strings = sharedValuesFrom(stringsXml)
  const indexes = Object.entries(patched)
    .filter(([path]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .flatMap(([, bytes]) => [...strFromU8(bytes).matchAll(/<c\b(?=[^>]*\bt="s")[^>]*><v>(\d+)<\/v><\/c>/g)]
      .map((match) => Number(match[1])))

  assert.equal(patched['xl/sharedStrings.xml'], undefined)
  assert.match(stringsXml, /Klient Dozwolony/)
  assert.match(stringsXml, /Panel-v2/)
  assert.ok(indexes.every((index) => index >= 0 && index < strings.length))
  assert.doesNotMatch(strFromU8(patched['[Content_Types].xml']), /PartName="\/xl\/sharedStrings\.xml"/)
  assert.match(strFromU8(patched['[Content_Types].xml']), /PartName="\/xl\/parts\/strings-main\.xml"/)
  const read = await readPanelWorkbook(patchedBytes, { verify: signingCallbacks.verify })
  assert.equal(read.kind, 'panel-v2')
  assert.equal(read.edits[0].values.note, '=2+2')
})

test('row insertion shifts references and drawing anchors without renumbering styles', async () => {
  const { patchPanelWorkbook } = await workbookOoxml()
  const files = unzipSync(await patchPanelWorkbook(syntheticTemplate(), {
    sheets: [],
    metadata: panelMeta(),
    rowInsertions: [{
      sheet: 'Arkusz A',
      beforeRow: 3,
      rows: [{
        cells: [
          { type: 'text', value: 'Klient Nowy', styleId: 5 },
          { type: 'integer', value: 50, styleId: 6 },
        ],
      }],
    }],
  }, { sign: async () => 'signature_fixture_1' }))
  const worksheet = strFromU8(files['xl/worksheets/sheet1.xml'])
  const drawing = strFromU8(files['xl/drawings/drawing1.xml'])
  const otherWorksheet = strFromU8(files['xl/worksheets/sheet2.xml'])
  const workbook = strFromU8(files['xl/workbook.xml'])

  assert.match(worksheet, /<dimension ref="A1:E5"\/>/)
  assert.match(worksheet, /<cols><col min="1" max="1" width="23\.75" customWidth="1"\/><col min="2" max="2" width="12" customWidth="1"\/><\/cols>/)
  assert.match(worksheet, /<row r="3"><c r="A3" s="5" t="inlineStr"><is><t>Klient Nowy<\/t><\/is><\/c><c r="B3" s="6"><v>50<\/v><\/c><\/row>/)
  assert.match(worksheet, /<row r="4"><c r="A4" s="5" t="s"><v>2<\/v><\/c><c r="B4" s="6"><v>200<\/v><\/c><\/row>/)
  assert.match(worksheet, /<c r="B5" s="7"><f>SUM\(B2:B4\)<\/f><\/c>/)
  assert.doesNotMatch(worksheet, /<v>300<\/v>/)
  assert.match(worksheet, /<mergeCell ref="D4:E4"\/>/)
  assert.match(worksheet, /<drawing r:id="rIdDrawing"\/>/)
  assert.match(otherWorksheet, /<f>SUM\(&apos;Arkusz A&apos;!B2:B4\)<\/f>/)
  assert.doesNotMatch(otherWorksheet, /<v>300<\/v>/)
  assert.match(workbook, /<definedName name="LegacyRange">&apos;Arkusz A&apos;!\$B\$2:\$B\$4<\/definedName>/)
  assert.deepEqual(files['xl/styles.xml'], strToU8(legacyStyles))
  assert.deepEqual(
    files['xl/worksheets/_rels/sheet1.xml.rels'],
    syntheticTemplateFiles()['xl/worksheets/_rels/sheet1.xml.rels'],
  )
  assert.equal((drawing.match(/<xdr:row>3<\/xdr:row>/g) ?? []).length, 2)
})

test('row insertion shifts formula tokens, sheet ranges, and shared or array refs precisely', async () => {
  const { patchPanelWorkbook } = await workbookOoxml()
  const sourceWorksheet = strFromU8(syntheticTemplateFiles()['xl/worksheets/sheet1.xml'])
    .replace(
      '<c r="B4" s="7"><f>SUM(B2:B3)</f><v>300</v></c>',
      '<c r="B4" s="7"><f>LOG10(A10)+_A10+A10+SUM(B2:B10)+SUM(Table1[A10])+SUM(Table1[[#Headers],[B10]])+&quot;A10&quot;</f><v>300</v></c>'
        + '<c r="C4" s="7"><f t="shared" ref="C3:C10" si="0">SUM(&apos;Arkusz A&apos;!A3:A10)</f><v>9</v></c>'
        + '<c r="D4" s="7"><f t="array" ref="D2:D10">SUM(A2:A10)</f><v>9</v></c>',
    )
  const files = unzipSync(await patchPanelWorkbook(syntheticTemplate({
    'xl/worksheets/sheet1.xml': strToU8(sourceWorksheet),
  }), {
    sheets: [],
    metadata: panelMeta(),
    rowInsertions: [{
      sheet: 'Arkusz A',
      beforeRow: 3,
      rows: [{ cells: [{ type: 'text', value: 'Nowy' }] }],
    }],
  }, { sign: signingCallbacks.sign }))
  const worksheet = strFromU8(files['xl/worksheets/sheet1.xml'])
  const otherWorksheet = strFromU8(files['xl/worksheets/sheet2.xml'])

  assert.match(worksheet, /<c r="B5" s="7"><f>LOG10\(A11\)\+_A10\+A11\+SUM\(B2:B11\)\+SUM\(Table1\[A10\]\)\+SUM\(Table1\[\[#Headers\],\[B10\]\]\)\+&quot;A10&quot;<\/f><\/c>/)
  assert.match(worksheet, /<c r="C5" s="7"><f t="shared" ref="C4:C11" si="0">SUM\(&apos;Arkusz A&apos;!A4:A11\)<\/f><\/c>/)
  assert.match(worksheet, /<c r="D5" s="7"><f t="array" ref="D2:D11">SUM\(A2:A11\)<\/f><\/c>/)
  assert.match(otherWorksheet, /SUM\(&apos;Arkusz A&apos;!B2:B4\)/)
})

test('read verifies signed Meta and returns typed edits keyed by stable row IDs', async () => {
  const { readPanelWorkbook } = await workbookOoxml()
  const result = await readPanelWorkbook(await patchedPanelWorkbook(), {
    verify: signingCallbacks.verify,
  })

  assert.equal(result.kind, 'panel-v2')
  assert.deepEqual(result.metadata, panelMetadata())
  assert.deepEqual(result.edits, [{
    id: 'visit_1',
    sheet: 'Panel \u2014 Wizyty',
    values: {
      amountCents: 18_000,
      note: '=2+2',
      occurredOn: '2026-08-20',
      status: 'scheduled',
    },
  }])
  assert.deepEqual(result.voidIds, [])
})

test('tampered or missing signed Meta is rejected and never downgraded to legacy', async () => {
  const { readPanelWorkbook } = await workbookOoxml()
  const patched = await patchedPanelWorkbook()
  const tamperedFiles = unzipSync(patched)
  tamperedFiles['xl/sharedStrings.xml'] = strToU8(
    strFromU8(tamperedFiles['xl/sharedStrings.xml']).replace('centre_1', 'centre_2'),
  )
  await assert.rejects(readPanelWorkbook(zipSync(tamperedFiles), {
    verify: signingCallbacks.verify,
  }), /PANEL_META_SIGNATURE_INVALID/)

  const missingFiles = unzipSync(patched)
  missingFiles['xl/workbook.xml'] = strToU8(
    strFromU8(missingFiles['xl/workbook.xml']).replace('Panel \u2014 Meta', 'Panel \u2014 Metx'),
  )
  await assert.rejects(readPanelWorkbook(zipSync(missingFiles), {
    verify: signingCallbacks.verify,
  }), /PANEL_META_REQUIRED/)

  const extraMetaFiles = unzipSync(patched)
  extraMetaFiles['xl/worksheets/sheet9.xml'] = strToU8(
    strFromU8(extraMetaFiles['xl/worksheets/sheet9.xml']).replace(
      '</sheetData>',
      '<row r="4"><c r="A4" t="inlineStr"><is><t>unsigned-extra</t></is></c></row></sheetData>',
    ),
  )
  await assert.rejects(readPanelWorkbook(zipSync(extraMetaFiles), {
    verify: signingCallbacks.verify,
  }), /PANEL_META_INVALID/)

  const renamedFiles = unzipSync(patched)
  renamedFiles['xl/workbook.xml'] = strToU8(
    strFromU8(renamedFiles['xl/workbook.xml']).replaceAll('Panel \u2014 ', 'Archive \u2014 '),
  )
  await assert.rejects(readPanelWorkbook(zipSync(renamedFiles), {
    verify: signingCallbacks.verify,
  }), /PANEL_META_REQUIRED/)

  const legacy = await readPanelWorkbook(syntheticTemplate(), {
    verify: () => { throw new Error('legacy must not invoke verification') },
  })
  assert.deepEqual(legacy, {
    edits: [],
    kind: 'legacy',
    metadata: null,
    voidIds: [],
  })
})

const testXmlEscape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')

const sharedValuesFrom = (xml) => [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
  .map((match) => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((textMatch) => textMatch[1]
      .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'))
    .join(''))

const resaveSharedCellsAsInline = (xml, strings) => xml.replace(
  /<c\b([^>]*?)\bt="s"([^>]*)><v>(\d+)<\/v><\/c>/g,
  (_, before, after, index) => `<c${before}${after} t="inlineStr"><is><t>${testXmlEscape(strings[Number(index)])}</t></is></c>`,
)

const copyPackageFiles = (files) => Object.fromEntries(Object.entries(files)
  .map(([path, bytes]) => [path, new Uint8Array(bytes)]))

test('Meta verification survives client re-save representation and ZIP ordering changes', async () => {
  const { readPanelWorkbook } = await workbookOoxml()
  const files = unzipSync(await patchedPanelWorkbook())
  const strings = sharedValuesFrom(strFromU8(files['xl/sharedStrings.xml']))
  for (const path of Object.keys(files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))) {
    files[path] = strToU8(resaveSharedCellsAsInline(strFromU8(files[path]), strings))
  }
  const reversedFiles = Object.fromEntries(Object.entries(files).reverse())

  const result = await readPanelWorkbook(zipSync(reversedFiles, { level: 1 }), {
    verify: signingCallbacks.verify,
  })

  assert.equal(result.kind, 'panel-v2')
  assert.equal(result.metadata.scope.id, 'centre_1')
  assert.equal(result.edits[0].values.note, '=2+2')
})

test('signed inline Meta cannot be downgraded by removing shared strings and renaming Panel sheets', async () => {
  const { readPanelWorkbook } = await workbookOoxml()
  const files = unzipSync(await patchedPanelWorkbook())
  const strings = sharedValuesFrom(strFromU8(files['xl/sharedStrings.xml']))
  for (const path of Object.keys(files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))) {
    files[path] = strToU8(resaveSharedCellsAsInline(strFromU8(files[path]), strings))
  }
  delete files['xl/sharedStrings.xml']
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    strFromU8(files['xl/_rels/workbook.xml.rels']).replace(
      /<Relationship\b(?=[^>]*\/sharedStrings)[^>]*\/>/,
      '',
    ),
  )
  files['[Content_Types].xml'] = strToU8(
    strFromU8(files['[Content_Types].xml']).replace(
      /<Override\b(?=[^>]*\/xl\/sharedStrings\.xml)[^>]*\/>/,
      '',
    ),
  )
  files['xl/workbook.xml'] = strToU8(
    strFromU8(files['xl/workbook.xml']).replaceAll('Panel — ', 'Archive — '),
  )
  const dimensionVariants = Object.fromEntries(['expanded', 'malformed', 'missing']
    .map((name) => [name, copyPackageFiles(files)]))
  dimensionVariants.expanded['xl/worksheets/sheet9.xml'] = strToU8(
    strFromU8(dimensionVariants.expanded['xl/worksheets/sheet9.xml'])
      .replace('<dimension ref="A1:A3"/>', '<dimension ref="A1:C99"/>'),
  )
  dimensionVariants.malformed['xl/worksheets/sheet9.xml'] = strToU8(
    strFromU8(dimensionVariants.malformed['xl/worksheets/sheet9.xml'])
      .replace('<dimension ref="A1:A3"/>', '<dimension ref="not-a-range"/>'),
  )
  dimensionVariants.missing['xl/worksheets/sheet9.xml'] = strToU8(
    strFromU8(dimensionVariants.missing['xl/worksheets/sheet9.xml'])
      .replace('<dimension ref="A1:A3"/>', ''),
  )
  let verificationCalls = 0

  for (const candidateFiles of [files, dimensionVariants.expanded, dimensionVariants.missing]) {
    await assert.rejects(readPanelWorkbook(zipSync(candidateFiles), {
      verify: async (...args) => {
        verificationCalls++
        return signingCallbacks.verify(...args)
      },
    }), /PANEL_META_REQUIRED/)
  }
  await assert.rejects(readPanelWorkbook(zipSync(dimensionVariants.malformed), {
    verify: async (...args) => {
      verificationCalls++
      return signingCallbacks.verify(...args)
    },
  }), /PANEL_META_INVALID/)
  assert.equal(verificationCalls, 3)
})

test('malformed renamed inline Meta cannot be downgraded after shared-string compaction', async () => {
  const { readPanelWorkbook } = await workbookOoxml()
  const files = unzipSync(await patchedPanelWorkbook())
  const strings = sharedValuesFrom(strFromU8(files['xl/sharedStrings.xml']))
  for (const path of Object.keys(files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))) {
    files[path] = strToU8(resaveSharedCellsAsInline(strFromU8(files[path]), strings))
  }
  delete files['xl/sharedStrings.xml']
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    strFromU8(files['xl/_rels/workbook.xml.rels']).replace(
      /<Relationship\b(?=[^>]*\/sharedStrings)[^>]*\/>/,
      '',
    ),
  )
  files['[Content_Types].xml'] = strToU8(
    strFromU8(files['[Content_Types].xml']).replace(
      /<Override\b(?=[^>]*\/xl\/sharedStrings\.xml)[^>]*\/>/,
      '',
    ),
  )
  files['xl/workbook.xml'] = strToU8(
    strFromU8(files['xl/workbook.xml']).replaceAll('Panel — ', 'Archive — '),
  )
  const variants = Object.fromEntries([
    'bogusType', 'duplicateRow', 'invalidIndex', 'mismatchedRow', 'signature',
  ]
    .map((name) => [name, copyPackageFiles(files)]))
  variants.duplicateRow['xl/worksheets/sheet9.xml'] = strToU8(
    strFromU8(variants.duplicateRow['xl/worksheets/sheet9.xml'])
      .replace(
        '</sheetData>',
        '<row r="3"><c r="A3" t="inlineStr"><is><t>duplicate</t></is></c></row></sheetData>',
      ),
  )
  variants.invalidIndex['xl/worksheets/sheet9.xml'] = strToU8(
    strFromU8(variants.invalidIndex['xl/worksheets/sheet9.xml']).replace(
      /<c\b(?=[^>]*\br="A2")[^>]*>[\s\S]*?<\/c>/,
      '<c r="A2" t="s"><v>999999</v></c>',
    ),
  )
  variants.bogusType['xl/worksheets/sheet9.xml'] = strToU8(
    strFromU8(variants.bogusType['xl/worksheets/sheet9.xml']).replace(
      /<c\b(?=[^>]*\br="A2")[^>]*>[\s\S]*?<\/c>/,
      '<c r="A2" t="bogus"><v>1</v></c>',
    ),
  )
  variants.mismatchedRow['xl/worksheets/sheet9.xml'] = strToU8(
    strFromU8(variants.mismatchedRow['xl/worksheets/sheet9.xml'])
      .replace('<c r="A2"', '<c r="A4"'),
  )
  variants.signature['xl/worksheets/sheet9.xml'] = strToU8(
    strFromU8(variants.signature['xl/worksheets/sheet9.xml']).replace(
      /<c\b(?=[^>]*\br="A3")[^>]*>[\s\S]*?<\/c>/,
      '<c r="A3" t="inlineStr"><is><t>sig_tampered</t></is></c>',
    ),
  )
  let verificationCalls = 0

  await assert.rejects(readPanelWorkbook(zipSync(variants.duplicateRow), {
    verify: async (...args) => {
      verificationCalls++
      return signingCallbacks.verify(...args)
    },
  }), /WORKBOOK_ROW_INVALID|PANEL_META_INVALID/)
  await assert.rejects(readPanelWorkbook(zipSync(variants.invalidIndex), {
    verify: async (...args) => {
      verificationCalls++
      return signingCallbacks.verify(...args)
    },
  }), /WORKBOOK_SHARED_STRING_INVALID|PANEL_META_INVALID/)
  await assert.rejects(readPanelWorkbook(zipSync(variants.bogusType), {
    verify: async (...args) => {
      verificationCalls++
      return signingCallbacks.verify(...args)
    },
  }), /WORKBOOK_CELL_TYPE_INVALID|PANEL_META_INVALID/)
  await assert.rejects(readPanelWorkbook(zipSync(variants.mismatchedRow), {
    verify: async (...args) => {
      verificationCalls++
      return signingCallbacks.verify(...args)
    },
  }), /WORKBOOK_CELL_REFERENCE_INVALID|PANEL_META_INVALID/)
  await assert.rejects(readPanelWorkbook(zipSync(variants.signature), {
    verify: async (...args) => {
      verificationCalls++
      return signingCallbacks.verify(...args)
    },
  }), /PANEL_META_SIGNATURE_INVALID/)
  assert.equal(verificationCalls, 1)
})

test('ordinary visible legacy A1:A3 text is not a residual Meta candidate', async () => {
  const { readPanelWorkbook } = await workbookOoxml()
  const files = syntheticTemplateFiles()
  files['xl/worksheets/sheet2.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<dimension ref="A1:A3"/><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>Panel-v2</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>Ordinary note</t></is></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>Ordinary footer</t></is></c></row>'
      + '</sheetData></worksheet>',
  )

  assert.deepEqual(await readPanelWorkbook(zipSync(files), {
    verify: () => { throw new Error('legacy text must not invoke verification') },
  }), {
    edits: [],
    kind: 'legacy',
    metadata: null,
    voidIds: [],
  })
})

test('missing worksheet rows never imply void while signed explicit void IDs survive', async () => {
  const { readPanelWorkbook } = await workbookOoxml()
  const withoutRow = panelSheets().map((sheet) => sheet.name === 'Panel \u2014 Wizyty'
    ? { ...sheet, rows: [] }
    : sheet)
  const missingResult = await readPanelWorkbook(await patchedPanelWorkbook({
    sheets: withoutRow,
  }), { verify: signingCallbacks.verify })
  assert.deepEqual(missingResult.edits, [])
  assert.deepEqual(missingResult.voidIds, [])

  const voidResult = await readPanelWorkbook(await patchedPanelWorkbook({
    sheets: withoutRow,
    metadata: panelMetadata({ voidIds: ['visit_1'] }),
  }), { verify: signingCallbacks.verify })
  assert.deepEqual(voidResult.edits, [])
  assert.deepEqual(voidResult.voidIds, ['visit_1'])
})

test('scoped output rebuilds from explicit allowlists with compact strings and no recoverable leak', async () => {
  const { createScopedPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const sentinel = 'OUT_OF_SCOPE_SENTINEL'
  const metadata = panelMeta({
    scope: { type: 'specialist', id: 'specialist_allowed' },
    rows: [{
      id: 'visit_allowed', type: 'appointment', baseVersion: 1,
      fieldDigests: {
        calculated: 'digest_calculated_safe',
        note: 'digest_note_allowed_1',
      },
    }, {
      id: `visit_${sentinel}`, type: 'appointment', baseVersion: 2,
      fieldDigests: { note: 'digest_note_forbidden_1' },
    }, {
      id: `client_${sentinel}`, type: 'client', baseVersion: 3,
      fieldDigests: { name: 'digest_name_forbidden_1' },
    }],
    voidIds: [`client_${sentinel}`],
  })
  const sheets = [{
    name: 'Panel \u2014 Wizyty',
    columns: [
      { key: 'note', label: 'Notatka', type: 'text' },
      { key: 'calculated', label: 'Wyliczenie', type: 'formula' },
    ],
    rows: [{
      id: 'visit_allowed',
      values: {
        note: 'Bezpieczne',
        calculated: {
          formula: `IF(A3="${sentinel}",1,0)`,
          cached: sentinel,
        },
      },
    }, {
      id: `visit_${sentinel}`,
      values: { note: sentinel, calculated: { formula: '1+1', cached: 2 } },
    }],
  }, {
    name: 'Panel \u2014 Klienci',
    columns: [{ key: 'name', label: 'Osoba', type: 'text' }],
    rows: [{ id: `client_${sentinel}`, values: { name: sentinel } }],
  }, {
    name: 'Panel \u2014 Uprawnienia',
    columns: [{ key: 'name', label: 'To\u017csamo\u015b\u0107', type: 'text' }],
    rows: [{ id: `client_${sentinel}`, values: { name: sentinel } }],
  }]

  const scoped = await createScopedPanelWorkbook({
    allowedRowIds: ['visit_allowed'],
    allowedSheets: [{
      name: 'Panel \u2014 Wizyty',
      columns: [
        { key: 'note', label: 'Notatka', type: 'text' },
        { key: 'calculated', label: 'Wyliczenie', type: 'formula' },
      ],
    }],
    metadata,
    sheets,
  }, { sign: signingCallbacks.sign })
  const files = unzipSync(scoped)
  const allPartText = Object.entries(files).map(([path, bytes]) => `${path}\n${strFromU8(bytes)}`)
    .join('\n')
  const workbook = strFromU8(files['xl/workbook.xml'])
  const sharedStrings = strFromU8(files['xl/sharedStrings.xml'])
  const stringCount = sharedValuesFrom(sharedStrings).length
  const usedIndexes = [...Object.entries(files)
    .filter(([path]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .flatMap(([, bytes]) => [...strFromU8(bytes).matchAll(/<c\b[^>]*\bt="s"[^>]*><v>(\d+)<\/v><\/c>/g)]
      .map((match) => Number(match[1])))]

  assert.deepEqual(workbookSheetNames(workbook), ['Panel \u2014 Wizyty', 'Panel \u2014 Meta'])
  assert.match(workbook, /name="Panel \u2014 Meta"[^>]*state="veryHidden"/)
  assert.doesNotMatch(allPartText, new RegExp(sentinel))
  assert.doesNotMatch(allPartText, /<f\b/)
  assert.deepEqual([...new Set(usedIndexes)].sort((left, right) => left - right),
    Array.from({ length: stringCount }, (_, index) => index))
  const read = await readPanelWorkbook(scoped, { verify: signingCallbacks.verify })
  assert.deepEqual(read.metadata.rows.map(({ id }) => id), ['visit_allowed'])
  assert.deepEqual(read.metadata.voidIds, [])
  assert.deepEqual(read.edits, [{
    id: 'visit_allowed',
    sheet: 'Panel \u2014 Wizyty',
    values: { note: 'Bezpieczne' },
  }])
})

test('scoped output takes labels and fields only from the explicit authorized sheet schema', async () => {
  const { createScopedPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const labelSentinel = 'DYNAMIC_LABEL_SENTINEL'
  const fieldSentinel = 'UNAPPROVED_FIELD_SENTINEL'
  const metadata = panelMeta({
    rows: [{
      id: 'visit_allowed',
      type: 'appointment',
      baseVersion: 1,
      fieldDigests: {
        internalNote: `digest_${fieldSentinel}`,
        note: 'digest_note_allowed_1',
      },
    }],
  })
  const scoped = await createScopedPanelWorkbook({
    allowedRowIds: ['visit_allowed'],
    allowedSheets: [{
      name: 'Panel — Wizyty',
      columns: [{ key: 'note', label: 'Notatka zatwierdzona', type: 'text' }],
    }],
    metadata,
    sheets: [{
      name: 'Panel — Wizyty',
      columns: [
        { key: 'note', label: labelSentinel, type: 'text' },
        { key: 'internalNote', label: 'Pole wewnętrzne', type: 'text' },
      ],
      rows: [{
        id: 'visit_allowed',
        values: { internalNote: fieldSentinel, note: 'Bezpieczna notatka' },
      }],
    }],
  }, { sign: signingCallbacks.sign })
  const files = unzipSync(scoped)
  const allPartText = Object.values(files).map((bytes) => strFromU8(bytes)).join('\n')

  assert.doesNotMatch(allPartText, new RegExp(labelSentinel))
  assert.doesNotMatch(allPartText, new RegExp(fieldSentinel))
  assert.match(allPartText, /Notatka zatwierdzona/)
  const read = await readPanelWorkbook(scoped, { verify: signingCallbacks.verify })
  assert.deepEqual(read.metadata.rows[0].fieldDigests, {
    note: 'digest_note_allowed_1',
  })
  assert.deepEqual(read.edits, [{
    id: 'visit_allowed',
    sheet: 'Panel — Wizyty',
    values: { note: 'Bezpieczna notatka' },
  }])

  await assert.rejects(createScopedPanelWorkbook({
    allowedRowIds: ['visit_allowed'],
    allowedSheets: ['Panel — Wizyty'],
    metadata,
    sheets: [],
  }, { sign: signingCallbacks.sign }), /PANEL_SCOPED_SHEETS_INVALID/)
})

test('scoped Meta filters each row by its containing allowed sheet schema', async () => {
  const { createScopedPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const crossPolicySentinel = 'CROSS_POLICY_DIGEST_SENTINEL'
  const metadata = panelMeta({
    rows: [{
      id: 'visit_allowed',
      type: 'appointment',
      baseVersion: 1,
      fieldDigests: {
        clientName: `digest_${crossPolicySentinel}`,
        visitNote: 'digest_visit_note_1234',
      },
    }, {
      id: 'client_allowed',
      type: 'client',
      baseVersion: 2,
      fieldDigests: { clientName: 'digest_client_name_123' },
    }],
  })
  const allowedSheets = [{
    name: 'Panel — Wizyty',
    columns: [{ key: 'visitNote', label: 'Notatka', type: 'text' }],
  }, {
    name: 'Panel — Klienci',
    columns: [{ key: 'clientName', label: 'Klient', type: 'text' }],
  }]
  const sheets = [{
    name: 'Panel — Wizyty',
    columns: [
      { key: 'visitNote', label: 'Notatka źródłowa', type: 'text' },
      { key: 'clientName', label: 'Pole obce', type: 'text' },
    ],
    rows: [{
      id: 'visit_allowed',
      values: { clientName: 'Nie eksportuj', visitNote: 'Bezpieczna' },
    }],
  }, {
    name: 'Panel — Klienci',
    columns: [{ key: 'clientName', label: 'Klient źródłowy', type: 'text' }],
    rows: [{ id: 'client_allowed', values: { clientName: 'Dozwolony' } }],
  }]
  const scoped = await createScopedPanelWorkbook({
    allowedRowIds: ['client_allowed', 'visit_allowed'],
    allowedSheets,
    metadata,
    sheets,
  }, { sign: signingCallbacks.sign })
  const allPartText = Object.values(unzipSync(scoped)).map((bytes) => strFromU8(bytes)).join('\n')

  assert.doesNotMatch(allPartText, new RegExp(crossPolicySentinel))
  const read = await readPanelWorkbook(scoped, { verify: signingCallbacks.verify })
  assert.deepEqual(read.metadata.rows, [{
    baseVersion: 2,
    fieldDigests: { clientName: 'digest_client_name_123' },
    id: 'client_allowed',
    type: 'client',
  }, {
    baseVersion: 1,
    fieldDigests: { visitNote: 'digest_visit_note_1234' },
    id: 'visit_allowed',
    type: 'appointment',
  }])
  assert.deepEqual(read.edits, [{
    id: 'client_allowed',
    sheet: 'Panel — Klienci',
    values: { clientName: 'Dozwolony' },
  }, {
    id: 'visit_allowed',
    sheet: 'Panel — Wizyty',
    values: { visitNote: 'Bezpieczna' },
  }])
})

test('scoped output rejects a row contained by more than one allowed sheet', async () => {
  const { createScopedPanelWorkbook } = await workbookOoxml()
  const metadata = panelMeta({
    rows: [{
      id: 'shared_row',
      type: 'appointment',
      baseVersion: 1,
      fieldDigests: {
        clientName: 'digest_client_name_123',
        visitNote: 'digest_visit_note_1234',
      },
    }],
  })

  await assert.rejects(createScopedPanelWorkbook({
    allowedRowIds: ['shared_row'],
    allowedSheets: [{
      name: 'Panel — Wizyty',
      columns: [{ key: 'visitNote', label: 'Notatka', type: 'text' }],
    }, {
      name: 'Panel — Klienci',
      columns: [{ key: 'clientName', label: 'Klient', type: 'text' }],
    }],
    metadata,
    sheets: [{
      name: 'Panel — Wizyty',
      columns: [{ key: 'visitNote', label: 'Notatka', type: 'text' }],
      rows: [{ id: 'shared_row', values: { visitNote: 'Pierwszy' } }],
    }, {
      name: 'Panel — Klienci',
      columns: [{ key: 'clientName', label: 'Klient', type: 'text' }],
      rows: [{ id: 'shared_row', values: { clientName: 'Drugi' } }],
    }],
  }, { sign: signingCallbacks.sign }), /PANEL_SCOPED_ROW_SHEET_AMBIGUOUS/)
})

const withWorkbookRelationship = (relationship) => {
  const files = syntheticTemplateFiles()
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    strFromU8(files['xl/_rels/workbook.xml.rels'])
      .replace('</Relationships>', `${relationship}</Relationships>`),
  )
  return zipSync(files)
}

const duplicateArchivePath = (bytes, from, to) => {
  assert.equal(from.length, to.length)
  const result = new Uint8Array(bytes)
  const source = new TextEncoder().encode(from)
  const target = new TextEncoder().encode(to)
  let replacements = 0
  for (let offset = 0; offset <= result.length - source.length; offset++) {
    if (source.every((value, index) => result[offset + index] === value)) {
      result.set(target, offset)
      replacements++
      offset += source.length - 1
    }
  }
  assert.equal(replacements, 2)
  return result
}

test('all OOXML entry points reject the ZIP and active-content security corpus', async () => {
  const { patchPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const duplicateSource = zipSync({
    ...syntheticTemplateFiles(),
    'dup/a.txt': strToU8('one'),
    'dup/b.txt': strToU8('two'),
  })
  const malformedRelationship = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
  const externalRelationship = '<Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="https://example.test/source.xlsx" TargetMode="External"/>'
  const cases = [{
    name: 'macro',
    bytes: syntheticTemplate({ 'xl/vbaProject.bin': new Uint8Array([1]) }),
    code: 'WORKBOOK_MACRO_FORBIDDEN',
  }, {
    name: 'external relationship',
    bytes: withWorkbookRelationship(externalRelationship),
    code: 'WORKBOOK_EXTERNAL_RELATIONSHIP_FORBIDDEN',
  }, {
    name: 'duplicate relationship',
    bytes: withWorkbookRelationship(malformedRelationship),
    code: 'WORKBOOK_RELATIONSHIP_INVALID',
  }, {
    name: 'DDE formula',
    bytes: syntheticTemplate({
      'xl/worksheets/sheet1.xml': strToU8(
        strFromU8(syntheticTemplateFiles()['xl/worksheets/sheet1.xml'])
          .replace('SUM(B2:B3)', 'DDE(&quot;cmd&quot;,&quot;/c calc&quot;)'),
      ),
    }),
    code: 'WORKBOOK_FORMULA_FORBIDDEN',
  }, {
    name: 'HYPERLINK formula',
    bytes: syntheticTemplate({
      'xl/worksheets/sheet1.xml': strToU8(
        strFromU8(syntheticTemplateFiles()['xl/worksheets/sheet1.xml'])
          .replace('SUM(B2:B3)', 'HYPERLINK(&quot;#Arkusz A!A1&quot;,&quot;open&quot;)'),
      ),
    }),
    code: 'WORKBOOK_FORMULA_FORBIDDEN',
  }, {
    name: 'pipe-style DDE formula',
    bytes: syntheticTemplate({
      'xl/worksheets/sheet1.xml': strToU8(
        strFromU8(syntheticTemplateFiles()['xl/worksheets/sheet1.xml'])
          .replace('SUM(B2:B3)', "cmd|' /C calc'!A0"),
      ),
    }),
    code: 'WORKBOOK_FORMULA_FORBIDDEN',
  }, {
    name: 'WINWORD pipe-style DDE formula',
    bytes: syntheticTemplate({
      'xl/worksheets/sheet1.xml': strToU8(
        strFromU8(syntheticTemplateFiles()['xl/worksheets/sheet1.xml'])
          .replace('SUM(B2:B3)', "WINWORD|'System'!A1"),
      ),
    }),
    code: 'WORKBOOK_FORMULA_FORBIDDEN',
  }, {
    name: 'arbitrary-application pipe-style DDE formula',
    bytes: syntheticTemplate({
      'xl/worksheets/sheet1.xml': strToU8(
        strFromU8(syntheticTemplateFiles()['xl/worksheets/sheet1.xml'])
          .replace('SUM(B2:B3)', "ACMEAPP|'Topic'!Z9"),
      ),
    }),
    code: 'WORKBOOK_FORMULA_FORBIDDEN',
  }, {
    name: 'traversal path',
    bytes: syntheticTemplate({ '../escape.txt': strToU8('unsafe') }),
    code: 'WORKBOOK_ARCHIVE_PATH_INVALID',
  }, {
    name: 'duplicate path',
    bytes: duplicateArchivePath(duplicateSource, 'dup/b.txt', 'dup/a.txt'),
    code: 'WORKBOOK_ARCHIVE_DUPLICATE_PATH',
  }, {
    name: 'decompression bomb',
    bytes: syntheticTemplate({ 'xl/media/oversized.bin': new Uint8Array(26 * 1024 * 1024) }),
    code: 'WORKBOOK_DECOMPRESSED_SIZE_INVALID',
  }, {
    name: 'truncated archive',
    bytes: syntheticTemplate().subarray(0, syntheticTemplate().length - 8),
    code: 'WORKBOOK_ARCHIVE_INVALID',
  }]

  for (const { name, bytes, code } of cases) {
    await assert.rejects(readPanelWorkbook(bytes, {
      verify: signingCallbacks.verify,
    }), new RegExp(code), `${name} at the reader boundary`)
    await assert.rejects(patchPanelWorkbook(bytes, {
      sheets: [],
      metadata: panelMeta(),
    }, { sign: signingCallbacks.sign }), new RegExp(code), `${name} at the patch boundary`)
  }
})

test('generated formulas are explicit trusted inputs and reject external or executable syntax', async () => {
  const { patchPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  for (const formula of [
    'DDE("cmd","/c calc")',
    'HYPERLINK("#Panel — Wizyty!A1","open")',
    "'[external.xlsx]Sheet 1'!A1",
    'WEBSERVICE("https://example.test/leak")',
    "cmd|' /C calc'!A0",
    "WINWORD|'System'!A1",
    "ACMEAPP|'Topic'!Z9",
  ]) {
    const sheets = panelSheets()
    sheets[0].rows[0].values.total.formula = formula
    await assert.rejects(patchPanelWorkbook(syntheticTemplate(), {
      sheets,
      metadata: panelMetadata(),
    }, { sign: signingCallbacks.sign }), /WORKBOOK_FORMULA_FORBIDDEN/)
  }

  const safe = await patchedPanelWorkbook()
  assert.equal((await readPanelWorkbook(safe, {
    verify: signingCallbacks.verify,
  })).kind, 'panel-v2')

  for (const formula of [
    "'Visits|Archive'!A10",
    "'Owner''s Visits|Archive'!A10",
    'IF(A1="left|right",1,0)',
  ]) {
    const literalPipeSheets = panelSheets()
    literalPipeSheets[0].rows[0].values.total.formula = formula
    const literalPipe = await patchPanelWorkbook(syntheticTemplate(), {
      sheets: literalPipeSheets,
      metadata: panelMetadata(),
    }, { sign: signingCallbacks.sign })
    assert.equal((await readPanelWorkbook(literalPipe, {
      verify: signingCallbacks.verify,
    })).kind, 'panel-v2')
  }
})

test('re-patching Panel-v2 replaces generated sheets and removes revoked optional parts', async () => {
  const { patchPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const first = await patchedPanelWorkbook({ includePermissions: true })
  const updatedSheets = panelSheets().map((sheet) => sheet.name === 'Panel \u2014 Wizyty'
    ? {
        ...sheet,
        rows: sheet.rows.map((row) => ({
          ...row,
          values: { ...row.values, note: 'Zmienione' },
        })),
      }
    : sheet)
  const second = await patchPanelWorkbook(first, {
    includePermissions: false,
    metadata: panelMetadata({
      rows: panelMetadata().rows.map((row) => ({ ...row, baseVersion: 4 })),
    }),
    sheets: updatedSheets,
  }, { sign: signingCallbacks.sign })
  const files = unzipSync(second)
  const names = workbookSheetNames(strFromU8(files['xl/workbook.xml']))
  const contentTypes = strFromU8(files['[Content_Types].xml'])
  const overridePaths = [...contentTypes.matchAll(/<Override\b[^>]*\bPartName="\/([^"]+)"/g)]
    .map((match) => match[1])
  const sharedStrings = strFromU8(files['xl/sharedStrings.xml'])
  const declaredStringReferences = Number(/\bcount="(\d+)"/.exec(sharedStrings)?.[1])
  const actualStringReferences = Object.entries(files)
    .filter(([path]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .reduce((count, [, bytes]) => count
      + (strFromU8(bytes).match(/<c\b(?=[^>]*\bt="s")[^>]*>/g) ?? []).length, 0)

  assert.equal(new Set(names).size, names.length)
  assert.doesNotMatch(names.join('\n'), /Panel \u2014 Uprawnienia/)
  assert.ok(overridePaths.every((path) => files[path] instanceof Uint8Array))
  assert.equal(declaredStringReferences, actualStringReferences)
  assert.deepEqual(files['xl/styles.xml'], strToU8(legacyStyles))
  const read = await readPanelWorkbook(second, { verify: signingCallbacks.verify })
  assert.equal(read.metadata.rows[0].baseVersion, 4)
  assert.equal(read.edits[0].values.note, 'Zmienione')
})

test('re-patching can add permissions without colliding with retained Panel identities or parts', async () => {
  const { patchPanelWorkbook, readPanelWorkbook } = await workbookOoxml()
  const withoutPermissions = await patchedPanelWorkbook({ includePermissions: false })
  const withPermissions = await patchPanelWorkbook(withoutPermissions, {
    includePermissions: true,
    metadata: panelMetadata(),
    sheets: panelSheets(),
  }, { sign: signingCallbacks.sign })
  const files = unzipSync(withPermissions)
  const workbook = strFromU8(files['xl/workbook.xml'])
  const relationshipsXml = strFromU8(files['xl/_rels/workbook.xml.rels'])
  const attributes = (source) => Object.fromEntries(
    [...source.matchAll(/([A-Za-z:]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  )
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*?)\/>/g)].map((match) => attributes(match[1]))
  const relationships = [...relationshipsXml.matchAll(/<Relationship\b([^>]*?)\/>/g)]
    .map((match) => attributes(match[1]))
  const worksheetRelationships = relationships.filter(({ Type }) => Type.endsWith('/worksheet'))

  assert.equal(new Set(relationships.map(({ Id }) => Id)).size, relationships.length)
  assert.equal(new Set(sheets.map(({ sheetId }) => sheetId)).size, sheets.length)
  assert.equal(new Set(worksheetRelationships.map(({ Target }) => Target)).size,
    worksheetRelationships.length)
  assert.ok(worksheetRelationships.every(({ Target }) => files[`xl/${Target}`] instanceof Uint8Array))
  const summary = sheets.find(({ name }) => name === 'Panel — Podsumowanie')
  const summaryTarget = worksheetRelationships.find(({ Id }) => Id === summary['r:id']).Target
  assert.match(strFromU8(files[`xl/${summaryTarget}`]), /SUM\(/)
  assert.equal((await readPanelWorkbook(withPermissions, {
    verify: signingCallbacks.verify,
  })).kind, 'panel-v2')

  const revoked = await patchPanelWorkbook(withPermissions, {
    includePermissions: false,
    metadata: panelMetadata(),
    sheets: panelSheets(),
  }, { sign: signingCallbacks.sign })
  assert.doesNotMatch(
    workbookSheetNames(strFromU8(unzipSync(revoked)['xl/workbook.xml'])).join('\n'),
    /Panel — Uprawnienia/,
  )
})
