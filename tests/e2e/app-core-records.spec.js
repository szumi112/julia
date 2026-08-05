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
    'client.manage', 'client.operational.read', 'clinical.read', 'finance.centre.read',
    'operations.health.read', 'payment.manage', 'security.audit.read', 'specialist.directory.read',
    'staff.manage', 'tus.manage',
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

test('@owner completes a fictional client, visit, payment, correction, and reload workflow without browser persistence', async ({ page }) => {
  await freezeTime(page)
  const writes = []
  const specialists = [specialist('sp_anna', 'Anna Nowak')]
  const clients = []
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
    const body = route.request().postDataJSON()
    const created = client({ id: 'cl_iga', name: body.name, age: body.age, specialistId: body.specialistId })
    clients.push(created)
    return route.fulfill(json(201, { data: { client: created } }))
  })
  await page.route('**/api/v1/appointments', (route) => {
    const body = route.request().postDataJSON()
    visit = appointment({
      clientId: body.clientId, specialistId: body.specialistId, status: body.status,
      startsAt: '2026-08-04T10:00:00.000Z', endsAt: '2026-08-04T10:50:00.000Z',
    })
    return route.fulfill(json(201, { data: { appointment: visit } }))
  })
  await page.route('**/api/v1/appointments/apt_iga/edits', (route) => {
    appointmentEdits += 1
    const body = route.request().postDataJSON()
    visit = appointment({
      ...visit, status: body.status, version: visit.version + 1,
      paymentEntries: visit.paymentEntries, collectedGrosze: visit.payment.collectedGrosze,
      updatedAt: '2026-08-04T12:00:00.000Z',
    })
    return route.fulfill(json(200, { data: { appointment: visit } }))
  })
  await page.route('**/api/v1/appointments/apt_iga/payments', (route) => {
    const body = route.request().postDataJSON()
    visit = appointment({
      ...visit, version: visit.version + 1, status: visit.status, collectedGrosze: body.amountGrosze,
      paymentEntries: [{ id: 'pay_iga', amountGrosze: body.amountGrosze, method: body.method, receivedAt: body.receivedAt, correctedAt: null, replacementEntryId: null }],
      updatedAt: '2026-08-04T12:00:00.000Z',
    })
    return route.fulfill(json(200, { data: { appointment: visit } }))
  })
  await page.route('**/api/v1/payments/pay_iga/corrections', (route) => {
    const body = route.request().postDataJSON()
    const replacement = body.replacement
    visit = appointment({
      ...visit, version: visit.version + 1, status: visit.status, collectedGrosze: replacement.amountGrosze,
      paymentEntries: [
        { ...visit.paymentEntries[0], correctedAt: '2026-08-04T12:00:00.000Z', replacementEntryId: 'pay_iga_replacement' },
        { id: 'pay_iga_replacement', amountGrosze: replacement.amountGrosze, method: replacement.method, receivedAt: replacement.receivedAt, correctedAt: null, replacementEntryId: null },
      ],
      updatedAt: '2026-08-04T12:00:00.000Z',
    })
    return route.fulfill(json(200, { data: { appointment: visit } }))
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
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    reads.push([url.searchParams.get('from'), url.searchParams.get('to')])
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), {
      specialists: [
        specialist('sp_owner_retained', 'Alicja Retencja'),
        specialist('sp_coordinator_retained', 'Celina Retencja'),
      ], clients: [],
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
    await expect(page.getByText('Dostępna do planowania wizyt', { exact: true })).toHaveCount(2)
  }
  expect(reads).toContainEqual(['2026-05-04', '2026-08-04'])
})

test('@specialist renders only assigned clients and their own appointments', async ({ page }) => {
  await freezeTime(page)
  await page.route('**/api/v1/session', (route) => route.fulfill(session({
    id: 'stf_specialist_scope', displayName: 'Zofia Fikcyjna', role: 'specialist',
    specialistId: 'sp_anna', version: 1,
  }, roleCapabilities.specialist)))
  const own = client({ id: 'cl_own', name: 'Maja Własna', specialistId: 'sp_anna' })
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), {
      specialists: [specialist('sp_anna', 'Anna Nowak')], clients: [own],
      appointments: [appointment({ id: 'apt_own', clientId: own.id, specialistId: 'sp_anna', status: 'completed' })],
    }))
  })
  await page.goto('./#/clients')
  await expect(page.getByText('Maja Własna', { exact: true })).toBeVisible()
  await expect(page.getByText('Klientka Poza Zakresem', { exact: true })).toHaveCount(0)
  await page.goto('./#/calendar?date=2026-08-04')
  await expect(page.getByRole('region', { name: 'Plan dnia' })).toContainText('Maja Własna')
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
  const clients = [client({ id: 'cl_archive', name: 'Iga Do Archiwum' })]
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
    if (archiveAttempts === 1) return route.fulfill(error(409, 'CLIENT_ARCHIVE_CONFLICT'))
    clients.splice(0, 1, client({ id: 'cl_archive', name: 'Iga Do Archiwum', status: 'archived', specialistId: null, version: 2, archivedAt: '2026-08-04T09:00:00.000Z', updatedAt: '2026-08-04T09:00:00.000Z' }))
    return route.fulfill(json(200, { data: { client: clients[0] } }))
  })
  await page.route('**/api/v1/appointments/apt_archive/cancellation', (route) => {
    visit = appointment({ ...visit, status: 'cancelled', version: 2, updatedAt: '2026-08-04T09:00:00.000Z' })
    return route.fulfill(json(200, { data: { appointment: visit } }))
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
  const records = [client({ id: 'cl_stale', name: 'Ola Kanoniczna', version: 1 })]
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
      const body = route.request().postDataJSON()
      records.splice(0, 1, client({
        id: 'cl_stale', name: body.name, version: 2,
        updatedAt: '2026-08-04T12:00:00.000Z',
      }))
      return route.fulfill(json(200, { data: { client: records[0] } }))
    }
    return route.fulfill(error(409, 'VERSION_CONFLICT'))
  })
  await page.goto('./#/client?id=cl_stale')
  const second = await context.newPage()
  await freezeTime(second)
  await second.goto('./#/client?id=cl_stale')
  for (const current of [page, second]) {
    await current.getByRole('button', { name: 'Edytuj' }).click()
    await current.getByRole('dialog', { name: 'Edycja klienta' }).getByLabel('Imię i nazwisko').fill('Ola Lokalna')
  }
  await page.getByRole('dialog', { name: 'Edycja klienta' }).getByRole('button', { name: 'Zapisz zmiany' }).click()
  await second.getByRole('dialog', { name: 'Edycja klienta' }).getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(second.getByRole('dialog', { name: 'Edycja klienta' })).toHaveCount(0)
  await expect(second.getByRole('heading', { name: 'Ola Lokalna' })).toBeVisible()

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
