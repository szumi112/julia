import test from 'node:test'
import assert from 'node:assert/strict'
import * as review from '../../src/workbook-projection-review.js'

const job = { id: 'hpj_test', importId: 'wbi_test', status: 'running', afterSourceRecordId: null,
  totalRecords: 10, processedRecords: 2, projectedRecords: 1, conflictCount: 1, version: 2,
  updatedAt: '2026-09-05T10:00:00.000Z', completedAt: null }

test('projection completion requires both pipelines and rejects impossible job counters', () => {
  assert.equal(typeof review.captureProjectionJob, 'function')
  assert.equal(review.projectionsComplete({ status: 'complete' }, null), false)
  assert.equal(review.projectionsComplete({ status: 'complete' }, { status: 'running' }), false)
  assert.equal(review.projectionsComplete({ status: 'complete' }, { status: 'complete' }), true)
  assert.deepEqual(review.captureProjectionJob(job, 'wbi_test'), job)
  assert.throws(() => review.captureProjectionJob({ ...job, processedRecords: 11 }, 'wbi_test'))
  assert.throws(() => review.captureProjectionJob(job, 'wbi_other'))
  assert.throws(() => review.captureProjectionJob({ ...job, secret: 'unexpected' }, 'wbi_test'))
})

test('review decisions require explicit identity and service choices and preserve the context binding', () => {
  assert.equal(typeof review.captureProjectionResolution, 'function')
  const input = { expectedJobVersion: 2, conflictId: 'hcf_test', classification: 'person',
    existingSubjectId: null, serviceId: 'zajecia', reviewContextDigest: 'a'.repeat(64),
    directoryCount: 2, directoryDigest: 'b'.repeat(64) }
  assert.deepEqual(review.captureProjectionResolution(input), input)
  assert.throws(() => review.captureProjectionResolution({ ...input, classification: '' }))
  assert.throws(() => review.captureProjectionResolution({ ...input, serviceId: null }))
  assert.throws(() => review.captureProjectionResolution({ ...input, existingSubjectId: 'hcp_other' }))
  assert.throws(() => review.captureProjectionResolution({ ...input, directoryDigest: '' }))
})

test('review catalogs bind the import and pagination and reject unexpected nested fields without reading accessors', () => {
  const catalog = { binding: { environment: 'staging', centreId: 'centre_1', fingerprint: 'a'.repeat(64),
    artifactId: 'wba_test', importId: 'wbi_test', creatorId: 'stf_owner', planDigest: `v1_${'A'.repeat(43)}` },
  afterSourceRecordId: null, nextAfterSourceRecordId: null, directoryCount: 1, directoryDigest: 'b'.repeat(64),
  items: [{ sourceRecordId: 'wbs_test', kind: 'classification', conflictId: 'hcf_test', resolution: null,
    reviewContextDigest: 'c'.repeat(64), context: { counterparty: 'Fikcyjna Osoba', serviceLabel: 'Zajęcia',
      proposedClassification: 'review', proposedServiceId: 'zajecia', nearSubjectIds: ['hcl_other'] } }], profiles: [] }
  assert.deepEqual(review.captureProjectionCatalog(catalog, 'wbi_test', null), catalog)
  assert.throws(() => review.captureProjectionCatalog(catalog, 'wbi_other', null))
  assert.throws(() => review.captureProjectionCatalog(catalog, 'wbi_test', 'wbs_previous'))
  assert.throws(() => review.captureProjectionCatalog({ ...catalog, items: [catalog.items[0], catalog.items[0]] }, 'wbi_test', null))
  let reads = 0
  const hostile = { ...catalog, items: [{ ...catalog.items[0], context: {
    ...catalog.items[0].context, get counterparty() { reads += 1; return 'Fikcyjna Osoba' },
  } }] }
  assert.throws(() => review.captureProjectionCatalog(hostile, 'wbi_test', null))
  assert.equal(reads, 0)
})
