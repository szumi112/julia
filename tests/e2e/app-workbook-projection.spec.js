import { expect, test } from '@playwright/test'

const NOW = '2026-09-05T10:00:00.000Z'
const json = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify({ data }) })
const imported = {
  id: 'wbi_projection_browser', artifact: { id: 'wba_projection_browser', fingerprint: 'a'.repeat(64),
    byteSize: 4096, parserVersion: 2, materializerVersion: 2, createdAt: NOW },
  status: 'complete', version: 2, phase: 'complete', progress: { processed: 1, total: 1 },
  summary: { sourceCount: 1, quarantineCount: 0, conflictCount: 0, duplicateCount: 0, resolutionCount: 0 },
  resolutionVersion: 0, createdByStaffId: 'stf_local_owner', createdAt: NOW, updatedAt: NOW,
}
const projection = (kind, version, status = 'complete') => ({
  id: `${kind === 'historical' ? 'hpj' : 'apj'}_browser`, importId: imported.id, status,
  afterSourceRecordId: status === 'ready' ? null : 'wbs_browser', totalRecords: 1,
  processedRecords: status === 'ready' ? 0 : 1, projectedRecords: status === 'ready' ? 0 : 1,
  ...(kind === 'historical' ? { conflictCount: 0 } : {}),
  version, updatedAt: NOW, completedAt: status === 'complete' ? NOW : null,
})

test('@owner completes clients and activities after financial import and resumes after reload', async ({ page }) => {
  let historical = null
  let activity = null
  const calls = []
  await page.route('**/api/v1/workbooks/registry?*', (route) => route.fulfill(json({
    cursor: null, nextCursor: null, imports: [imported], exports: [], entries: [], complete: true,
  })))
  await page.route(`**/api/v1/workbooks/imports/${imported.id}/historical-projection`, (route) => (
    route.fulfill(json({ projection: historical, conflicts: [] }))
  ))
  await page.route(`**/api/v1/workbooks/imports/${imported.id}/activity-projection`, (route) => (
    route.fulfill(json({ job: activity }))
  ))
  for (const kind of ['historical', 'activity']) {
    await page.route(`**/api/v1/workbooks/imports/${imported.id}/${kind}-projection/continue`, (route) => {
      const { expectedVersion } = route.request().postDataJSON()
      calls.push([kind, expectedVersion])
      const next = projection(kind, expectedVersion + 1, expectedVersion === 0 ? 'ready' : 'complete')
      if (kind === 'historical') historical = next
      else activity = next
      return route.fulfill(json(kind === 'historical' ? { projection: next } : { job: next }, expectedVersion === 0 ? 201 : 200))
    })
  }
  await page.goto('./#/ledger')
  await page.getByRole('button', { name: 'Klienci i zajęcia', exact: true }).click()
  const review = page.getByRole('region', { name: 'Import klientów i zajęć' })
  await expect(review.getByText('Oczekuje', { exact: true })).toHaveCount(2)
  await expect(review.getByText('Finanse, historia klientów i zajęcia zostały zaimportowane.')).toHaveCount(0)
  await review.getByRole('button', { name: 'Kontynuuj import klientów i zajęć' }).click()
  await expect(review.getByText('Finanse, historia klientów i zajęcia zostały zaimportowane.')).toBeVisible()
  expect(calls).toEqual([['historical', 0], ['historical', 1], ['activity', 0], ['activity', 1]])
  await page.reload()
  await page.getByRole('button', { name: 'Klienci i zajęcia', exact: true }).click()
  await expect(review.getByText('Finanse, historia klientów i zajęcia zostały zaimportowane.')).toBeVisible()
  expect(calls).toHaveLength(4)
})

test('@owner explicitly classifies a source and preserves the identical decision after an uncertain save', async ({ page }) => {
  const context = { counterparty: 'Fikcyjny Podmiot', serviceLabel: 'Opis ze skoroszytu',
    proposedClassification: 'review', proposedServiceId: null, nearSubjectIds: [] }
  const conflict = { id: 'hcf_browser', sourceRecordId: 'wbs_browser', kind: 'classification', context }
  let historical = { ...projection('historical', 2, 'running'), status: 'conflicts',
    projectedRecords: 0, conflictCount: 1 }
  let unresolved = true
  const submissions = []
  await page.route('**/api/v1/workbooks/registry?*', (route) => route.fulfill(json({
    cursor: null, nextCursor: null, imports: [imported], exports: [], entries: [], complete: true,
  })))
  await page.route(`**/api/v1/workbooks/imports/${imported.id}/historical-projection`, (route) => (
    route.fulfill(json({ projection: historical, conflicts: unresolved ? [conflict] : [] }))
  ))
  await page.route(`**/api/v1/workbooks/imports/${imported.id}/activity-projection`, (route) => (
    route.fulfill(json({ job: projection('activity', 2) }))
  ))
  await page.route(`**/api/v1/workbooks/imports/${imported.id}/historical-projection/review-catalog`, (route) => (
    route.fulfill(json({ binding: { environment: 'staging', centreId: 'centre_1', fingerprint: 'a'.repeat(64),
      artifactId: imported.artifact.id, importId: imported.id, creatorId: imported.createdByStaffId,
      planDigest: `v1_${'A'.repeat(43)}` }, afterSourceRecordId: null, nextAfterSourceRecordId: null,
    directoryCount: 0, directoryDigest: 'b'.repeat(64), profiles: [], items: [{
      sourceRecordId: 'wbs_browser', kind: 'classification', conflictId: conflict.id,
      resolution: null, reviewContextDigest: 'c'.repeat(64), context,
    }] }))
  ))
  await page.route(`**/api/v1/workbooks/imports/${imported.id}/historical-projection/resolutions`, (route) => {
    submissions.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] })
    if (submissions.length === 1) return route.abort('failed')
    unresolved = false
    historical = { ...projection('historical', 3, 'running'), conflictCount: 1 }
    return route.fulfill(json({ projection: historical }, 201))
  })
  await page.route(`**/api/v1/workbooks/imports/${imported.id}/historical-projection/continue`, (route) => {
    historical = { ...projection('historical', 4), conflictCount: 1 }
    return route.fulfill(json({ projection: historical }))
  })
  await page.goto('./#/ledger')
  await page.getByRole('button', { name: 'Klienci i zajęcia', exact: true }).click()
  const review = page.getByRole('region', { name: 'Import klientów i zajęć' })
  await review.getByRole('button', { name: 'Kontynuuj import klientów i zajęć' }).click()
  await expect(review.getByRole('button', { name: 'Zapisz decyzję i kontynuuj' })).toBeDisabled()
  await review.getByLabel('Rodzaj podmiotu').selectOption('person')
  await review.getByLabel('Dopasowanie tożsamości').selectOption('new')
  await review.getByLabel('Usługa').selectOption('zajecia')
  await review.getByRole('button', { name: 'Zapisz decyzję i kontynuuj' }).click()
  await expect(review.getByRole('alert')).toContainText('Zachowano Twoje decyzje')
  await expect(review.getByLabel('Usługa')).toHaveValue('zajecia')
  await expect(review.getByLabel('Usługa')).toBeDisabled()
  await review.getByRole('button', { name: 'Ponów zapis tej samej decyzji' }).click()
  await expect(review.getByText('Finanse, historia klientów i zajęcia zostały zaimportowane.')).toBeVisible()
  expect(submissions).toHaveLength(2)
  expect(submissions[0]).toEqual(submissions[1])
  expect(submissions[0].body).toEqual({ expectedJobVersion: 2, conflictId: 'hcf_browser',
    classification: 'person', existingSubjectId: null, serviceId: 'zajecia',
    reviewContextDigest: 'c'.repeat(64), directoryCount: 0, directoryDigest: 'b'.repeat(64) })
})
