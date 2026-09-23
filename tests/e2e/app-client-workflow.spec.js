import { test, expect } from '@playwright/test'

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const freezeTime = async (page, iso) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript((frozen) => {
    const NativeDate = Date
    const frozenTime = new NativeDate(frozen).getTime()
    class FrozenDate extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [frozenTime]))
      }

      static now() {
        return frozenTime
      }
    }
    FrozenDate.parse = NativeDate.parse
    FrozenDate.UTC = NativeDate.UTC
    window.Date = FrozenDate
  }, iso)
}

const selectSessionClient = async (drawer, name) => {
  const input = drawer.getByRole('combobox', { name: 'Klient' })
  await input.fill(name)
  await input.press('ArrowDown')
  await input.press('Enter')
}

const specialists = [
  {
    id: 'sp_anna', displayName: 'Anna Nowak', professionalTitle: 'Specjalistka',
    standardRateGrosze: 18_000,
    status: 'active', version: 3, staffVersion: 4,
  },
  {
    id: 'sp_basia', displayName: 'Basia Zielińska', professionalTitle: 'Specjalistka',
    standardRateGrosze: 19_000,
    status: 'active', version: 2, staffVersion: 3,
  },
]

const client = ({
  id, name, age, status = 'active', version = 1, specialistId = 'sp_anna',
  archivedAt = null, createdAt = '2026-01-10T09:00:00.000Z',
  updatedAt = createdAt,
}) => ({
  id, name, age, status, version, archivedAt, createdAt, updatedAt,
  readOnly: status === 'archived',
  assignment: status === 'archived'
    ? null
    : {
        id: `asg_${id.slice(3)}`, specialistId,
        startsAt: createdAt, version: 1,
      },
})

const workspace = (
  from, to, clients, appointments = [], directory = specialists,
  historicalClients = [], historicalOccurrences = [],
) => json(200, {
  data: {
    window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
    specialists: directory,
    clients: clients.toSorted((left, right) => left.name.localeCompare(right.name, 'pl')),
    appointments,
    historicalClients,
    historicalOccurrences,
    latestPopulatedMonth: historicalOccurrences.length > 0
      ? historicalOccurrences.map((occurrence) => occurrence.period.month).filter(Boolean).sort().at(-1)
      : null,
  },
})

const historyAppointment = {
  id: 'apt_history', clientId: 'cl_archived', specialistId: 'sp_anna',
  serviceId: 'zajecia', startsAt: '2026-07-15T08:30:00.000Z',
  endsAt: '2026-07-15T09:20:00.000Z', timeZone: 'Europe/Warsaw', location: null,
  status: 'completed', source: 'panel', version: 2, cancelledAt: null,
  cancellationReason: null,
  createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-16T08:00:00.000Z',
  charge: {
    id: 'chg_history', serviceId: 'zajecia', expectedAmountGrosze: 18_000,
    currency: 'PLN', version: 1,
  },
  payment: {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
    latestMethod: null, latestReceivedAt: null,
  },
  paymentEntries: [],
}

const appointment = ({
  id, clientId = 'cl_ola', specialistId = 'sp_anna', serviceId = 'zajecia',
  startsAt = '2026-08-04T09:00:00.000Z', endsAt = '2026-08-04T09:50:00.000Z',
  location = null, status = 'scheduled', version = status === 'cancelled' ? 2 : 1,
  createdAt = '2026-08-01T08:00:00.000Z', updatedAt = createdAt,
  expectedAmountGrosze = 18_000,
}) => ({
  id, clientId, specialistId, serviceId, startsAt, endsAt, timeZone: 'Europe/Warsaw',
  location, status, source: 'panel', version,
  cancelledAt: status === 'cancelled' ? updatedAt : null,
  cancellationReason: status === 'cancelled' ? 'client' : null,
  createdAt, updatedAt,
  charge: {
    id: `chg_${id.slice(4)}`, serviceId, expectedAmountGrosze, currency: 'PLN', version,
  },
  payment: {
    status: 'unpaid', collectedGrosze: 0,
    outstandingGrosze: ['completed', 'noshow'].includes(status) ? expectedAmountGrosze : 0,
    latestMethod: null, latestReceivedAt: null,
  },
  paymentEntries: [],
})

const appointmentsInWindow = (appointments, from, to) => appointments.filter((item) => {
  const date = item.startsAt.slice(0, 10)
  return date >= from && date <= to
})

test('@owner explains an unknown client card without exposing another client', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), []))
  })

  await page.goto('./#/client?id=cl_missing')

  await expect(page.getByText('Nie możemy otworzyć tej karty', { exact: true })).toBeVisible()
  await expect(page.getByText('Link jest nieaktualny albo klient jest pod opieką innej specjalistki.', { exact: true })).toBeVisible()
})

test('@owner uses a client’s latest specialist and the selected day’s occupied hours for a new session', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({
    id: 'cl_ola', name: 'Ola Aktywna', age: 12, specialistId: 'sp_basia', version: 2,
  })]
  const appointments = [
    appointment({
      id: 'apt_latest_client', clientId: 'cl_ola', specialistId: 'sp_anna',
      startsAt: '2026-08-03T08:00:00.000Z', endsAt: '2026-08-03T08:50:00.000Z', status: 'completed',
    }),
    appointment({
      id: 'apt_busy_today', clientId: 'cl_ola', specialistId: 'sp_anna',
      startsAt: '2026-08-04T09:00:00.000Z', endsAt: '2026-08-04T09:50:00.000Z',
    }),
  ]
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(
      url.searchParams.get('from'), url.searchParams.get('to'), records,
      appointmentsInWindow(appointments, url.searchParams.get('from'), url.searchParams.get('to')),
    ))
  })

  await page.goto('./#/client?id=cl_ola')
  await page.locator('.id-band__actions').getByRole('button', { name: 'Umów sesję' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await expect(drawer.getByLabel('Specjalistka')).toHaveValue('sp_anna')
  await expect(drawer.getByLabel('Godzina')).toHaveValue('11:50')
  await expect(drawer).toContainText('Zajęte godziny: 11:00-11:50')
})

test('@owner loads the newly selected month before reporting a specialist’s occupied hours', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12 })]
  const appointments = [appointment({
    id: 'apt_september_busy', clientId: 'cl_ola', specialistId: 'sp_anna',
    startsAt: '2026-09-14T09:00:00.000Z', endsAt: '2026-09-14T09:50:00.000Z',
  })]
  let septemberLoads = 0
  let releaseSeptember
  const septemberRequested = new Promise((resolve) => {
    releaseSeptember = resolve
  })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from === '2026-09-01' && to === '2026-09-30') {
      septemberLoads += 1
      await septemberRequested
    }
    await route.fulfill(workspace(from, to, records, appointmentsInWindow(appointments, from, to)))
  })

  await page.goto('./#/calendar?date=2026-08-04')
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await drawer.getByLabel('Specjalistka').selectOption('sp_anna')
  await drawer.getByLabel('Data').fill('2026-09-14')

  await expect.poll(() => septemberLoads).toBe(1)
  await expect(drawer).toContainText('Sprawdzam zajęte godziny…')
  await expect(drawer).not.toContainText('Zajęte godziny: brak')

  releaseSeptember()
  await expect(drawer).toContainText('Zajęte godziny: 11:00-11:50')

  await drawer.getByLabel('Data').fill('2026-09-15')
  await expect(drawer.getByLabel('Godzina')).toHaveValue('12:00')
  await expect(drawer).toContainText('Zajęte godziny: brak')

  await drawer.getByLabel('Data').fill('')
  await expect(drawer).toBeVisible()
  await expect(drawer).not.toContainText('Zajęte godziny: brak')
  await expect(drawer).not.toContainText('Sprawdzam zajęte godziny…')
})

test('@owner shows all missing client and session fields before sending either form', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const writes = []
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), []))
  })
  await page.route('**/api/v1/clients', (route) => {
    writes.push(route.request().postDataJSON())
    return route.abort()
  })
  await page.route('**/api/v1/appointments', (route) => {
    writes.push(route.request().postDataJSON())
    return route.abort()
  })

  await page.goto('./#/clients')
  await page.getByRole('button', { name: 'Dodaj klienta' }).first().click()
  const clientDrawer = page.getByRole('dialog', { name: 'Nowy klient' })
  await clientDrawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(clientDrawer.getByLabel('Imię i nazwisko')).toHaveAttribute('aria-invalid', 'true')
  await expect(clientDrawer.getByLabel('Specjalistka prowadząca')).toHaveAttribute('aria-invalid', 'true')
  await expect(clientDrawer.getByLabel('Wiek')).not.toHaveAttribute('aria-invalid', 'true')
  await expect(clientDrawer.getByLabel('Imię i nazwisko')).toBeFocused()

  await clientDrawer.getByRole('button', { name: 'Anuluj' }).click()
  await page.goto('./#/calendar?date=2026-08-04')
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  const sessionDrawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await sessionDrawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  await expect(sessionDrawer.getByRole('combobox', { name: 'Klient' })).toHaveAttribute('aria-invalid', 'true')
  await expect(sessionDrawer.getByLabel('Specjalistka')).toHaveAttribute('aria-invalid', 'true')
  await expect(sessionDrawer.getByLabel('Kwota (zł)')).toHaveAttribute('aria-invalid', 'true')
  await expect(sessionDrawer.getByRole('combobox', { name: 'Klient' })).toBeFocused()
  expect(writes).toEqual([])
})

test('@owner persists client create, edit, reassignment, and archive through the workspace', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  const writes = []

  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/clients', async (route) => {
    const body = route.request().postDataJSON()
    writes.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, body })
    const created = client({
      id: 'cl_iga', name: body.name, age: body.age, status: body.status,
      specialistId: body.specialistId, createdAt: '2026-08-04T08:00:00.000Z',
    })
    created.assignment.startsAt = body.assignmentStartsAt
    records.push(created)
    await route.fulfill(json(201, { data: { client: created } }))
  })
  await page.route('**/api/v1/clients/cl_iga/edits', async (route) => {
    const body = route.request().postDataJSON()
    writes.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, body })
    const edited = client({
      id: 'cl_iga', name: body.name, age: body.age, status: body.status, version: 2,
      specialistId: body.specialistId, createdAt: '2026-08-04T08:00:00.000Z',
      updatedAt: '2026-08-04T08:05:00.000Z',
    })
    records.splice(records.findIndex((item) => item.id === edited.id), 1, edited)
    await route.fulfill(json(200, { data: { client: edited } }))
  })
  await page.route('**/api/v1/clients/cl_iga/archive', async (route) => {
    const body = route.request().postDataJSON()
    writes.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, body })
    const archived = client({
      id: 'cl_iga', name: 'Iga Po zmianie', age: 8, status: 'archived', version: 3,
      createdAt: '2026-08-04T08:00:00.000Z', updatedAt: '2026-08-04T08:10:00.000Z',
      archivedAt: '2026-08-04T08:10:00.000Z',
    })
    records.splice(records.findIndex((item) => item.id === archived.id), 1)
    await route.fulfill(json(200, { data: { client: archived } }))
  })

  await page.goto('./#/clients')
  await expect(page.getByText('Ola Aktywna', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Dodaj klienta' }).click()

  let drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByLabel('E-mail opiekuna')).toBeVisible()
  await expect(drawer.getByLabel('Telefon opiekuna')).toBeVisible()
  await expect(drawer.getByLabel('Uwagi recepcji')).toBeVisible()
  await expect(drawer.getByLabel('Powiąż z klientem')).toHaveCount(0)
  await expect(drawer.getByLabel('Pierwsza notatka (opcjonalnie)')).toHaveCount(0)
  await drawer.getByLabel('Imię i nazwisko').fill('Iga Nowa')
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await drawer.getByLabel('Wiek').fill('8')
  await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page).toHaveURL(/#\/client\?id=cl_iga$/)
  await expect(page.getByRole('heading', { name: 'Iga Nowa' })).toBeVisible()
  await expect(page.getByText('Klient został dodany · Iga Nowa', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Edytuj' }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByLabel('Imię i nazwisko').fill('Iga Po zmianie')
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_basia')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Iga Po zmianie' })).toBeVisible()

  await page.getByRole('button', { name: 'Edytuj' }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await page.getByRole('button', { name: 'Archiwizuj klienta' }).click()
  await page.getByRole('button', { name: 'Tak, archiwizuj klienta' }).click()
  await expect(page).toHaveURL(/#\/clients/)
  await expect(page.getByText('Iga Po zmianie', { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('Iga Po zmianie', { exact: true })).toHaveCount(0)

  expect(writes).toEqual([
    {
      method: 'POST', path: '/api/v1/clients',
      body: {
        name: 'Iga Nowa', age: 8, status: 'active', specialistId: 'sp_anna',
        assignmentStartsAt: '2026-08-03T22:00:00.000Z',
      },
    },
    {
      method: 'POST', path: '/api/v1/clients/cl_iga/edits',
      body: {
        expectedVersion: 1, name: 'Iga Po zmianie', age: 8, status: 'active',
        specialistId: 'sp_basia', assignmentStartsAt: null,
      },
    },
    {
      method: 'POST', path: '/api/v1/clients/cl_iga/archive',
      body: { expectedVersion: 2 },
    },
  ])
})

test('@owner saves guardian contacts and multiline reception notes on the client card', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = []
  const writes = []
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/clients', async (route) => {
    const body = route.request().postDataJSON()
    writes.push(body)
    records.push({
      ...client({ id: 'cl_guardian', name: body.name, age: body.age,
        createdAt: '2026-08-04T08:00:00.000Z' }),
      guardianPhone: body.guardianPhone, guardianEmail: body.guardianEmail,
      receptionNotes: body.receptionNotes,
    })
    records[0].assignment.startsAt = body.assignmentStartsAt
    await route.fulfill(json(201, { data: { client: records[0] } }))
  })
  await page.route('**/api/v1/clients/cl_guardian/edits', async (route) => {
    const body = route.request().postDataJSON()
    writes.push(body)
    records[0] = {
      ...records[0], version: 2, updatedAt: '2026-08-04T08:05:00.000Z',
      guardianPhone: body.guardianPhone, guardianEmail: body.guardianEmail,
      receptionNotes: body.receptionNotes,
    }
    await route.fulfill(json(200, { data: { client: records[0] } }))
  })

  await page.goto('./#/clients')
  await page.getByRole('button', { name: 'Dodaj klienta' }).first().click()
  let drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  await drawer.getByLabel('Imię i nazwisko').fill('Iga Fikcyjna')
  await drawer.getByLabel('Wiek').fill('9')
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await drawer.getByLabel('Telefon opiekuna').fill('+48 600 100 200')
  await drawer.getByLabel('E-mail opiekuna').fill('opiekun@example.test')
  await drawer.getByLabel('Uwagi recepcji').fill('Kontakt po 15:00.\nDzwonić do opiekuna.')
  await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(page.getByRole('link', { name: '+48 600 100 200' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'opiekun@example.test' })).toBeVisible()
  await expect(page.getByText('Kontakt po 15:00. Dzwonić do opiekuna.')).toBeVisible()
  await expect(page.getByText('Kontakt po 15:00. Dzwonić do opiekuna.')).toHaveCSS('white-space', 'pre-wrap')

  await page.getByRole('button', { name: 'Edytuj', exact: true }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await expect(drawer.getByLabel('Uwagi recepcji')).toHaveValue('Kontakt po 15:00.\nDzwonić do opiekuna.')
  await drawer.getByLabel('Telefon opiekuna').fill('')
  await drawer.getByLabel('Uwagi recepcji').fill('')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(page.getByRole('link', { name: '+48 600 100 200' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Uwagi recepcji' })).toHaveCount(0)
  expect(writes[0]).toMatchObject({
    guardianPhone: '+48 600 100 200', guardianEmail: 'opiekun@example.test',
    receptionNotes: 'Kontakt po 15:00.\nDzwonić do opiekuna.',
  })
  expect(writes[1]).toMatchObject({
    guardianPhone: '', guardianEmail: 'opiekun@example.test', receptionNotes: '',
  })
})

test('@owner sends Warsaw assignment dates and preserves the saved instant while editing a client', async ({ page }) => {
  await freezeTime(page, '2026-08-04T14:00:00.000Z')
  const records = []
  const writes = []
  let assignmentStartsAt = '2026-07-31T22:00:00.000Z'
  let specialistId = 'sp_anna'
  let version = 1
  let appointmentCreated = false

  const currentClient = (body = {}) => ({
    ...client({
      id: 'cl_iga', name: body.name || 'Iga Datowana', age: body.age ?? 8,
      status: body.status || 'active', specialistId, version,
      createdAt: '2026-08-04T14:00:00.000Z', updatedAt: '2026-08-04T14:00:00.000Z',
    }),
    assignment: {
      id: `asg_iga_${version}`, specialistId, startsAt: assignmentStartsAt, version,
    },
  })

  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(
      url.searchParams.get('from'), url.searchParams.get('to'), records,
      appointmentCreated ? [appointment({
        id: 'apt_iga', clientId: 'cl_iga', startsAt: '2026-08-01T07:00:00.000Z',
        endsAt: '2026-08-01T07:50:00.000Z',
      })] : [],
    ))
  })
  await page.route('**/api/v1/clients', async (route) => {
    const body = route.request().postDataJSON()
    writes.push(body)
    assignmentStartsAt = body.assignmentStartsAt
    const created = currentClient(body)
    records.splice(0, records.length, created)
    await route.fulfill(json(201, { data: { client: created } }))
  })
  await page.route('**/api/v1/clients/cl_iga/edits', async (route) => {
    const body = route.request().postDataJSON()
    writes.push(body)
    version += 1
    if (body.specialistId !== specialistId) {
      specialistId = body.specialistId
      assignmentStartsAt = '2026-08-04T14:00:00.000Z'
    } else if (body.assignmentStartsAt !== null) {
      assignmentStartsAt = body.assignmentStartsAt
    }
    const edited = currentClient(body)
    records.splice(0, records.length, edited)
    await route.fulfill(json(200, { data: { client: edited } }))
  })
  await page.route('**/api/v1/appointments', async (route) => {
    const body = route.request().postDataJSON()
    writes.push(body)
    appointmentCreated = true
    await route.fulfill(json(201, { data: { appointment: appointment({
      id: 'apt_iga', clientId: body.clientId, specialistId: body.specialistId,
      startsAt: '2026-08-01T07:00:00.000Z', endsAt: '2026-08-01T07:50:00.000Z',
    }) } }))
  })

  await page.goto('./#/clients')
  await page.getByRole('button', { name: 'Dodaj klienta' }).first().click()
  let drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  await drawer.getByLabel('Imię i nazwisko').fill('Iga Datowana')
  await drawer.getByLabel('Wiek').fill('8')
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await expect(drawer.getByLabel('Pod opieką od')).toHaveValue('2026-08-04')
  await drawer.getByLabel('Pod opieką od').fill('2026-08-01')
  await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(page.getByRole('heading', { name: 'Iga Datowana' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Iga Datowana' })).toBeVisible()

  await page.goto('./#/calendar?date=2026-08-01')
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await selectSessionClient(drawer, 'Iga Datowana')
  await drawer.getByLabel('Godzina').fill('09:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()

  await page.goto('./#/client?id=cl_iga')
  await page.getByRole('button', { name: 'Edytuj', exact: true }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await expect(drawer.getByLabel('Pod opieką od')).toHaveValue('2026-08-01')
  await drawer.getByLabel('Imię i nazwisko').fill('Iga Zachowana')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()

  await page.getByRole('button', { name: 'Edytuj', exact: true }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByLabel('Pod opieką od').fill('2026-07-30')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()

  await page.getByRole('button', { name: 'Edytuj', exact: true }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_basia')
  await expect(drawer).toContainText('Nowe przypisanie zacznie się przy zapisie.')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()

  expect(writes).toEqual([
    {
      name: 'Iga Datowana', age: 8, status: 'active', specialistId: 'sp_anna',
      assignmentStartsAt: '2026-07-31T22:00:00.000Z',
    },
    {
      clientId: 'cl_iga', specialistId: 'sp_anna', serviceId: 'zajecia', date: '2026-08-01',
      time: '09:00', durationMinutes: 50, expectedAmountGrosze: 18_000, location: null,
      status: 'scheduled',
    },
    {
      expectedVersion: 1, name: 'Iga Zachowana', age: 8, status: 'active',
      specialistId: 'sp_anna', assignmentStartsAt: '2026-07-31T22:00:00.000Z',
    },
    {
      expectedVersion: 2, name: 'Iga Zachowana', age: 8, status: 'active',
      specialistId: 'sp_anna', assignmentStartsAt: '2026-07-29T22:00:00.000Z',
    },
    {
      expectedVersion: 3, name: 'Iga Zachowana', age: 8, status: 'active',
      specialistId: 'sp_basia', assignmentStartsAt: null,
    },
  ])
})

test('@owner sees a client session from the bounded upcoming window and a labelled recent balance', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  const overdue = {
    ...appointment({
      id: 'apt_overdue', startsAt: '2026-07-15T08:00:00.000Z', endsAt: '2026-07-15T08:50:00.000Z',
      status: 'completed',
    }),
    payment: {
      status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
      latestMethod: null, latestReceivedAt: null,
    },
  }
  const upcoming = appointment({
    id: 'apt_upcoming', startsAt: '2026-11-02T08:00:00.000Z', endsAt: '2026-11-02T08:50:00.000Z',
  })
  const requests = []
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    requests.push({ from, to })
    const appointments = from === '2026-08-04' && to === '2026-11-02'
      ? [upcoming]
      : from === '2026-05-04' && to === '2026-08-04' ? [overdue] : []
    return route.fulfill(workspace(from, to, records, appointments))
  })

  await page.goto('./#/clients')
  const row = page.locator('tr', { hasText: 'Ola Aktywna' })
  await expect(page.getByRole('columnheader')).toHaveText([
    'Klient', 'Specjalistka', 'Następna sesja',
    'Do zapłaty od 4 maja 2026 do 4 sierpnia 2026',
  ])
  await expect(row).toContainText('2 lis')
  await expect(page.getByRole('columnheader', {
    name: 'Do zapłaty od 4 maja 2026 do 4 sierpnia 2026',
  })).toBeVisible()
  await expect(row.locator('td').nth(3)).toHaveAttribute(
    'data-th', 'Do zapłaty: 4 maja 2026 – 4 sierpnia 2026',
  )
  await expect(row).toContainText('180')
  expect(requests).toContainEqual({ from: '2026-08-04', to: '2026-11-02' })
})

test('@owner shows an explicit loading state in future client-list cells', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12 })]
  let releaseFuture
  const futurePending = new Promise((resolve) => { releaseFuture = resolve })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from === '2026-08-04' && to === '2026-11-02') await futurePending
    return route.fulfill(workspace(from, to, records))
  })

  await page.goto('./#/clients')
  const row = page.locator('tr', { hasText: 'Ola Aktywna' })
  try {
    await expect(row).toContainText('Wczytuję najbliższe sesje…')
  } finally {
    releaseFuture()
  }
})

test('@owner keeps the client card truthful while the future window fails and retries it locally', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12 })]
  const next = appointment({
    id: 'apt_future', startsAt: '2026-09-05T08:00:00.000Z', endsAt: '2026-09-05T08:50:00.000Z',
  })
  let futureReads = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from === '2026-08-04' && to === '2026-11-02') {
      futureReads += 1
      return futureReads === 1
        ? route.fulfill(json(500, { error: { code: 'WORKSPACE_UNAVAILABLE' } }))
        : route.fulfill(workspace(from, to, records, [next]))
    }
    return route.fulfill(workspace(from, to, records, appointmentsInWindow([next], from, to)))
  })

  await page.goto('./#/clients')
  await expect(page.getByRole('status').filter({ hasText: 'Nie udało się wczytać najbliższych sesji.' })).toBeVisible()
  await expect(page.getByText('Brak sesji w najbliższych 3 miesiącach', { exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'Otwórz kartę — Ola Aktywna' }).click()
  await expect(page.getByRole('heading', { name: 'Ola Aktywna' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Nie udało się wczytać najbliższych sesji.' })).toBeVisible()
  await expect(page.getByText('Brak sesji w najbliższych 3 miesiącach', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect(page.getByText('Sobota, 5 września', { exact: true })).toBeVisible()
  expect(futureReads).toBeGreaterThanOrEqual(2)
})

test('@owner puts a cancelled future session in the client attendance history', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12 })]
  const cancelled = appointment({
    id: 'apt_cancelled', startsAt: '2026-09-05T08:00:00.000Z', endsAt: '2026-09-05T08:50:00.000Z',
    status: 'cancelled', updatedAt: '2026-08-02T08:00:00.000Z',
  })
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    return route.fulfill(workspace(from, to, records, appointmentsInWindow([cancelled], from, to)))
  })

  await page.goto('./#/client?id=cl_ola')
  await expect(page.getByRole('heading', { name: 'Historia sesji' })).toBeVisible()
  await expect(page.getByText('Odwołana', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Najbliższe sesje' })).toBeVisible()
  await expect(page.locator('[aria-labelledby="upcoming-appointments-title"]')
    .getByText('Brak sesji w najbliższych 3 miesiącach', { exact: true })).toBeVisible()
})

test('@owner loads earlier client history in bounded windows through the assignment start', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({
    id: 'cl_ola', name: 'Ola Aktywna', age: 12, createdAt: '2026-01-10T09:00:00.000Z',
  })]
  const requests = []
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    requests.push({ from, to })
    const appointments = appointmentsInWindow([
      appointment({ id: 'apt_recent', startsAt: '2026-07-15T08:00:00.000Z', endsAt: '2026-07-15T08:50:00.000Z', status: 'completed' }),
      appointment({ id: 'apt_older', startsAt: '2026-03-15T08:00:00.000Z', endsAt: '2026-03-15T08:50:00.000Z', status: 'completed' }),
      appointment({ id: 'apt_first', startsAt: '2026-01-10T08:00:00.000Z', endsAt: '2026-01-10T08:50:00.000Z', status: 'completed' }),
    ], from, to)
    return route.fulfill(workspace(from, to, records, appointments))
  })

  await page.goto('./#/client?id=cl_ola')
  await expect(page.getByRole('button', { name: 'Pokaż wcześniejsze sesje' })).toBeVisible()
  await page.getByRole('button', { name: 'Pokaż wcześniejsze sesje' }).click()
  await expect(page.getByText('15 mar', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pokaż wcześniejsze sesje' }).click()
  await expect(page.getByText('10 sty', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pokaż wcześniejsze sesje' })).toHaveCount(0)
  expect(requests).toContainEqual({ from: '2026-01-31', to: '2026-05-03' })
  expect(requests).toContainEqual({ from: '2026-01-10', to: '2026-01-30' })
})

test('@owner shows older-history loading without a false empty state', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({
    id: 'cl_ola', name: 'Ola Aktywna', age: 12, createdAt: '2026-01-10T09:00:00.000Z',
  })]
  let releaseOlder
  const olderPending = new Promise((resolve) => { releaseOlder = resolve })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from === '2026-01-31' && to === '2026-05-03') await olderPending
    return route.fulfill(workspace(from, to, records))
  })

  await page.goto('./#/client?id=cl_ola')
  await page.getByRole('button', { name: 'Pokaż wcześniejsze sesje' }).click()
  try {
    await expect(page.getByRole('status').filter({ hasText: 'Wczytuję wcześniejsze sesje…' })).toBeVisible()
    await expect(page.getByText('Brak historii sesji', { exact: true })).toHaveCount(0)
  } finally {
    releaseOlder()
  }
})

test('@owner shows older-history error without a false empty state', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({
    id: 'cl_ola', name: 'Ola Aktywna', age: 12, createdAt: '2026-01-10T09:00:00.000Z',
  })]
  let olderReads = 0
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from === '2026-01-31' && to === '2026-05-03' && olderReads++ === 0) {
      return route.fulfill(json(500, { error: { code: 'WORKSPACE_UNAVAILABLE' } }))
    }
    return route.fulfill(workspace(from, to, records))
  })

  await page.goto('./#/client?id=cl_ola')
  await page.getByRole('button', { name: 'Pokaż wcześniejsze sesje' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Nie udało się wczytać wcześniejszych sesji.' })).toBeVisible()
  await expect(page.getByText('Brak historii sesji', { exact: true })).toHaveCount(0)
})

test('@owner loads a specialist current month and future window with a monthly balance', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12 })]
  const augustDebt = {
    ...appointment({
      id: 'apt_august', startsAt: '2026-08-10T08:00:00.000Z', endsAt: '2026-08-10T08:50:00.000Z',
      status: 'completed',
    }),
    payment: {
      status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
      latestMethod: null, latestReceivedAt: null,
    },
  }
  const augustFuture = appointment({
    id: 'apt_august_future', startsAt: '2026-08-20T08:00:00.000Z', endsAt: '2026-08-20T08:50:00.000Z',
  })
  const requests = []
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    requests.push({ from, to })
    return route.fulfill(workspace(from, to, records, appointmentsInWindow([augustDebt, augustFuture], from, to)))
  })

  await page.goto('./#/psych?id=sp_anna')
  await expect(page.getByRole('heading', { name: /Anna Nowak/ })).toBeVisible()
  const row = page.locator('tr', { hasText: 'Ola Aktywna' })
  await expect(row).toContainText('180')
  await expect(page.getByRole('columnheader', { name: 'Do zapłaty w tym miesiącu' })).toBeVisible()
  await expect(page.locator('.stat', { hasText: 'Sesje odbyte' }).locator('.stat__value')).toHaveText('1')
  await expect(row.locator('td').nth(3)).toHaveAttribute('data-th', 'Do zapłaty w tym miesiącu')
  expect(requests).toContainEqual({ from: '2026-08-01', to: '2026-08-31' })
  expect(requests).toContainEqual({ from: '2026-08-04', to: '2026-11-02' })
})

test('@owner keeps the future window on an active card opened with a source month', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12 })]
  const future = appointment({
    id: 'apt_future_with_source', startsAt: '2026-09-05T08:00:00.000Z', endsAt: '2026-09-05T08:50:00.000Z',
  })
  const requests = []
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    requests.push({ from, to })
    return route.fulfill(workspace(from, to, records, appointmentsInWindow([future], from, to)))
  })

  await page.goto('./#/client?id=cl_ola&ym=2026-07')
  await expect(page.getByText('Sobota, 5 września', { exact: true })).toBeVisible()
  await expect(page.getByText('Brak sesji w najbliższych 3 miesiącach', { exact: true })).toHaveCount(0)
  expect(requests).toContainEqual({ from: '2026-05-04', to: '2026-08-04' })
  expect(requests).not.toContainEqual({ from: '2026-07-01', to: '2026-07-31' })
  expect(requests).toContainEqual({ from: '2026-08-04', to: '2026-11-02' })
})

test('@owner retains a client draft after an assignment conflict', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/clients/cl_ola/edits', (route) => route.fulfill(json(409, {
    error: { code: 'CLIENT_ASSIGNMENT_CONFLICT' },
  })))

  await page.goto('./#/client?id=cl_ola')
  await expect(page.getByRole('heading', { name: 'Ola Aktywna' })).toBeVisible()
  await page.getByRole('button', { name: 'Edytuj' }).click()
  const drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByLabel('Imię i nazwisko').fill('Ola Zmieniona')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()

  await expect(drawer).toBeVisible()
  await expect(drawer.getByLabel('Imię i nazwisko')).toHaveValue('Ola Zmieniona')
  await expect(drawer.getByRole('alert')).toContainText('Nie można zapisać tej daty rozpoczęcia opieki')
})

test('@owner closes and disables a successful client create when canonical reload fails', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  const writes = []
  let workspaceReads = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    workspaceReads += 1
    if (workspaceReads > 1) {
      return route.fulfill(json(409, { error: { code: 'VERSION_CONFLICT' } }))
    }
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/clients', async (route) => {
    const body = route.request().postDataJSON()
    writes.push(body)
    const created = client({
      id: 'cl_iga', name: 'Iga Nowa', age: 8,
      createdAt: '2026-08-04T08:00:00.000Z',
    })
    created.assignment.startsAt = body.assignmentStartsAt
    await route.fulfill(json(201, {
      data: { client: created },
    }))
  })

  await page.goto('./#/clients')
  await page.getByRole('button', { name: 'Dodaj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  await drawer.getByLabel('Imię i nazwisko').fill('Iga Nowa')
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await drawer.getByLabel('Wiek').fill('8')
  await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Dodaj klienta' })).toBeDisabled()
  await expect(page.getByText('Dane zapisano, ale nie udało się odświeżyć kartoteki.')).toBeVisible()
  await page.goto('./#/dashboard')
  await page.goto('./#/clients')
  await expect(page.getByRole('button', { name: 'Dodaj klienta' })).toBeDisabled()
  expect(writes).toHaveLength(1)
})

test('@owner closes and disables a successful client edit when canonical reload fails', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  const writes = []
  let workspaceReads = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    workspaceReads += 1
    if (workspaceReads > 1) {
      return route.fulfill(json(409, { error: { code: 'VERSION_CONFLICT' } }))
    }
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/clients/cl_ola/edits', async (route) => {
    writes.push(route.request().postDataJSON())
    await route.fulfill(json(200, {
      data: {
        client: client({ id: 'cl_ola', name: 'Ola Zmieniona', age: 12, version: 3 }),
      },
    }))
  })

  await page.goto('./#/client?id=cl_ola')
  await page.getByRole('button', { name: 'Edytuj' }).click()
  const drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByLabel('Imię i nazwisko').fill('Ola Zmieniona')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edytuj' })).toHaveCount(0)
  await expect(page.getByText('Dane zapisano, ale nie udało się odświeżyć kartoteki.')).toBeVisible()
  await page.goto('./#/dashboard')
  await page.goto('./#/client?id=cl_ola')
  await expect(page.getByRole('button', { name: 'Edytuj' })).toHaveCount(0)
  expect(writes).toHaveLength(1)
})

test('@owner closes and disables a successful client archive when canonical reload fails', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  const writes = []
  let workspaceReads = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    workspaceReads += 1
    if (workspaceReads > 1) {
      return route.fulfill(json(409, { error: { code: 'VERSION_CONFLICT' } }))
    }
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/clients/cl_ola/archive', async (route) => {
    writes.push(route.request().postDataJSON())
    await route.fulfill(json(200, {
      data: {
        client: client({
          id: 'cl_ola', name: 'Ola Aktywna', age: 12, status: 'archived', version: 3,
          archivedAt: '2026-08-04T08:10:00.000Z', updatedAt: '2026-08-04T08:10:00.000Z',
        }),
      },
    }))
  })

  await page.goto('./#/client?id=cl_ola')
  await page.getByRole('button', { name: 'Edytuj' }).click()
  const drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByRole('button', { name: 'Archiwizuj klienta' }).click()
  await drawer.getByRole('button', { name: 'Tak, archiwizuj klienta' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edytuj' })).toHaveCount(0)
  await expect(page.getByText('Klienta zarchiwizowano, ale nie udało się odświeżyć kartoteki.')).toBeVisible()
  await page.goto('./#/dashboard')
  await page.goto('./#/client?id=cl_ola')
  await expect(page.getByRole('button', { name: 'Edytuj' })).toHaveCount(0)
  expect(writes).toHaveLength(1)
})

test('@owner keeps the client draft after a version conflict and reloads the canonical client on request', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  const writes = []
  let workspaceReads = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/clients/cl_ola/edits', (route) => {
    writes.push(route.request().postDataJSON())
    records.splice(0, 1, client({
      id: 'cl_ola', name: 'Ola Na serwerze', age: 12, version: 3,
      updatedAt: '2026-08-04T08:06:00.000Z',
    }))
    return route.fulfill(json(409, { error: { code: 'VERSION_CONFLICT' } }))
  })

  await page.goto('./#/client?id=cl_ola')
  await page.getByRole('button', { name: 'Edytuj' }).click()
  const drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByLabel('Imię i nazwisko').fill('Ola Lokalna')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()

  await expect(drawer.getByRole('alert')).toContainText(
    'Ktoś w międzyczasie zmienił dane klienta. Twoja zmiana nie została zapisana.',
  )
  await expect(drawer.getByLabel('Imię i nazwisko')).toHaveValue('Ola Lokalna')
  const readsBeforeReload = workspaceReads
  await drawer.getByRole('button', { name: 'Wczytaj aktualne dane' }).click()
  await expect(drawer.getByLabel('Imię i nazwisko')).toHaveValue('Ola Na serwerze')
  expect(workspaceReads).toBeGreaterThan(readsBeforeReload)

  await drawer.getByLabel('Imię i nazwisko').fill('Ola Ponownie')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect.poll(() => writes).toHaveLength(2)
  expect(writes.map(({ expectedVersion }) => expectedVersion)).toEqual([2, 3])
})

test('@owner keeps archived canonical history read-only and outside the client form', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({
    id: 'cl_archived', name: 'Zofia Historyczna', age: 14, status: 'archived', version: 2,
    archivedAt: '2026-07-20T08:00:00.000Z', updatedAt: '2026-07-20T08:00:00.000Z',
  })]
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(
      url.searchParams.get('from'), url.searchParams.get('to'), records, [historyAppointment],
    ))
  })

  await page.goto('./#/client?id=cl_archived')
  await expect(page.getByRole('heading', { name: 'Zofia Historyczna' })).toBeVisible()
  await expect(page.getByText('Archiwalny', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edytuj' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Umów sesję' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Przełóż' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Archiwizuj klienta' })).toHaveCount(0)
  await expect(page.getByText('Rodzina', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Notatki kliniczne' })).toHaveCount(0)
})

test('@owner persists protected appointment create and edit with canonical reloads only', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  const appointments = [appointment({ id: 'apt_existing' })]
  const writes = []
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(
      url.searchParams.get('from'), url.searchParams.get('to'), records, appointments,
    ))
  })
  await page.route('**/api/v1/appointments', async (route) => {
    const body = route.request().postDataJSON()
    writes.push({ path: new URL(route.request().url()).pathname, body })
    const created = appointment({
      id: 'apt_created', clientId: body.clientId, specialistId: body.specialistId,
      serviceId: body.serviceId, startsAt: '2026-08-04T11:00:00.000Z',
      endsAt: '2026-08-04T11:50:00.000Z', status: body.status,
      expectedAmountGrosze: body.expectedAmountGrosze,
      createdAt: '2026-08-04T08:00:00.000Z', updatedAt: '2026-08-04T08:00:00.000Z',
    })
    appointments.push(created)
    await route.fulfill(json(201, { data: { appointment: created } }))
  })
  await page.route('**/api/v1/appointments/apt_existing/edits', async (route) => {
    const body = route.request().postDataJSON()
    writes.push({ path: new URL(route.request().url()).pathname, body })
    const edited = appointment({
      id: 'apt_existing', specialistId: body.specialistId, serviceId: body.serviceId,
      startsAt: '2026-08-04T10:00:00.000Z', endsAt: '2026-08-04T10:50:00.000Z',
      status: body.status, version: 2, expectedAmountGrosze: body.expectedAmountGrosze,
      updatedAt: '2026-08-04T08:05:00.000Z',
    })
    appointments.splice(appointments.findIndex((item) => item.id === edited.id), 1, edited)
    await route.fulfill(json(200, { data: { appointment: edited } }))
  })

  await page.goto('./#/calendar?date=2026-08-04')
  await expect(page.getByText('Ola Aktywna', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  let drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByLabel('Płatność')).toHaveCount(0)
  await expect(drawer.getByLabel('Forma płatności')).toHaveCount(0)
  await expect(drawer.getByLabel('Zalecenia / notatka')).toHaveCount(0)
  await expect(drawer.getByRole('radio', { name: 'Odwołana', exact: true })).toHaveCount(0)
  await selectSessionClient(drawer, 'Ola Aktywna')
  await drawer.getByLabel('Specjalistka').selectOption('sp_anna')
  await drawer.getByLabel('Godzina').fill('13:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page).toHaveURL(/#\/calendar\?date=2026-08-04&highlightSessionIds=apt_created$/)
  await expect(page.getByText(/Sesja została dodana.*Ola Aktywna.*13:00.*180\s*zł/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pokaż' })).toHaveCount(0)
  await expect(page.getByText('13:00', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Edytuj sesję — Ola Aktywna, 11:00' }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja sesji' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('radio', { name: 'Odwołana', exact: true })).toHaveCount(0)
  await drawer.getByLabel('Godzina').fill('12:00')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page).toHaveURL(/#\/calendar\?date=2026-08-04&highlightSessionIds=apt_existing$/)
  await expect(page.getByText(/Sesja została przełożona.*Ola Aktywna.*12:00.*180\s*zł/)).toBeVisible()
  await expect(page.getByText('12:00', { exact: true })).toBeVisible()

  expect(writes).toEqual([
    {
      path: '/api/v1/appointments',
      body: {
        clientId: 'cl_ola', specialistId: 'sp_anna', serviceId: 'zajecia',
        date: '2026-08-04', time: '13:00', durationMinutes: 50,
        expectedAmountGrosze: 18_000, location: null, status: 'scheduled',
      },
    },
    {
      path: '/api/v1/appointments/apt_existing/edits',
      body: {
        expectedVersion: 1, specialistId: 'sp_anna', serviceId: 'zajecia',
        date: '2026-08-04', time: '12:00', durationMinutes: 50,
        expectedAmountGrosze: 18_000, location: null, status: 'scheduled',
      },
    },
  ])
})

test('@owner retains a protected appointment draft after overlap, stale, and ordinary command failures', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  let attempts = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/appointments', (route) => {
    attempts += 1
    const code = attempts === 1
      ? 'APPOINTMENT_OVERLAP'
      : attempts === 2 ? 'VERSION_CONFLICT' : 'VALIDATION_FAILED'
    return route.fulfill(json(attempts === 3 ? 422 : 409, { error: { code } }))
  })

  await page.goto('./#/calendar?date=2026-08-04')
  await expect(page.getByRole('button', { name: 'Nowa sesja' })).toBeVisible()
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await selectSessionClient(drawer, 'Ola Aktywna')
  await drawer.getByLabel('Godzina').fill('12:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('alert')).toContainText('Ta sesja koliduje z inną sesją tej specjalistki')
  await expect(drawer.getByLabel('Godzina')).toHaveValue('12:00')
  await expect(drawer.getByLabel('Godzina')).toBeFocused()

  await drawer.getByLabel('Godzina').fill('13:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('alert')).toContainText('Ktoś w międzyczasie zmienił tę sesję. Twoja zmiana nie została zapisana. Zamknij formularz, otwórz go ponownie i wprowadź zmianę jeszcze raz.')
  await expect(drawer.getByLabel('Godzina')).toHaveValue('13:00')

  await drawer.getByLabel('Godzina').fill('14:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('alert')).toContainText('Nie udało się zapisać sesji.')
  await expect(drawer.getByLabel('Godzina')).toHaveValue('14:00')
  expect(attempts).toBe(3)
})

test('@owner keeps a stale session edit version and draft until the session is reopened', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  const appointments = [appointment({ id: 'apt_stale', startsAt: '2026-08-04T09:00:00.000Z' })]
  const writes = []
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(
      url.searchParams.get('from'), url.searchParams.get('to'), records, appointments,
    ))
  })
  await page.route('**/api/v1/appointments/apt_stale/edits', (route) => {
    writes.push(route.request().postDataJSON())
    return route.fulfill(json(409, { error: { code: 'VERSION_CONFLICT' } }))
  })

  await page.goto('./#/calendar?date=2026-08-04')
  await page.getByRole('button', { name: 'Edytuj sesję — Ola Aktywna, 11:00' }).click()
  const drawer = page.getByRole('dialog', { name: 'Edycja sesji' })
  await drawer.getByLabel('Godzina').fill('10:00')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()

  await expect(drawer.getByRole('alert')).toHaveText(
    'Ktoś w międzyczasie zmienił tę sesję. Twoja zmiana nie została zapisana. Zamknij formularz, otwórz go ponownie i wprowadź zmianę jeszcze raz.',
  )
  await expect(drawer.getByLabel('Godzina')).toHaveValue('10:00')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect.poll(() => writes).toHaveLength(2)
  expect(writes.map(({ expectedVersion }) => expectedVersion)).toEqual([1, 1])
})

test('@owner refreshes the source and destination windows before showing a rescheduled session', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  let appointments = [appointment({ id: 'apt_rescheduled', startsAt: '2026-08-04T09:00:00.000Z' })]
  const workspaceReads = []
  let editAccepted = false
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (editAccepted) workspaceReads.push({ from, to })
    return route.fulfill(workspace(
      from, to, records, appointmentsInWindow(appointments, from, to),
    ))
  })
  await page.route('**/api/v1/appointments/apt_rescheduled/edits', (route) => {
    const edited = appointment({
      id: 'apt_rescheduled', startsAt: '2026-09-02T09:00:00.000Z',
      endsAt: '2026-09-02T09:50:00.000Z', version: 2,
      updatedAt: '2026-08-04T08:05:00.000Z',
    })
    appointments = [edited]
    editAccepted = true
    return route.fulfill(json(200, { data: { appointment: edited } }))
  })

  await page.goto('./#/client?id=cl_ola')
  await page.getByRole('button', { name: 'Edytuj sesję — 4 sierpnia, 11:00' }).click()
  const drawer = page.getByRole('dialog', { name: 'Edycja sesji' })
  await drawer.getByLabel('Data').fill('2026-09-02')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()

  await expect(page).toHaveURL(/#\/calendar\?date=2026-09-02&highlightSessionIds=apt_rescheduled$/)
  await expect(page.getByText(/Sesja została przełożona.*2 września.*11:00/)).toBeVisible()
  await expect.poll(() => workspaceReads.slice(0, 2)).toEqual([
    { from: '2026-08-01', to: '2026-08-31' },
    { from: '2026-09-01', to: '2026-09-30' },
  ])
  await expect(page.getByRole('button', { name: 'Edytuj sesję — Ola Aktywna, 11:00' })).toBeEnabled()
})

test('@owner blocks a loaded session overlap at the time field without an API request', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [
    client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 }),
    client({ id: 'cl_mia', name: 'Mia Aktywna', age: 10, version: 2 }),
  ]
  const occupied = appointment({
    id: 'apt_occupied', clientId: 'cl_mia', startsAt: '2026-08-04T10:00:00.000Z', endsAt: '2026-08-04T10:50:00.000Z',
  })
  let writes = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records, [occupied]))
  })
  await page.route('**/api/v1/appointments', (route) => {
    writes += 1
    return route.fulfill(json(500, { error: { code: 'UNEXPECTED_WRITE' } }))
  })

  await page.goto('./#/calendar?date=2026-08-04')
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await selectSessionClient(drawer, 'Ola Aktywna')
  await drawer.getByLabel('Godzina').fill('12:15')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()

  await expect(drawer.getByLabel('Godzina')).toHaveAttribute('aria-invalid', 'true')
  await expect(drawer).toContainText('Anna ma już sesję o 12:00 (Mia Aktywna). Wybierz inną godzinę.')
  await expect(drawer.getByLabel('Godzina')).toBeFocused()
  expect(writes).toBe(0)
})

test('@owner prevents a session before its assignment starts', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({
    id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2,
    createdAt: '2026-08-04T10:05:00.000Z',
  })]
  let writes = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/appointments', (route) => {
    writes += 1
    return route.fulfill(json(500, { error: { code: 'UNEXPECTED_WRITE' } }))
  })

  await page.goto('./#/calendar?date=2026-08-04')
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await selectSessionClient(drawer, 'Ola Aktywna')
  await drawer.getByLabel('Godzina').fill('12:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()

  await expect(drawer.getByLabel('Data')).toHaveAttribute('aria-invalid', 'true')
  await expect(drawer).toContainText('Ten klient jest pod opieką tej specjalistki od 4 sierpnia o 12:05. Wcześniejszej sesji nie można zapisać.')
  await expect(drawer.getByLabel('Data')).toBeFocused()
  expect(writes).toBe(0)
})

test('@owner keeps payment pills for billable sessions while quieting cancelled and future unpaid sessions', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  const appointments = [
    appointment({ id: 'apt_completed', startsAt: '2026-08-04T08:00:00.000Z', endsAt: '2026-08-04T08:50:00.000Z', status: 'completed' }),
    appointment({ id: 'apt_noshow', startsAt: '2026-08-04T09:00:00.000Z', endsAt: '2026-08-04T09:50:00.000Z', status: 'noshow' }),
    appointment({ id: 'apt_cancelled', startsAt: '2026-08-04T10:00:00.000Z', endsAt: '2026-08-04T10:50:00.000Z', status: 'cancelled', updatedAt: '2026-08-02T08:00:00.000Z' }),
    appointment({ id: 'apt_future', startsAt: '2026-08-05T10:00:00.000Z', endsAt: '2026-08-05T10:50:00.000Z' }),
  ]
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    return route.fulfill(workspace(from, to, records, appointmentsInWindow(appointments, from, to)))
  })

  await page.goto('./#/calendar?date=2026-08-04')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await expect(plan.locator('.agenda__row[data-flip-id="apt_completed"]')).toContainText('Do zapłaty')
  await expect(plan.locator('.agenda__row[data-flip-id="apt_noshow"]')).toContainText('Do zapłaty')
  await expect(plan.locator('.agenda__row[data-flip-id="apt_cancelled"]')).toContainText('bez opłaty')

  await page.goto('./#/calendar?date=2026-08-05')
  await expect(page.getByRole('region', { name: 'Plan dnia' }).locator('.agenda__row[data-flip-id="apt_future"]'))
    .not.toContainText('Do zapłaty')
})
