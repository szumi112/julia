import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { zipSync, strToU8 } from 'fflate'

import {
  scanXlsxSentinels,
  smokePersistenceEvidence,
} from '../../scripts/staging-smoke-runtime.mjs'

test('XLSX scanner proves in-scope presence and out-of-scope absence without returning content', () => {
  const clean = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/sharedStrings.xml': strToU8('<sst><t>FICTIONAL_OWN_42</t></sst>'),
  })
  assert.deepEqual(scanXlsxSentinels(clean, {
    inScopeSentinels: ['FICTIONAL_OWN_42'],
    outOfScopeSentinels: ['FICTIONAL_OTHER_99', 'RAW_SOURCE_PRIVATE'],
  }), { inScopePresent: true, outOfScopeAbsent: true })

  const leaking = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/sharedStrings.xml': strToU8('<sst>FICTIONAL_OWN_42 FICTIONAL_OTHER_99</sst>'),
  })
  assert.deepEqual(scanXlsxSentinels(leaking, {
    inScopeSentinels: ['FICTIONAL_OWN_42'],
    outOfScopeSentinels: ['FICTIONAL_OTHER_99'],
  }), { inScopePresent: true, outOfScopeAbsent: false })
})

test('XLSX scanner reconstructs rich-text runs and XML entities before leak matching', () => {
  for (const sharedStrings of [
    '<sst><si><r><t>FICTIONAL_</t></r><r><t>OTHER_99</t></r></si></sst>',
    '<sst><si><t>FICTIONAL&#95;OTHER&#95;99</t></si></sst>',
  ]) {
    const workbook = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/sharedStrings.xml': strToU8(sharedStrings),
    })
    assert.deepEqual(scanXlsxSentinels(workbook, {
      inScopeSentinels: ['FICTIONAL_OTHER_99'],
      outOfScopeSentinels: ['FICTIONAL_OTHER_99'],
    }), { inScopePresent: true, outOfScopeAbsent: false })
  }
  const attributeWorkbook = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8('<workbook><sheet name="FICTIONAL&amp;OTHER"/></workbook>'),
  })
  assert.deepEqual(scanXlsxSentinels(attributeWorkbook, {
    inScopeSentinels: ['FICTIONAL&OTHER'],
    outOfScopeSentinels: ['FICTIONAL&OTHER'],
  }), { inScopePresent: true, outOfScopeAbsent: false })
})

test('XLSX scanner normalizes Unicode content and includes ZIP entry names in leak evidence', () => {
  const sentinel = 'FICTIONAL_ÓLA_99'
  for (const { workbook, excluded } of [
    { workbook: zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/sharedStrings.xml': strToU8(`<sst><t>${sentinel.normalize('NFD')}</t></sst>`),
    }), excluded: sentinel },
    { workbook: zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/media/FICTIONAL_OTHER_99.bin': strToU8('opaque'),
    }), excluded: 'FICTIONAL_OTHER_99' },
  ]) {
    assert.equal(scanXlsxSentinels(workbook, {
      inScopeSentinels: ['opaque'], outOfScopeSentinels: [excluded],
    }).outOfScopeAbsent, false)
  }
})

test('browser persistence evidence requires every forbidden store to be exactly empty', () => {
  const clean = { local: 0, session: 0, databases: 0, caches: 0, workers: 0 }
  assert.deepEqual(smokePersistenceEvidence(clean), { empty: true })
  assert.deepEqual(smokePersistenceEvidence({ ...clean, caches: 1 }), { empty: false })
  assert.deepEqual(smokePersistenceEvidence({ ...clean, databases: 1 }), { empty: false })
  assert.throws(() => smokePersistenceEvidence({ ...clean, caches: -1 }),
    /^Error: STAGING_SMOKE_FAILED$/)
  assert.throws(() => smokePersistenceEvidence({ ...clean, extra: 0 }),
    /^Error: STAGING_SMOKE_FAILED$/)
})

test('smoke CLI refuses arguments and missing 0600 inputs before browser or network use', () => {
  for (const args of [[], ['--help']]) {
    const result = spawnSync(process.execPath, ['scripts/staging-smoke.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { PATH: process.env.PATH, APP_ENV: 'staging', DATA_MODE: 'fictional' },
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '{"status":"refused"}\n')
  }
})
