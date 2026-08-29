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

const workspace = (from, to, clients, appointments = []) => json(200, {
  data: {
    window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
    specialists,
    clients: clients.toSorted((left, right) => left.name.localeCompare(right.name, 'pl')),
    appointments,
    historicalClients: [],
    historicalOccurrences: [],
    latestPopulatedMonth: null,
  },
})

const historyAppointment = {
  id: 'apt_history', clientId: 'cl_archived', specialistId: 'sp_anna',
  serviceId: 'zajecia', startsAt: '2026-07-15T08:30:00.000Z',
  endsAt: '2026-07-15T09:20:00.000Z', timeZone: 'Europe/Warsaw', location: null,
  status: 'completed', source: 'panel', version: 2, cancelledAt: null,
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
  location = null, status = 'scheduled', version = 1,
  createdAt = '2026-08-01T08:00:00.000Z', updatedAt = createdAt,
  expectedAmountGrosze = 18_000,
}) => ({
  id, clientId, specialistId, serviceId, startsAt, endsAt, timeZone: 'Europe/Warsaw',
  location, status, source: 'panel', version, cancelledAt: null, createdAt, updatedAt,
  charge: {
    id: `chg_${id.slice(4)}`, serviceId, expectedAmountGrosze, currency: 'PLN', version,
  },
  payment: {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
    latestMethod: null, latestReceivedAt: null,
  },
  paymentEntries: [],
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
  await expect(drawer.getByLabel('E-mail')).toHaveCount(0)
  await expect(drawer.getByLabel('Telefon')).toHaveCount(0)
  await expect(drawer.getByLabel('Powiąż z klientem')).toHaveCount(0)
  await expect(drawer.getByLabel('Pierwsza notatka (opcjonalnie)')).toHaveCount(0)
  await drawer.getByLabel('Imię i nazwisko').fill('Iga Nowa')
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('sp_anna')
  await drawer.getByLabel('Wiek').fill('8')
  await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.getByText('Iga Nowa', { exact: true })).toBeVisible()

  await page.getByRole('link', { name: 'Otwórz kartę — Iga Nowa' }).click()
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
      body: { name: 'Iga Nowa', age: 8, status: 'active', specialistId: 'sp_anna' },
    },
    {
      method: 'POST', path: '/api/v1/clients/cl_iga/edits',
      body: { expectedVersion: 1, name: 'Iga Po zmianie', age: 8, status: 'active', specialistId: 'sp_basia' },
    },
    {
      method: 'POST', path: '/api/v1/clients/cl_iga/archive',
      body: { expectedVersion: 2 },
    },
  ])
})

test('@owner retains a client draft after a non-stale workspace failure', async ({ page }) => {
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
  await expect(drawer.getByRole('alert')).toContainText('Nie udało się zapisać danych klienta.')
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
    writes.push(route.request().postDataJSON())
    await route.fulfill(json(201, {
      data: {
        client: client({
          id: 'cl_iga', name: 'Iga Nowa', age: 8,
          createdAt: '2026-08-04T08:00:00.000Z',
        }),
      },
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

test('@owner reloads the canonical client after a stale version conflict', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  const records = [client({ id: 'cl_ola', name: 'Ola Aktywna', age: 12, version: 2 })]
  let workspaceReads = 0
  await page.route('**/api/v1/workspace?*', (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    return route.fulfill(workspace(url.searchParams.get('from'), url.searchParams.get('to'), records))
  })
  await page.route('**/api/v1/clients/cl_ola/edits', (route) => {
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

  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Ola Na serwerze' })).toBeVisible()
  expect(workspaceReads).toBeGreaterThanOrEqual(2)
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
  await drawer.getByLabel('Klient').selectOption('cl_ola')
  await drawer.getByLabel('Specjalistka').selectOption('sp_anna')
  await drawer.getByLabel('Godzina').fill('13:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.getByText('13:00', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Edytuj sesję — Ola Aktywna, 11:00' }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja sesji' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('radio', { name: 'Odwołana', exact: true })).toHaveCount(0)
  await drawer.getByLabel('Godzina').fill('12:00')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(drawer).toHaveCount(0)
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
  await drawer.getByLabel('Klient').selectOption('cl_ola')
  await drawer.getByLabel('Godzina').fill('12:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('alert')).toContainText('Ten termin jest już zajęty')
  await expect(drawer.getByLabel('Godzina')).toHaveValue('12:00')

  await drawer.getByLabel('Godzina').fill('13:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('alert')).toContainText('Termin został zmieniony')
  await expect(drawer.getByLabel('Godzina')).toHaveValue('13:00')

  await drawer.getByLabel('Godzina').fill('14:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('alert')).toContainText('Nie udało się zapisać sesji.')
  await expect(drawer.getByLabel('Godzina')).toHaveValue('14:00')
  expect(attempts).toBe(3)
})
