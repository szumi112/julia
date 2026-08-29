import assert from 'node:assert/strict'
import test from 'node:test'

import { createFinanceRepository } from '../../src/finance-repository.js'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const METHOD_NAMES = [
  'loadFinanceWindow', 'loadRegistryPage', 'loadRegistryDetail', 'previewWorkbook',
  'createWorkbookImport', 'continueWorkbookImport', 'getWorkbookImport',
  'recordWorkbookResolutions', 'exportWorkbook', 'voidLedgerEntry',
]

const dependencyNames = [
  'loadFinanceWindow', 'loadWorkbookRegistry', 'loadWorkbookRegistryDetail',
  'previewWorkbook', 'createWorkbookImport', 'continueWorkbookImport',
  'getWorkbookImport', 'recordWorkbookResolutions', 'exportWorkbook', 'voidLedgerEntry',
]

const makeDependency = (implementation = {}) => Object.fromEntries(dependencyNames.map((name) => [
  name, implementation[name] ?? (async () => ({ method: name })),
]))

test('finance repository exposes only the frozen stateless Task 11 surface', () => {
  const repository = createFinanceRepository(makeDependency())

  assert.deepEqual(Object.keys(repository), METHOD_NAMES)
  assert.ok(Object.isFrozen(repository))
  assert.equal(Object.getPrototypeOf(repository), Object.prototype)
})

test('finance repository captures exact inputs and signals before delegating', async () => {
  const calls = []
  const dependency = makeDependency(Object.fromEntries(dependencyNames.map((name) => [
    name, async (...args) => {
      calls.push({ name, args })
      return { name, nested: { accepted: true } }
    },
  ])))
  const repository = createFinanceRepository(dependency)
  const signal = new AbortController().signal
  const resolutions = [{ conflictId: 'wmc_resolution_one', specialistId: 'sp_anna' }]
  const file = new File([new Uint8Array([80, 75, 3, 4])], 'fikcyjny.xlsx', { type: XLSX })

  const results = await Promise.all([
    repository.loadFinanceWindow({ selectedMonth: '2026-08' }, { signal }),
    repository.loadRegistryPage({ cursor: null, section: 'all' }, { signal }),
    repository.loadRegistryDetail({ importId: 'wbi_import_one', section: 'source', cursor: null }, { signal }),
    repository.previewWorkbook(file, { signal }),
    repository.createWorkbookImport(file, `v1.1.${'A'.repeat(86)}.${'B'.repeat(43)}`, resolutions, {
      idempotencyKey: 'workbook-import-key-0001', signal,
    }),
    repository.continueWorkbookImport('wbi_import_one', 2, {
      idempotencyKey: 'workbook-continue-key-0001', signal,
    }),
    repository.getWorkbookImport('wbi_import_one', { signal }),
    repository.recordWorkbookResolutions('wbi_import_one', {
      expectedVersion: 2, planDigest: `v1_${'C'.repeat(43)}`, resolutions,
    }, { idempotencyKey: 'workbook-resolution-key-0001', signal }),
    repository.voidLedgerEntry('fin_entry_one', 2, 'Błędna pozycja', {
      idempotencyKey: 'finance-void-key-0001', signal,
    }),
  ])
  resolutions[0].specialistId = 'sp_changed_after_call'

  assert.deepEqual(calls.map(({ name }) => name), dependencyNames.filter(
    (name) => name !== 'exportWorkbook',
  ))
  assert.equal(calls[3].args[0], file)
  assert.equal(calls[4].args[0], file)
  assert.deepEqual(calls[4].args[2], [
    { conflictId: 'wmc_resolution_one', specialistId: 'sp_anna' },
  ])
  assert.equal(calls[0].args[1].signal, signal)
  assert.equal(calls[7].args[2].signal, signal)
  for (const result of results) {
    assert.ok(Object.isFrozen(result))
    assert.ok(Object.isFrozen(result.nested))
  }
})

test('finance repository export keeps idempotency internal and returns only frozen Blob metadata', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4])
  const calls = []
  const repository = createFinanceRepository(makeDependency({
    exportWorkbook: async (...args) => {
      calls.push(args)
      return { bytes, filename: 'bear-with-me-panel-v2.xlsx' }
    },
  }))
  const signal = new AbortController().signal

  const result = await repository.exportWorkbook({ format: 'panel-v2' }, { signal })

  assert.deepEqual(calls, [[{ format: 'panel-v2' }, { signal }]])
  assert.deepEqual(Object.keys(result), ['blob', 'filename'])
  assert.ok(result.blob instanceof Blob)
  assert.equal(result.blob.type, XLSX)
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), new Uint8Array([80, 75, 3, 4]))
  assert.deepEqual(bytes, new Uint8Array(4))
  assert.ok(Object.isFrozen(result))
  await assert.rejects(repository.exportWorkbook(
    { format: 'panel-v2' }, { signal, idempotencyKey: 'must-not-cross' },
  ), { message: 'CLIENT_INPUT_INVALID' })
})

test('finance repository wipes export bytes when result validation or Blob creation fails', async () => {
  const invalidFilenameBytes = new Uint8Array([80, 75, 3, 4])
  const invalidFilenameRepository = createFinanceRepository(makeDependency({
    exportWorkbook: async () => ({
      bytes: invalidFilenameBytes, filename: '../source-workbook.xlsx',
    }),
  }))
  await assert.rejects(
    invalidFilenameRepository.exportWorkbook({ format: 'panel-v2' }),
    { message: 'CLIENT_RESULT_INVALID' },
  )
  assert.deepEqual(invalidFilenameBytes, new Uint8Array(4))

  const throwingBlobBytes = new Uint8Array([80, 75, 3, 4])
  const throwingBlobRepository = createFinanceRepository(makeDependency({
    exportWorkbook: async () => ({
      bytes: throwingBlobBytes, filename: 'bear-with-me-panel-v2.xlsx',
    }),
  }))
  const OriginalBlob = globalThis.Blob
  globalThis.Blob = class ThrowingBlob {
    constructor() { throw new Error('blob-construction-failed') }
  }
  try {
    await assert.rejects(
      throwingBlobRepository.exportWorkbook({ format: 'panel-v2' }),
      { message: 'CLIENT_RESULT_INVALID' },
    )
  } finally {
    globalThis.Blob = OriginalBlob
  }
  assert.deepEqual(throwingBlobBytes, new Uint8Array(4))
})

test('finance repository rejects missing dependencies and hostile or extra public keys', async () => {
  assert.throws(() => createFinanceRepository({}), { message: 'CLIENT_DEPENDENCY_INVALID' })
  const repository = createFinanceRepository(makeDependency())
  const hostile = Object.defineProperty({}, 'selectedMonth', {
    enumerable: true, get() { throw new Error('secret') },
  })

  await assert.rejects(repository.loadFinanceWindow(hostile), {
    message: 'CLIENT_INPUT_INVALID',
  })
  await assert.rejects(repository.loadFinanceWindow({ selectedMonth: '2000-05' }), {
    message: 'CLIENT_INPUT_INVALID',
  })
  await assert.rejects(repository.loadRegistryPage({
    cursor: null, section: 'all', scope: 'centre',
  }), { message: 'CLIENT_INPUT_INVALID' })
  await assert.doesNotReject(repository.loadRegistryPage({
    cursor: null, section: 'unknown',
  }))
  await assert.rejects(repository.previewWorkbook(new Blob([new Uint8Array([1])])), {
    message: 'CLIENT_INPUT_INVALID',
  })
})

test('finance repository never evaluates hostile option, resolution or result accessors', async () => {
  let delegated = 0
  const repository = createFinanceRepository(makeDependency({
    createWorkbookImport: async () => { delegated += 1; return {} },
    loadFinanceWindow: async () => {
      const hostile = []
      Object.defineProperty(hostile, 0, {
        enumerable: true, get() { throw new Error('raw-result-secret') },
      })
      return hostile
    },
  }))
  const file = new File([new Uint8Array([80, 75, 3, 4])], 'fikcyjny.xlsx', { type: XLSX })
  const hostileSignal = Object.defineProperty({}, 'aborted', {
    enumerable: true, get() { throw new Error('raw-signal-secret') },
  })
  const hostileResolutions = []
  Object.defineProperty(hostileResolutions, 0, {
    enumerable: true, get() { throw new Error('raw-resolution-secret') },
  })
  hostileResolutions.length = 1

  await assert.rejects(repository.previewWorkbook(file, { signal: hostileSignal }), {
    message: 'CLIENT_INPUT_INVALID',
  })
  await assert.rejects(repository.createWorkbookImport(
    file, `v1.1.${'A'.repeat(86)}.${'B'.repeat(43)}`, hostileResolutions,
    { idempotencyKey: 'workbook-import-key-0001' },
  ), { message: 'CLIENT_INPUT_INVALID' })
  await assert.rejects(repository.loadFinanceWindow({ selectedMonth: '2026-08' }), {
    message: 'CLIENT_RESULT_INVALID',
  })
  assert.equal(delegated, 0)
})
