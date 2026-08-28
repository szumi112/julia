import { expect, test } from '@playwright/test'

const ORIGIN = 'http://127.0.0.1:5174'

const mutationHeaders = (csrfToken, idempotencyKey) => ({
  'Content-Type': 'application/json',
  'Idempotency-Key': idempotencyKey,
  'Origin': ORIGIN,
  'Sec-Fetch-Site': 'same-origin',
  'X-Correlation-Id': 'historical_routes_e2e',
  'X-CSRF-Token': csrfToken,
})

const expectNotFound = async (response) => {
  expect(response.status()).toBe(404)
  expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
}

test('@owner exposes the historical route surface on the isolated stage-E database', async ({
  request,
}) => {
  const sessionResponse = await request.get('/api/v1/session')
  expect(sessionResponse.status()).toBe(200)
  const session = await sessionResponse.json()
  const csrfToken = session.data.csrfToken

  await expectNotFound(await request.get(
    '/api/v1/workbooks/imports/wbi_e2e_missing/historical-projection',
  ))
  await expectNotFound(await request.post(
    '/api/v1/workbooks/imports/wbi_e2e_missing/historical-projection/continue',
    {
      data: { expectedVersion: 0 },
      headers: mutationHeaders(csrfToken, 'historical-e2e-continue-0001'),
    },
  ))
  await expectNotFound(await request.post(
    '/api/v1/workbooks/imports/wbi_e2e_missing/historical-projection/resolutions',
    {
      data: {
        expectedJobVersion: 1,
        conflictId: 'hcf_e2e_missing',
        classification: 'exclude',
        existingSubjectId: null,
        serviceId: null,
      },
      headers: mutationHeaders(csrfToken, 'historical-e2e-resolution-0001'),
    },
  ))
  await expectNotFound(await request.post(
    '/api/v1/historical-clients/hcl_e2e_missing/activation',
    {
      data: { expectedVersion: 1, specialistId: 'sp_zofia' },
      headers: mutationHeaders(csrfToken, 'historical-e2e-activation-0001'),
    },
  ))
})
