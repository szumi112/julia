import { test, expect } from '@playwright/test'

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const errorEnvelope = (status, code) => json(status, { error: { code } })

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

const activeSpecialist = {
  id: 'sp_anna', displayName: 'Anna Nowak', standardRateGrosze: 18_000,
  status: 'active', version: 3, staffVersion: 4,
}

const activeClient = {
  id: 'cl_active', name: 'Ola Aktywna', age: 12, status: 'active', version: 2,
  archivedAt: null, createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-07-10T09:00:00.000Z', readOnly: false,
  assignment: {
    id: 'asg_active', specialistId: 'sp_anna',
    startsAt: '2026-01-10T09:00:00.000Z', version: 1,
  },
}

const archivedClient = {
  id: 'cl_archived', name: 'Zofia Historyczna', age: 14, status: 'archived', version: 2,
  archivedAt: '2026-07-20T08:00:00.000Z', createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-07-20T08:00:00.000Z', readOnly: true, assignment: null,
}

const historicalAppointment = {
  id: 'apt_history', clientId: 'cl_archived', specialistId: 'sp_history',
  serviceId: 'zajecia', startsAt: '2026-07-15T08:30:00.000Z',
  endsAt: '2026-07-15T09:20:00.000Z', timeZone: 'Europe/Warsaw', location: null,
  status: 'completed', source: 'panel', version: 2, cancelledAt: null,
  createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-16T08:00:00.000Z',
  charge: {
    id: 'chg_history', serviceId: 'zajecia', expectedAmountGrosze: 18_000,
    currency: 'PLN', version: 1,
  },
  payment: {
    status: 'partial', collectedGrosze: 8_000, outstandingGrosze: 10_000,
    latestMethod: 'transfer', latestReceivedAt: '2026-07-16T10:00:00.000Z',
  },
  paymentEntries: [{
    id: 'pay_history', amountGrosze: 8_000, method: 'transfer',
    receivedAt: '2026-07-16T10:00:00.000Z', correctedAt: null, replacementEntryId: null,
  }],
}

const archivedScheduledAppointment = {
  ...historicalAppointment,
  status: 'scheduled',
  payment: {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
    latestMethod: null, latestReceivedAt: null,
  },
  paymentEntries: [],
}

const scheduledAppointment = {
  id: 'apt_scheduled', clientId: 'cl_active', specialistId: 'sp_anna',
  serviceId: 'zajecia', startsAt: '2026-07-15T11:00:00.000Z',
  endsAt: '2026-07-15T11:50:00.000Z', timeZone: 'Europe/Warsaw', location: 'Gabinet 1',
  status: 'scheduled', source: 'panel', version: 1, cancelledAt: null,
  createdAt: '2026-07-01T08:00:00.000Z', updatedAt: '2026-07-01T08:00:00.000Z',
  charge: {
    id: 'chg_scheduled', serviceId: 'zajecia', expectedAmountGrosze: 18_000,
    currency: 'PLN', version: 1,
  },
  payment: {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
    latestMethod: null, latestReceivedAt: null,
  },
  paymentEntries: [],
}

const cancelledAppointment = {
  ...scheduledAppointment,
  status: 'cancelled',
  version: 2,
  cancelledAt: '2026-07-16T10:00:00.000Z',
  updatedAt: '2026-07-16T10:00:00.000Z',
}

const completedAppointment = {
  ...scheduledAppointment,
  status: 'completed',
  version: 2,
  updatedAt: '2026-07-16T10:00:00.000Z',
  payment: {
    ...scheduledAppointment.payment,
    outstandingGrosze: 18_000,
  },
}

const paymentRecordedAppointment = {
  ...completedAppointment,
  version: 3,
  updatedAt: '2026-07-16T11:00:00.000Z',
  payment: {
    status: 'partial', collectedGrosze: 12_000, outstandingGrosze: 6_000,
    latestMethod: 'card', latestReceivedAt: '2026-01-04T11:00:00.000Z',
  },
  paymentEntries: [{
    id: 'pay_recorded', amountGrosze: 12_000, method: 'card',
    receivedAt: '2026-01-04T11:00:00.000Z', correctedAt: null, replacementEntryId: null,
  }],
}

const workspaceEnvelope = (from, to, appointment = null) => json(200, {
  data: {
    window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
    specialists: [activeSpecialist],
    clients: [activeClient],
    appointments: appointment === null ? [] : [appointment],
  },
})

const containsHistory = (from, to) => from <= '2026-07-15' && to >= '2026-07-15'

test('@owner renders only complete canonical workspace windows as read-only history', async ({ page }) => {
  const pageErrors = []
  let workspaceReads = 0
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (workspaceReads === 1 || (from === '2026-04-01' && to === '2026-04-30')) {
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    const history = containsHistory(from, to)
    await route.fulfill(json(200, {
      data: {
        window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
        specialists: [activeSpecialist],
        clients: history ? [activeClient, archivedClient] : [activeClient],
        appointments: history ? [historicalAppointment, scheduledAppointment] : [],
      },
    }))
  })

  await page.goto('./#/clients')
  await expect.poll(() => pageErrors).toEqual([])
  await expect(page.getByText('Alicja Testowa', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('status', { name: 'Stan kartoteki' })).toContainText('Wczytywanie kartoteki')
  await expect(page.getByText('Ola Aktywna', { exact: true })).toBeVisible()
  await expect(page.getByText('Zofia Historyczna', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Nie powinna się pojawić', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Dodaj klienta' })).toHaveCount(1)

  await page.goto('./#/dashboard')
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await expect(dashboard.getByText('Ola Aktywna', { exact: true }).first()).toBeVisible()
  await expect(dashboard.getByRole('button', { name: 'Otwórz sesję' })).toHaveCount(0)
  await expect(dashboard.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
  await expect(dashboard.getByRole('button', { name: 'Nowy klient' })).toHaveCount(0)
  await expect(dashboard.locator('button.today-session')).toHaveCount(0)

  await page.getByRole('button', { name: /Panel dnia/ }).click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit).toBeVisible()
  await expect(cockpit.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
  await expect(cockpit.getByRole('button', { name: 'Nowy klient' })).toHaveCount(0)
  await expect(cockpit.locator('button.cockpit__next, button.spine__row')).toHaveCount(0)
  await cockpit.getByRole('button', { name: 'Zamknij panel dnia' }).click()

  await page.goto('./#/team')
  await expect(page.getByRole('heading', { level: 1, name: /Zespół/ })).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Dodaj specjalistkę' })).toHaveCount(0)

  await page.goto('./#/psych?id=sp_anna')
  await expect(page.getByRole('heading', { level: 1, name: 'Anna Nowak' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Edytuj profil' })).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
  await expect(page.getByRole('main').locator('button.agenda__row')).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  const bottomNavigation = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  await expect(bottomNavigation.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: /Nowa sesja|Nowy klient/ })).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await expect(plan.getByText('Zofia Historyczna', { exact: true })).toBeVisible()
  await expect(plan.getByText('Archiwalny', { exact: true })).toBeVisible()
  await expect(plan).toContainText('Specjalistka niedostępna')
  const archivedRow = plan.locator('.agenda__row', { hasText: 'Zofia Historyczna' })
  await expect(archivedRow.getByRole('button', { name: /Edytuj sesję/ })).toHaveCount(0)
  await expect(archivedRow.getByRole('button', { name: /Status:/ })).toHaveCount(0)
  await expect(archivedRow.getByRole('button', { name: /Płatność:/ })).toHaveCount(0)

  await page.goto('./#/payments?ym=2026-07')
  const ledger = page.getByRole('table', { name: 'Lista rozliczeń' })
  await expect(ledger).toContainText('Zofia Historyczna')
  await expect(ledger).toContainText('Specjalistka niedostępna')
  await expect(page.getByRole('button', { name: 'Wszystkie okresy' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Zaksięguj wpłatę/ })).toHaveCount(0)

  await page.goto('./#/calendar?date=2026-04-15&ym=2026-04&mode=cal')
  await expect(page.getByRole('status', { name: 'Stan kalendarza' })).toContainText('Wczytywanie kalendarza')
  await expect(page.getByText('Brak sesji tego dnia', { exact: true })).toBeVisible()
  await expect(page.getByText('W tym kompletnym zakresie nie ma zaplanowanych sesji.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Poprzedni miesiąc' })).toBeEnabled()
  expect(pageErrors).toEqual([])
})

test('@owner does not drag a read-only Calendar appointment', async ({ page }) => {
  let edits = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(json(200, {
      data: {
        window: {
          from: url.searchParams.get('from'), to: url.searchParams.get('to'),
          timeZone: 'Europe/Warsaw', complete: true,
        },
        specialists: [activeSpecialist],
        clients: [archivedClient],
        appointments: [archivedScheduledAppointment],
      },
    }))
  })
  await page.route('**/api/v1/appointments/apt_history/edits', async (route) => {
    edits += 1
    await route.fulfill(errorEnvelope(500, 'UNEXPECTED'))
  })

  await page.goto('./#/calendar?date=2026-07-15&ym=2026-07&mode=cal')
  const source = page.locator('.cal__day[data-iso="2026-07-15"] .cal__item', { hasText: 'Zofia' })
  const target = page.locator('.cal__day[data-iso="2026-07-16"]')
  await expect(source).toBeVisible()
  await expect(source).not.toHaveClass(/is-draggable/)
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Calendar drag target is unavailable')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect.poll(() => edits).toBe(0)
})

test('@owner cancels a Calendar appointment through the canonical command and refreshes its covered range', async ({ page }) => {
  const cancellations = []
  let workspaceReads = 0
  let appointment = scheduledAppointment
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      appointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/cancellation', async (route) => {
    cancellations.push({ method: route.request().method(), body: route.request().postData() })
    appointment = cancelledAppointment
    await route.fulfill(json(200, { data: { appointment: cancelledAppointment } }))
  })

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  const status = plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' })
  await expect(status).toBeVisible()
  await status.click()
  await plan.getByRole('menuitemradio', { name: 'Odwołaj' }).click()

  await expect(plan.getByRole('button', { name: 'Status: Odwołana — Ola Aktywna, 13:00' })).toBeVisible()
  expect(cancellations).toEqual([{ method: 'POST', body: JSON.stringify({ expectedVersion: 1 }) }])
  await expect.poll(() => workspaceReads).toBe(2)
})

test('@owner changes a Calendar status through the canonical edit command and refreshes its covered range', async ({ page }) => {
  const edits = []
  let workspaceReads = 0
  let appointment = scheduledAppointment
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      appointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/edits', async (route) => {
    edits.push({ method: route.request().method(), body: route.request().postData() })
    appointment = completedAppointment
    await route.fulfill(json(200, { data: { appointment: completedAppointment } }))
  })

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' }).click()
  await plan.getByRole('menuitemradio', { name: 'Odbyta' }).click()

  await expect(plan.getByRole('button', { name: 'Status: Odbyta — Ola Aktywna, 13:00' })).toBeVisible()
  expect(edits).toEqual([{
    method: 'POST',
    body: JSON.stringify({
      expectedVersion: 1,
      specialistId: 'sp_anna',
      serviceId: 'zajecia',
      date: '2026-07-15',
      time: '13:00',
      durationMinutes: 50,
      expectedAmountGrosze: 18_000,
      location: 'Gabinet 1',
      status: 'completed',
    }),
  }])
  await expect.poll(() => workspaceReads).toBe(2)
})

test('@owner keeps the Calendar on canonical data after a cancellation conflict', async ({ page }) => {
  let workspaceReads = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      scheduledAppointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/cancellation', (route) => (
    route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  ))

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' }).click()
  await plan.getByRole('menuitemradio', { name: 'Odwołaj' }).click()

  await expect(plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' })).toBeVisible()
  await expect(page.getByText('Termin został zmieniony. Odświeżono kalendarz.', { exact: true })).toBeVisible()
  expect(workspaceReads).toBe(2)
})

test('@owner rolls a Calendar drag back after the canonical reschedule command conflicts', async ({ page }) => {
  const edits = []
  let workspaceReads = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      scheduledAppointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/edits', async (route) => {
    edits.push({ method: route.request().method(), body: route.request().postData() })
    await route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  })

  await page.goto('./#/calendar?date=2026-07-15&ym=2026-07&mode=cal')
  const source = page.locator('.cal__day[data-iso="2026-07-15"] .cal__item', { hasText: 'Ola' })
  const target = page.locator('.cal__day[data-iso="2026-07-16"]')
  await expect(source).toBeVisible()
  await expect(target).toBeVisible()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Calendar drag target is unavailable')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect.poll(() => edits.length).toBe(1)
  expect(edits).toEqual([{
    method: 'POST',
    body: JSON.stringify({
      expectedVersion: 1,
      specialistId: 'sp_anna',
      serviceId: 'zajecia',
      date: '2026-07-16',
      time: '13:00',
      durationMinutes: 50,
      expectedAmountGrosze: 18_000,
      location: 'Gabinet 1',
      status: 'scheduled',
    }),
  }])
  await expect.poll(() => workspaceReads).toBe(2)
  await expect(source).toBeVisible()
  await expect(target.locator('.cal__item', { hasText: 'Ola' })).toHaveCount(0)
})

test('@owner records a protected payment from Payments and reloads the canonical month', async ({ page }) => {
  const payments = []
  let workspaceReads = 0
  let appointment = completedAppointment
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      appointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/payments', async (route) => {
    payments.push({ method: route.request().method(), body: route.request().postData() })
    appointment = paymentRecordedAppointment
    await route.fulfill(json(200, { data: { appointment: paymentRecordedAppointment } }))
  })

  await page.goto('./#/payments?ym=2026-07')
  const ledger = page.getByRole('table', { name: 'Lista rozliczeń' })
  const row = ledger.locator('tbody tr', { hasText: 'Ola Aktywna' })
  await row.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
  const entry = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
  await entry.getByLabel('Kwota wpłaty').fill('120')
  await entry.getByLabel('Forma płatności').selectOption('card')
  await entry.getByLabel('Data wpłaty').fill('2026-01-04')
  await entry.getByRole('button', { name: 'Zapisz wpłatę' }).click()

  await expect(row).toContainText('120 zł')
  expect(payments).toEqual([{
    method: 'POST',
    body: JSON.stringify({
      expectedVersion: 2,
      amountGrosze: 12_000,
      method: 'card',
      receivedAt: '2026-01-04T11:00:00.000Z',
    }),
  }])
  await expect.poll(() => workspaceReads).toBe(2)
})

test('@owner keeps protected payment input after a command failure', async ({ page }) => {
  let workspaceReads = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      completedAppointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/payments', (route) => (
    route.fulfill(errorEnvelope(409, 'PAYMENT_AMOUNT_CONFLICT'))
  ))

  await page.goto('./#/payments?ym=2026-07')
  const row = page.getByRole('table', { name: 'Lista rozliczeń' })
    .locator('tbody tr', { hasText: 'Ola Aktywna' })
  await row.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
  const entry = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
  await entry.getByLabel('Kwota wpłaty').fill('120')
  await entry.getByLabel('Forma płatności').selectOption('card')
  await entry.getByLabel('Data wpłaty').fill('2026-01-04')
  await entry.getByRole('button', { name: 'Zapisz wpłatę' }).click()

  await expect(entry).toBeVisible()
  await expect(entry.getByLabel('Kwota wpłaty')).toHaveValue('120')
  await expect(entry.getByLabel('Forma płatności')).toHaveValue('card')
  await expect(entry.getByLabel('Data wpłaty')).toHaveValue('2026-01-04')
  await expect(entry.getByText('Nie udało się zaksięgować wpłaty.', { exact: true })).toBeVisible()
  expect(workspaceReads).toBe(1)
})

test('@owner cannot replay an accepted payment after an unrelated canonical load', async ({ page }) => {
  const payments = []
  let workspaceReads = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    workspaceReads += 1
    const url = new URL(route.request().url())
    if (workspaceReads === 1) {
      await route.fulfill(workspaceEnvelope(
        url.searchParams.get('from'), url.searchParams.get('to'), completedAppointment,
      ))
      return
    }
    if (workspaceReads === 2) {
      await route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
      return
    }
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'), url.searchParams.get('to'), null,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/payments', async (route) => {
    payments.push({ method: route.request().method(), body: route.request().postData() })
    await route.fulfill(json(200, { data: { appointment: paymentRecordedAppointment } }))
  })

  await page.goto('./#/payments?ym=2026-07')
  const row = page.getByRole('table', { name: 'Lista rozliczeń' })
    .locator('tbody tr', { hasText: 'Ola Aktywna' })
  await row.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
  const entry = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
  await entry.getByLabel('Kwota wpłaty').fill('120')
  await entry.getByLabel('Forma płatności').selectOption('card')
  await entry.getByLabel('Data wpłaty').fill('2026-01-04')
  await entry.getByRole('button', { name: 'Zapisz wpłatę' }).click()
  await expect.poll(() => workspaceReads).toBe(2)

  await page.goto('./#/calendar?date=2026-06-15&ym=2026-06&mode=cal')
  await expect.poll(() => workspaceReads).toBe(3)
  await page.goto('./#/payments?ym=2026-07')
  await expect(row.getByRole('button', { name: /Zaksięguj wpłatę/ })).toBeDisabled()
  expect(payments).toHaveLength(1)
})
