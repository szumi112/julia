import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'

const syntheticWorkbook = () => zipSync({
  'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="SierpieńWrzesień" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`),
  'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1"
        Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
        Target="worksheets/sheet1.xml"/>
    </Relationships>`),
  'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1">
          <c r="A1" t="inlineStr"><is><t>Usługa</t></is></c>
          <c r="B1" t="inlineStr"><is><t>Cena</t></is></c>
          <c r="C1" t="inlineStr"><is><t>Klient</t></is></c>
          <c r="D1" t="inlineStr"><is><t>Data zakupu</t></is></c>
        </row>
        <row r="2">
          <c r="A2" t="inlineStr"><is><t>Konsultacja</t></is></c>
          <c r="B2"><v>180</v></c>
          <c r="C2" t="inlineStr"><is><t>Osoba Testowa</t></is></c>
          <c r="D2"><v>45524</v></c>
        </row>
      </sheetData>
    </worksheet>`),
})

test('audits an explicit local artifact against an explicit approved fingerprint', async () => {
  let auditWorkbook
  await assert.doesNotReject(async () => {
    ;({ auditWorkbook } = await import('../../scripts/audit-workbook-lib.mjs'))
  })
  const directory = await mkdtemp(join(tmpdir(), 'bwm-workbook-audit-'))
  try {
    const bytes = syntheticWorkbook()
    const sourcePath = join(directory, 'synthetic.xlsx')
    await writeFile(sourcePath, bytes)
    const fingerprint = createHash('sha256').update(bytes).digest('hex')
    const expected = {
      monthlyCandidates: 1,
      monthlyAccepted: 1,
      monthlyQuarantined: 0,
      fixedExpenses: 0,
      fixedRevenues: 0,
      tusRows: 0,
      englishRows: 0,
      acceptedTotal: 1,
      quarantinedTotal: 0,
      combinedAugustVisits: 1,
      combinedSeptemberVisits: 0,
      datedTusRows: 0,
      formulaGhostsExcluded: 0,
      amountStoredAsTextWarnings: 0,
    }

    const result = await auditWorkbook({
      sourcePath,
      expectedFingerprint: fingerprint,
      approvedFingerprint: fingerprint,
      expected,
    })

    assert.deepEqual(result.reconciliation, expected)
    assert.equal(result.fingerprint, fingerprint)
    assert.equal(result.parserVersion, 2)
    assert.equal(result.materializerVersion, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('refuses an artifact fingerprint outside the approved initial materialization', async () => {
  let auditWorkbook
  await assert.doesNotReject(async () => {
    ;({ auditWorkbook } = await import('../../scripts/audit-workbook-lib.mjs'))
  })

  await assert.rejects(auditWorkbook({
    sourcePath: '/tmp/not-read.xlsx',
    expectedFingerprint: 'b'.repeat(64),
    approvedFingerprint: 'a'.repeat(64),
    expected: {},
  }), /WORKBOOK_AUDIT_FINGERPRINT_REFUSED/)
})

test('the operational command requires explicit path and the one approved fingerprint', () => {
  const result = spawnSync(process.execPath, [
    new URL('../../scripts/audit-workbook.mjs', import.meta.url).pathname,
    '--path', '/tmp/not-read.xlsx',
    '--fingerprint', 'b'.repeat(64),
  ], { encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /WORKBOOK_AUDIT_FINGERPRINT_REFUSED/)
  assert.doesNotMatch(result.stderr, /not-read\.xlsx/)
})
