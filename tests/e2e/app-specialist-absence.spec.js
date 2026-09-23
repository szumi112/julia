import { expect, test } from '@playwright/test'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const specialist = {
  id: 'sp_anna', displayName: 'Anna Nowak', professionalTitle: 'Specjalistka',
  standardRateGrosze: 18_000, longRateGrosze: 25_000, specialization: '', status: 'active', version: 1, staffVersion: 1,
}

const workspace = (from, to) => ({
  window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
  specialists: [specialist],
  clients: [{
    id: 'cl_ola', name: 'Ola Aktywna', age: 12, status: 'active', version: 1,
    archivedAt: null, createdAt: '2026-01-10T09:00:00.000Z',
    updatedAt: '2026-01-10T09:00:00.000Z', readOnly: false,
    assignment: {
      id: 'asg_ola', specialistId: specialist.id,
      startsAt: '2026-01-10T09:00:00.000Z', version: 1,
    },
  }],
  appointments: [], historicalClients: [], historicalOccurrences: [], latestPopulatedMonth: null,
})

test('@owner manages whole-day absence on a phone and keeps the session warning local', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    const NativeDate = Date
    const frozenTime = new NativeDate('2026-08-04T10:00:00.000Z').getTime()
    class FrozenDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [frozenTime])) }
      static now() { return frozenTime }
    }
    FrozenDate.parse = NativeDate.parse
    FrozenDate.UTC = NativeDate.UTC
    window.Date = FrozenDate
  })
  await page.route('**/api/v1/session', (route) => route.fulfill(json(200, {
    data: {
      actor: {
        id: 'stf_absence_owner', displayName: 'Właścicielka', email: 'owner@example.test', professionalTitle: null,
        role: 'owner', specialistId: null, version: 1,
      },
      authorityRevision: 1,
      capabilities: ROLE_DEFAULT_CAPABILITIES.owner,
      csrfExpiresAt: '2030-01-01T00:00:00.000Z',
      csrfToken: `v1.${Date.parse('2030-01-01T00:00:00.000Z') / 1000}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      dataMode: 'fictional', environment: 'development',
    },
  })))
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(json(200, { data: workspace(url.searchParams.get('from'), url.searchParams.get('to')) }))
  })

  let absence = null
  const absenceRanges = []
  const mutations = []
  const appointmentPosts = []
  await page.route('**/api/v1/appointments', (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    appointmentPosts.push(body)
    const createdAt = '2026-08-04T10:00:00.000Z'
    return route.fulfill(json(201, {
      data: {
        appointment: {
          id: 'apt_absence_warning', clientId: body.clientId, specialistId: body.specialistId,
          serviceId: body.serviceId, startsAt: '2026-08-04T10:00:00.000Z',
          endsAt: '2026-08-04T11:00:00.000Z', timeZone: 'Europe/Warsaw', location: body.location,
          status: body.status, source: 'panel', version: 1, cancelledAt: null,
          cancellationReason: null,
          createdAt, updatedAt: createdAt,
          charge: {
            id: 'chg_absence_warning', serviceId: body.serviceId,
            expectedAmountGrosze: body.expectedAmountGrosze, currency: 'PLN', version: 1,
          },
          payment: {
            status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
            latestMethod: null, latestReceivedAt: null,
          },
          paymentEntries: [],
        },
      },
    }))
  })
  await page.route('**/api/v1/specialist-absences*', (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith('/cancellation')) {
      mutations.push({ kind: 'cancel', body: JSON.parse(request.postData() || '{}') })
      absence = { ...absence, version: 2, cancelledAt: '2026-08-04T10:00:00.000Z' }
      return route.fulfill(json(200, { data: { absence } }))
    }
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      mutations.push({ kind: 'create', body })
      absence = {
        id: 'abs_phone', specialistId: body.specialistId,
        dateFrom: body.dateFrom, dateTo: body.dateTo, allDay: body.allDay,
        version: 1, createdAt: '2026-08-04T10:00:00.000Z', cancelledAt: null,
      }
      return route.fulfill(json(201, { data: { absence } }))
    }
    absenceRanges.push({ from: url.searchParams.get('from'), to: url.searchParams.get('to') })
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    return route.fulfill(json(200, {
      data: {
        from, to,
        absences: absence && absence.cancelledAt === null
          && absence.dateFrom <= to && absence.dateTo >= from ? [absence] : [],
      },
    }))
  })
  await page.route('**/api/v1/specialist-absences/**', (route) => {
    mutations.push({ kind: 'cancel', body: JSON.parse(route.request().postData() || '{}') })
    absence = { ...absence, version: 2, cancelledAt: '2026-08-04T10:00:00.000Z' }
    return route.fulfill(json(200, { data: { absence } }))
  })

  await page.goto('./#/calendar?date=2026-08-04')
  await expect(page.getByRole('button', { name: 'Zaznacz wolne' })).toBeVisible()
  const initialRangeCount = absenceRanges.length

  await page.getByRole('button', { name: 'Zaznacz wolne' }).click()
  const absenceDialog = page.getByRole('dialog', { name: 'Zaznacz wolne' })
  await absenceDialog.getByLabel('Specjalistka').selectOption('sp_anna')
  await absenceDialog.getByLabel('Od').fill('2026-08-04')
  await absenceDialog.getByLabel('Do').fill('2026-08-05')
  await absenceDialog.getByRole('button', { name: 'Zapisz wolne' }).click()
  await expect(absenceDialog).toBeHidden()
  await expect(page.getByRole('button', { name: /Anuluj wolne - Anna Nowak/ })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Plan dnia' })
    .getByText('0 sesji · 1 nieobecność', { exact: true })).toBeVisible()
  await expect(page.locator('.day-strip__day[data-iso="2026-08-04"]'))
    .toHaveAccessibleName(/0 sesji · 1 nieobecność/)
  expect(mutations[0]).toEqual({
    kind: 'create',
    body: { specialistId: 'sp_anna', dateFrom: '2026-08-04', dateTo: '2026-08-05', allDay: true },
  })

  await page.locator('#main-content').getByRole('button', { name: 'Nowa sesja' }).click()
  const sessionDialog = page.getByRole('dialog', { name: 'Nowa sesja' })
  await expect(sessionDialog.getByRole('combobox', { name: 'Specjalistka' })).toHaveCount(0)
  await expect(sessionDialog.getByText('Prowadzi: Anna Nowak', { exact: true })).toBeVisible()
  await expect(sessionDialog).toContainText('Ta specjalistka ma zaznaczone wolne')
  await sessionDialog.getByLabel('Data').fill('2026-08-20')
  await expect(sessionDialog).not.toContainText('Ta specjalistka ma zaznaczone wolne')
  await page.waitForTimeout(200)
  expect(absenceRanges.length).toBeLessThanOrEqual(initialRangeCount + 2)
  await expect(page.getByRole('button', { name: /Anuluj wolne - Anna Nowak/ })).toBeVisible()

  await sessionDialog.getByLabel('Data').fill('2026-08-04')
  await expect(sessionDialog).toContainText('Ta specjalistka ma zaznaczone wolne')
  await sessionDialog.getByRole('combobox', { name: 'Klient' }).fill('Ola Aktywna')
  await sessionDialog.getByRole('combobox', { name: 'Klient' }).press('ArrowDown')
  await sessionDialog.getByRole('combobox', { name: 'Klient' }).press('Enter')
  await expect(page.getByText('Zaznaczono wolne w Grafiku')).toBeVisible()
  await sessionDialog.getByRole('button', { name: 'Dodaj sesję' }).click({ timeout: 1000 })
  await expect(sessionDialog).toBeHidden()
  expect(appointmentPosts).toHaveLength(1)
  expect(appointmentPosts[0]).toMatchObject({
    clientId: 'cl_ola', specialistId: 'sp_anna', serviceId: 'zajecia',
    date: '2026-08-04', time: '12:00', durationMinutes: 60,
    expectedAmountGrosze: 18_000, status: 'scheduled',
  })

  await page.getByRole('button', { name: /Anuluj wolne - Anna Nowak/ }).click()
  await expect(page.getByRole('button', { name: /Anuluj wolne - Anna Nowak/ })).toHaveCount(0)
  expect(mutations.at(-1)).toEqual({ kind: 'cancel', body: { expectedVersion: 1 } })
})
