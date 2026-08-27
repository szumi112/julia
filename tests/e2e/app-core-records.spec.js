import { test, expect } from '@playwright/test'

const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
const error = (status, code) => json(status, { error: { code } })

const freezeTime = async (page, iso = '2026-08-04T08:00:00.000Z') => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript((frozen) => {
    const NativeDate = Date
    const time = new NativeDate(frozen).getTime()
    class FrozenDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [time])) }
      static now() { return time }
    }
    FrozenDate.parse = NativeDate.parse
    FrozenDate.UTC = NativeDate.UTC
    window.Date = FrozenDate
  }, iso)
}

const specialist = (id, displayName, standardRateGrosze = 18_000) => ({
  id, displayName, standardRateGrosze, status: 'active', version: 1, staffVersion: 1,
})

const client = ({
  id, name, age = 11, specialistId = 'sp_anna', status = 'active', version = 1,
  archivedAt = null, createdAt = '2026-05-04T08:00:00.000Z', updatedAt = createdAt,
}) => ({
  id, name, age, status, version, archivedAt, createdAt, updatedAt,
  readOnly: status === 'archived',
  assignment: status === 'archived' ? null : {
    id: `asg_${id.slice(3)}`, specialistId, startsAt: createdAt, version: 1,
  },
})

const appointment = ({
  id = 'apt_iga', clientId = 'cl_iga', specialistId = 'sp_anna', status = 'scheduled',
  version = 1, startsAt = '2026-08-04T10:00:00.000Z', endsAt = '2026-08-04T10:50:00.000Z',
  paymentEntries = [], collectedGrosze = 0, expectedAmountGrosze = 18_000,
  createdAt = '2026-08-01T08:00:00.000Z',
  updatedAt = version === 1 ? createdAt : '2026-08-04T12:00:00.000Z',
  chargeVersion = 1,
}) => ({
  id, clientId, specialistId, serviceId: 'zajecia', startsAt, endsAt,
  timeZone: 'Europe/Warsaw', location: null, status, source: 'panel', version,
  cancelledAt: status === 'cancelled' ? '2026-08-04T09:00:00.000Z' : null,
  createdAt, updatedAt,
  charge: { id: `chg_${id.slice(4)}`, serviceId: 'zajecia', expectedAmountGrosze, currency: 'PLN', version: chargeVersion },
  payment: {
    status: collectedGrosze === 0 ? 'unpaid' : collectedGrosze === expectedAmountGrosze ? 'paid' : 'partial',
    collectedGrosze,
    outstandingGrosze: ['completed', 'noshow'].includes(status) ? expectedAmountGrosze - collectedGrosze : 0,
    latestMethod: paymentEntries.filter((entry) => entry.correctedAt === null).at(-1)?.method || null,
    latestReceivedAt: paymentEntries.filter((entry) => entry.correctedAt === null).at(-1)?.receivedAt || null,
  },
  paymentEntries,
})

const workspace = (from, to, { specialists, clients, appointments = [] }) => json(200, {
  data: {
    window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
    specialists, clients, appointments,
  },
})

const session = (actor, capabilities) => {
  const expiresAt = '2030-01-01T00:00:00.000Z'
  return json(200, { data: {
    actor, capabilities, csrfExpiresAt: expiresAt,
    csrfToken: `v1.${Date.parse(expiresAt) / 1000}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
    dataMode: 'fictional', environment: 'development',
  } })
}

const roleCapabilities = {
  owner: [
    'appointment.charge.read', 'appointment.manage', 'centre.manage', 'chat.direct', 'chat.general',
    'client.manage', 'client.operational.read', 'clinical.read', 'finance.centre.manage', 'finance.centre.read',
    'operations.health.read', 'payment.manage', 'security.audit.read', 'specialist.directory.read',
    'staff.manage', 'tus.manage',
  ],
  coordinator: [
    'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general',
    'client.manage', 'client.operational.read', 'finance.centre.read',
    'operations.health.read', 'payment.manage', 'specialist.directory.read', 'tus.manage',
  ],
  specialist: [
    'appointment.charge.read', 'appointment.manage', 'chat.direct', 'chat.general', 'client.manage',
    'client.operational.read', 'clinical.read', 'payment.manage', 'specialist.directory.read', 'tus.manage',
  ],
}

const noDurableBrowserState = (page) => page.evaluate(async () => ({
  caches: await caches.keys(),
  indexedDb: typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [],
  local: Object.keys(localStorage),
  serviceWorkers: (await navigator.serviceWorker.getRegistrations()).map(({ scope }) => scope),
  session: Object.keys(sessionStorage),
}))

const expectCommand = (route, { method, path, body }) => {
  const request = route.request()
  expect(request.method()).toBe(method)
  expect(new URL(request.url()).pathname).toBe(path)
  expect(request.postDataJSON()).toEqual(body)
}

test('@owner completes a fictional client, visit, payment, correction, and reload workflow without browser persistence', async ({ page }) => {
  await freezeTime(page)
  const writes = []
  const specialists = [specialist('sp_anna', 'Anna Nowak')]
  const createdClient = client({ id: 'cl_iga', name: 'Iga Próbna', age: 10, specialistId: 'sp_anna' })
  const scheduledVisit = appointment({})
  const completedVisit = appointment({ status: 'completed', version: 2, updatedAt: '2026-08-04T12:00:00.000Z' })
  const paidVisit = appointment({
    status: 'completed', version: 3, updatedAt: '2026-08-04T12:00:00.000Z', collectedGrosze: 12_000,
    paymentEntries: [{ id: 'pay_iga', amountGrosze: 12_000, method: 'card', receivedAt: '2026-08-04T10:00:00.000Z', correctedAt: null, replacementEntryId: null }],
  })
  const correctedVisit = appointment({
    status: 'completed', version: 4, updatedAt: '2026-08-04T12:00:00.000Z', collectedGrosze: 10_000,
    paymentEntries: [
      { id: 'pay_iga', amountGrosze: 12_000, method: 'card', receivedAt: '2026-08-04T10:00:00.000Z', correctedAt: '2026-08-04T12:00:00.000Z', replacementEntryId: 'pay_iga_replacement' },
      { id: 'pay_iga_replacement', amountGrosze: 10_000, method: 'transfer', receivedAt: '2026-08-05T10:00:00.000Z', correctedAt: null, replacementEntryId: null },
    ],
  })
  const noshowVisit = appointment({
    status: 'noshow', version: 5, updatedAt: '2026-08-04T12:00:00.000Z', collectedGrosze: 10_000,
    paymentEntries: correctedVisit.paymentEntries,
  })
  let clients = []
  let visit = null
  let appointmentEdits = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/')) writes.push(request.method())
  })
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), {
      specialists, clients, appointments: visit ? [visit] : [],
    }))
  })
  await page.route('**/api/v1/clients', (route) => {
    expectCommand(route, { method: 'POST', path: '/api/v1/clients', body: {
      name: 'Iga Próbna', age: 10, status: 'active', specialistId: 'sp_anna',
    } })
    clients = [createdClient]
    return route.fulfill(json(201, { data: { client: createdClient } }))
  })
  await page.route('**/api/v1/appointments', (route) => {
    expectCommand(route, { method: 'POST', path: '/api/v1/appointments', body: {
      clientId: 'cl_iga', specialistId: 'sp_anna', serviceId: 'zajecia', date: '2026-08-04',
      time: '12:00', durationMinutes: 50, expectedAmountGrosze: 18_000, location: null, status: 'scheduled',
    } })
    visit = scheduledVisit
    return route.fulfill(json(201, { data: { appointment: scheduledVisit } }))
  })
  await page.route('**/api/v1/appointments/apt_iga/edits', (route) => {
    appointmentEdits += 1
    const expected = appointmentEdits === 1 ? {
      expectedVersion: 1, specialistId: 'sp_anna', serviceId: 'zajecia', date: '2026-08-04',
      time: '12:00', durationMinutes: 50, expectedAmountGrosze: 18_000, location: null, status: 'completed',
    } : {
      expectedVersion: 4, specialistId: 'sp_anna', serviceId: 'zajecia', date: '2026-08-04',
      time: '12:00', durationMinutes: 50, expectedAmountGrosze: 18_000, location: null, status: 'noshow',
    }
    expectCommand(route, { method: 'POST', path: '/api/v1/appointments/apt_iga/edits', body: expected })
    visit = appointmentEdits === 1 ? completedVisit : noshowVisit
    return route.fulfill(json(200, { data: { appointment: visit } }))
  })
  await page.route('**/api/v1/appointments/apt_iga/payments', (route) => {
    expectCommand(route, { method: 'POST', path: '/api/v1/appointments/apt_iga/payments', body: {
      expectedVersion: 2, amountGrosze: 12_000, method: 'card', receivedAt: '2026-08-04T10:00:00.000Z',
    } })
    visit = paidVisit
    return route.fulfill(json(200, { data: { appointment: paidVisit } }))
  })
  await page.route('**/api/v1/payments/pay_iga/corrections', (route) => {
    expectCommand(route, { method: 'POST', path: '/api/v1/payments/pay_iga/corrections', body: {
      expectedVersion: 3, reason: 'Fikcyjna korekta', replacement: {
        amountGrosze: 10_000, method: 'transfer', receivedAt: '2026-08-05T10:00:00.000Z',
      },
    } })
    visit = correctedVisit
    return route.fulfill(json(200, { data: { appointment: correctedVisit } }))
  })

  await page.goto('./#/clients')
  await page.getByRole('button', { name: 'Dodaj klienta' }).first().click()
  const clientDrawer = page.getByRole('dialog', { name: 'Nowy klient' })
  await clientDrawer.getByLabel('Imię i nazwisko').fill('Iga Próbna')
  await clientDrawer.getByLabel('Wiek').fill('10')
  await clientDrawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await clientDrawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(page.getByText('Iga Próbna', { exact: true })).toBeVisible()

  await page.goto('./#/calendar?date=2026-08-04')
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  const visitDrawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await visitDrawer.getByLabel('Klient').selectOption('cl_iga')
  await visitDrawer.getByLabel('Godzina').fill('12:00')
  await visitDrawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await plan.getByRole('button', { name: 'Status: Zaplanowana — Iga Próbna, 12:00' }).click()
  await plan.getByRole('menuitemradio', { name: 'Odbyta' }).click()
  await expect.poll(() => appointmentEdits).toBe(1)
  await expect(plan.getByRole('button', { name: 'Status: Odbyta — Iga Próbna, 12:00' })).toBeVisible()

  await page.goto('./#/payments?ym=2026-08')
  const ledger = page.getByRole('table', { name: 'Lista rozliczeń' })
  await ledger.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
  const payment = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
  await payment.getByLabel('Kwota wpłaty').fill('120')
  await payment.getByLabel('Forma płatności').selectOption('card')
  await payment.getByLabel('Data wpłaty').fill('2026-08-04')
  await payment.getByRole('button', { name: 'Zapisz wpłatę' }).click()
  await ledger.getByRole('button', { name: /Skoryguj wpłatę/ }).click()
  const correction = page.getByRole('dialog', { name: 'Skoryguj wpłatę' })
  await correction.getByLabel('Powód korekty').fill('Fikcyjna korekta')
  await correction.getByLabel('Dodaj wpłatę zastępczą').check()
  await correction.getByLabel('Kwota zastępcza').fill('100')
  await correction.getByLabel('Forma zastępcza').selectOption('transfer')
  await correction.getByLabel('Data zastępcza').fill('2026-08-05')
  await correction.getByRole('button', { name: 'Zapisz korektę' }).click()
  await expect(ledger).toContainText('Skorygowana')

  await page.goto('./#/calendar?date=2026-08-04')
  await plan.getByRole('button', { name: 'Status: Odbyta — Iga Próbna, 12:00' }).click()
  await plan.getByRole('menuitemradio', { name: 'Nieobecność' }).click()
  await expect(plan.getByRole('button', { name: 'Status: Nieobecność — Iga Próbna, 12:00' })).toBeVisible()
  await page.goto('./#/payments?ym=2026-08')
  await page.reload()
  await expect(page.getByRole('table', { name: 'Lista rozliczeń' })).toContainText('100 zł')
  expect(writes).not.toContain('DELETE')
  expect(await noDurableBrowserState(page)).toEqual({ caches: [], indexedDb: [], local: [], serviceWorkers: [], session: [] })
})

test('@owner @coordinator keeps retained active practitioners in the exact 93-day directory on desktop and phone', async ({ page }, testInfo) => {
  await freezeTime(page)
  const reads = []
  const directory = [
    specialist('sp_owner_retained', 'Alicja Retencja'),
    specialist('sp_coordinator_retained', 'Celina Retencja'),
  ]
  const actor = testInfo.project.name === 'coordinator'
    ? { id: 'stf_coordinator_retained', displayName: 'Celina Testowa', role: 'coordinator', specialistId: 'sp_coordinator_retained', version: 1 }
    : { id: 'stf_owner_retained', displayName: 'Alicja Testowa', role: 'owner', specialistId: 'sp_owner_retained', version: 1 }
  let sessionReads = 0
  await page.route('**/api/v1/session', (route) => {
    sessionReads += 1
    return route.fulfill(session(actor, roleCapabilities[actor.role]))
  })
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    reads.push([url.searchParams.get('from'), url.searchParams.get('to')])
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), {
      specialists: directory, clients: [],
    }))
  })
  if (testInfo.project.name === 'coordinator') {
    await page.goto('./#/clients')
    await page.getByRole('button', { name: 'Dodaj klienta' }).first().click()
    const drawer = page.getByRole('dialog', { name: 'Nowy klient' })
    await expect(drawer.getByLabel('Specjalistka prowadząca').locator('option')).toHaveText([
      '— wybierz —', 'Alicja Retencja', 'Celina Retencja',
    ])
  } else for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto('./#/team')
    await expect(page.getByText('Alicja Retencja', { exact: true })).toBeVisible()
    await expect(page.getByText('Celina Retencja', { exact: true })).toBeVisible()
    await expect(page.getByText('Dostęp aktywny', { exact: true })).toHaveCount(2)
  }
  expect(sessionReads).toBe(1)
  expect(directory.map(({ id }) => id)).toContain(actor.specialistId)
  expect(reads).toContainEqual(['2026-05-04', '2026-08-04'])
})

test('@specialist renders only assigned clients and their own appointments', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', (route) => route.fulfill(session({
    id: 'stf_specialist_scope', displayName: 'Zofia Fikcyjna', role: 'specialist',
    specialistId: 'sp_anna', version: 1,
  }, roleCapabilities.specialist)))
  const own = client({ id: 'cl_own', name: 'Maja Własna', specialistId: 'sp_anna' })
  const foreign = client({ id: 'cl_foreign', name: 'Klientka Poza Zakresem', specialistId: 'sp_basia' })
  const ownAppointment = appointment({ id: 'apt_own', clientId: own.id, specialistId: 'sp_anna', status: 'completed' })
  const foreignAppointment = appointment({ id: 'apt_foreign', clientId: foreign.id, specialistId: 'sp_basia', status: 'completed' })
  let suppliedForeignScope = false
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    suppliedForeignScope = true
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), {
      specialists: [specialist('sp_anna', 'Anna Nowak'), specialist('sp_basia', 'Basia Zielińska')],
      clients: [foreign, own], appointments: [foreignAppointment, ownAppointment],
    }))
  })
  await page.goto('./#/clients')
  await expect(page.getByText('Maja Własna', { exact: true })).toBeVisible()
  expect(suppliedForeignScope).toBe(true)
  await expect(page.getByText('Klientka Poza Zakresem', { exact: true })).toHaveCount(0)
  await page.goto('./#/calendar?date=2026-08-04')
  await expect(page.getByRole('region', { name: 'Plan dnia' })).toContainText('Maja Własna')
  await expect(page.getByRole('region', { name: 'Plan dnia' })).not.toContainText('Klientka Poza Zakresem')
})

test('@owner renders a referenced archived client as phone read-only history', async ({ page }) => {
  await freezeTime(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const archived = client({
    id: 'cl_archived', name: 'Zofia Historyczna', status: 'archived', specialistId: null,
    createdAt: '2026-01-10T09:00:00.000Z', archivedAt: '2026-07-20T08:00:00.000Z',
    updatedAt: '2026-07-20T08:00:00.000Z', version: 2,
  })
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), {
      specialists: [specialist('sp_anna', 'Anna Nowak')], clients: [archived],
      appointments: [appointment({
        id: 'apt_history', clientId: archived.id, status: 'completed', version: 2,
        startsAt: '2026-07-15T08:30:00.000Z', endsAt: '2026-07-15T09:20:00.000Z',
        createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-16T08:00:00.000Z',
      })],
    }))
  })
  await page.goto('./#/client?id=cl_archived')
  await expect(page.getByRole('heading', { name: 'Zofia Historyczna' })).toBeVisible()
  await expect(page.getByText('Archiwalny', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edytuj' })).toHaveCount(0)
})

test('@owner keeps archive conflict explicit until cancellation makes archive legal', async ({ page }) => {
  await freezeTime(page)
  let clients = [client({ id: 'cl_archive', name: 'Iga Do Archiwum' })]
  let visit = appointment({ id: 'apt_archive', clientId: 'cl_archive', startsAt: '2026-08-04T10:00:00.000Z', endsAt: '2026-08-04T10:50:00.000Z' })
  let archiveAttempts = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), {
      specialists: [specialist('sp_anna', 'Anna Nowak')], clients, appointments: [visit],
    }))
  })
  await page.route('**/api/v1/clients/cl_archive/archive', (route) => {
    archiveAttempts += 1
    expectCommand(route, { method: 'POST', path: '/api/v1/clients/cl_archive/archive', body: { expectedVersion: 1 } })
    if (archiveAttempts === 1) return route.fulfill(error(409, 'CLIENT_ARCHIVE_CONFLICT'))
    const archived = client({ id: 'cl_archive', name: 'Iga Do Archiwum', status: 'archived', specialistId: null, version: 2, archivedAt: '2026-08-04T09:00:00.000Z', updatedAt: '2026-08-04T09:00:00.000Z' })
    clients = [archived]
    return route.fulfill(json(200, { data: { client: archived } }))
  })
  await page.route('**/api/v1/appointments/apt_archive/cancellation', (route) => {
    expectCommand(route, { method: 'POST', path: '/api/v1/appointments/apt_archive/cancellation', body: { expectedVersion: 1 } })
    const cancelled = appointment({ id: 'apt_archive', clientId: 'cl_archive', status: 'cancelled', version: 2, updatedAt: '2026-08-04T09:00:00.000Z' })
    visit = cancelled
    return route.fulfill(json(200, { data: { appointment: cancelled } }))
  })

  await page.goto('./#/client?id=cl_archive')
  await page.getByRole('button', { name: 'Edytuj' }).click()
  let drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByRole('button', { name: 'Archiwizuj klienta' }).click()
  await drawer.getByRole('button', { name: 'Tak, archiwizuj klienta' }).click()
  await expect(drawer.getByRole('alert')).toContainText('Nie udało się zarchiwizować klienta.')
  await drawer.getByRole('button', { name: 'Zamknij' }).click()

  await page.goto('./#/calendar?date=2026-08-04')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await plan.getByRole('button', { name: 'Status: Zaplanowana — Iga Do Archiwum, 12:00' }).click()
  await plan.getByRole('menuitemradio', { name: 'Odwołaj' }).click()
  await page.goto('./#/client?id=cl_archive')
  await page.getByRole('button', { name: 'Edytuj' }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByRole('button', { name: 'Archiwizuj klienta' }).click()
  await drawer.getByRole('button', { name: 'Tak, archiwizuj klienta' }).click()
  await expect(page).toHaveURL(/#\/clients/)
  expect(archiveAttempts).toBe(2)
})

test('@owner discards a stale second drawer while an offline draft remains open', async ({ page, context }) => {
  await freezeTime(page)
  let records = [client({ id: 'cl_stale', name: 'Ola Kanoniczna', version: 1 })]
  let edits = 0
  await context.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), {
      specialists: [specialist('sp_anna', 'Anna Nowak')], clients: records,
    }))
  })
  await context.route('**/api/v1/clients/cl_stale/edits', (route) => {
    edits += 1
    if (edits === 1) {
      expectCommand(route, { method: 'POST', path: '/api/v1/clients/cl_stale/edits', body: {
        expectedVersion: 1, name: 'Ola Zwycięska', age: 11, status: 'active', specialistId: 'sp_anna',
      } })
      const canonical = client({
        id: 'cl_stale', name: 'Ola Zwycięska', version: 2,
        updatedAt: '2026-08-04T12:00:00.000Z',
      })
      records = [canonical]
      return route.fulfill(json(200, { data: { client: canonical } }))
    }
    expectCommand(route, { method: 'POST', path: '/api/v1/clients/cl_stale/edits', body: {
      expectedVersion: 1, name: 'Ola Przestarzała', age: 11, status: 'active', specialistId: 'sp_anna',
    } })
    return route.fulfill(error(409, 'VERSION_CONFLICT'))
  })
  await page.goto('./#/client?id=cl_stale')
  const second = await context.newPage()
  await freezeTime(second)
  await second.goto('./#/client?id=cl_stale')
  await page.getByRole('button', { name: 'Edytuj' }).click()
  await page.getByRole('dialog', { name: 'Edycja klienta' }).getByLabel('Imię i nazwisko').fill('Ola Zwycięska')
  await second.getByRole('button', { name: 'Edytuj' }).click()
  await second.getByRole('dialog', { name: 'Edycja klienta' }).getByLabel('Imię i nazwisko').fill('Ola Przestarzała')
  await page.getByRole('dialog', { name: 'Edycja klienta' }).getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(page.getByRole('heading', { name: 'Ola Zwycięska' })).toBeVisible()
  expect(records).toMatchObject([{ name: 'Ola Zwycięska', version: 2 }])
  await second.getByRole('dialog', { name: 'Edycja klienta' }).getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(second.getByRole('dialog', { name: 'Edycja klienta' })).toHaveCount(0)
  await expect(second.getByRole('heading', { name: 'Ola Zwycięska' })).toBeVisible()
  await expect(second.getByText('Ola Przestarzała', { exact: true })).toHaveCount(0)
  expect(edits).toBe(2)

  await page.goto('./#/clients')
  await context.route('**/api/v1/clients', (route) => route.abort('connectionfailed'))
  await page.getByRole('button', { name: 'Dodaj klienta' }).click()
  const draft = page.getByRole('dialog', { name: 'Nowy klient' })
  await draft.getByLabel('Imię i nazwisko').fill('Iga Offline')
  await draft.getByLabel('Wiek').fill('9')
  await draft.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await draft.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(draft).toBeVisible()
  await expect(draft.getByLabel('Imię i nazwisko')).toHaveValue('Iga Offline')
  await second.close()
})

test('@owner clears loaded records and an open draft when the authority revision changes', async ({ page }) => {
  await freezeTime(page)
  let sessionCalls = 0
  await page.route('**/api/v1/session', (route) => {
    sessionCalls += 1
    return route.fulfill(sessionCalls === 1
      ? session({ id: 'stf_owner_switch', displayName: 'Alicja Testowa', role: 'owner', specialistId: null, version: 1 }, roleCapabilities.owner)
      : session({ id: 'stf_specialist_switch', displayName: 'Zofia Fikcyjna', role: 'specialist', specialistId: 'sp_anna', version: 2 }, roleCapabilities.specialist))
  })
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const afterSwitch = sessionCalls > 1
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), {
      specialists: [specialist('sp_anna', 'Anna Nowak')],
      clients: [client({ id: afterSwitch ? 'cl_new' : 'cl_old', name: afterSwitch ? 'Maja Po Zmianie' : 'Ola Przed Zmianą' })],
    }))
  })
  await page.goto('./#/clients')
  await expect(page.getByText('Ola Przed Zmianą', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Dodaj klienta' }).click()
  await page.getByRole('dialog', { name: 'Nowy klient' }).getByLabel('Imię i nazwisko').fill('Szkic Do Usunięcia')
  await page.evaluate(() => window.dispatchEvent(new Event('bwm:test-auth-refresh')))
  await expect(page.getByText('Zofia Fikcyjna', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Nowy klient' })).toHaveCount(0)
  await expect(page.getByText('Ola Przed Zmianą', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Maja Po Zmianie', { exact: true })).toBeVisible()
})
