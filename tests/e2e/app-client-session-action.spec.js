import { expect, test } from '@playwright/test'
import { ROLE_DEFAULT_CAPABILITIES } from '../../src/capabilities.js'

const json = (body) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

const freezeTime = async (page, iso) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript((frozen) => {
    const NativeDate = Date
    const frozenTime = new NativeDate(frozen).getTime()
    class FrozenDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [frozenTime])) }
      static now() { return frozenTime }
    }
    FrozenDate.parse = NativeDate.parse
    FrozenDate.UTC = NativeDate.UTC
    window.Date = FrozenDate
  }, iso)
}

const sessionFor = (capabilities) => {
  const csrfExpiresAt = '2030-01-01T00:00:00.000Z'
  return json({
    data: {
      actor: {
        id: 'stf_client_session_action',
        displayName: 'Alicja Sesje',
        email: 'alicja@example.test',
        professionalTitle: null,
        role: 'owner',
        specialistId: null,
        version: 1,
      },
      authorityRevision: 1,
      capabilities,
      csrfExpiresAt,
      csrfToken: `v1.${Date.parse(csrfExpiresAt) / 1000}.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      dataMode: 'fictional',
      environment: 'development',
    },
  })
}

const installSession = async (page, capabilities) => {
  await page.route('**/api/v1/session', (route) => route.fulfill(sessionFor(capabilities)))
}

const clientRecord = (overrides = {}) => ({
  id: 'cl_ola', name: 'Ola Aktywna', age: 12, status: 'active', version: 1,
  archivedAt: null, createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-01-10T09:00:00.000Z', readOnly: false,
  assignment: {
    id: 'asg_ola', specialistId: 'sp_anna',
    startsAt: '2026-01-10T09:00:00.000Z', version: 1,
  },
  ...overrides,
})

const installClientWorkspace = async (
  page, appointments = [], onRequest = () => {}, clients = [clientRecord()], specialists = [{
    id: 'sp_anna', displayName: 'Anna Nowak', professionalTitle: 'Specjalistka',
    standardRateGrosze: 18_000, status: 'active', version: 1, staffVersion: 1,
  }],
) => {
  await page.route('**/api/v1/workspace?*', (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    onRequest({ from, to })
    return route.fulfill(json({
      data: {
        window: {
          from,
          to,
          timeZone: 'Europe/Warsaw',
          complete: true,
        },
        specialists,
        clients,
        appointments: appointments.filter((appointment) => {
          const date = appointment.startsAt.slice(0, 10)
          return date >= from && date <= to
        }),
        historicalClients: [], historicalOccurrences: [], latestPopulatedMonth: null,
      },
    }))
  })
}

const createdAppointment = {
  id: 'apt_client_create', clientId: 'cl_ola', specialistId: 'sp_anna',
  serviceId: 'zajecia', startsAt: '2026-08-04T11:00:00.000Z',
  endsAt: '2026-08-04T11:50:00.000Z', timeZone: 'Europe/Warsaw', location: null,
  status: 'scheduled', source: 'panel', version: 1, cancelledAt: null,
  cancellationReason: null,
  createdAt: '2026-08-04T08:00:00.000Z', updatedAt: '2026-08-04T08:00:00.000Z',
  charge: {
    id: 'chg_client_create', serviceId: 'zajecia', expectedAmountGrosze: 18_000,
    currency: 'PLN', version: 1,
  },
  payment: {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 0,
    latestMethod: null, latestReceivedAt: null,
  },
  paymentEntries: [],
}

test('@owner client card opens the session drawer with the client preselected when creation is allowed', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  await installClientWorkspace(page)
  await page.goto('./#/client?id=cl_ola')

  await page.getByRole('button', { name: 'Umów sesję' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await expect(drawer.getByRole('combobox', { name: 'Klient' })).toHaveValue('Ola Aktywna')
})

test('@owner session picker offers active and paused clients', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  await installClientWorkspace(page, [], () => {}, [
    clientRecord({ id: 'cl_active', name: 'Ala Aktywna', assignment: { id: 'asg_active', specialistId: 'sp_anna', startsAt: '2026-01-10T09:00:00.000Z', version: 1 } }),
    clientRecord({ id: 'cl_paused', name: 'Pola Wstrzymana', status: 'paused', assignment: { id: 'asg_paused', specialistId: 'sp_anna', startsAt: '2026-01-10T09:00:00.000Z', version: 1 } }),
  ])
  await page.goto('./#/calendar?date=2026-08-04')
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  const picker = drawer.getByRole('combobox', { name: 'Klient' })
  await picker.focus()

  await expect(drawer.getByRole('option', { name: /Ala Aktywna/ })).toBeVisible()
  await expect(drawer.getByRole('option', { name: /Pola Wstrzymana/ })).toBeVisible()
  await picker.fill('Nieistniejąca osoba')
  await expect(drawer.getByText('Nie znaleziono takiego klienta', { exact: true })).toBeVisible()
  await picker.fill('Pola Wstrzymana')
  await picker.press('ArrowDown')
  await picker.press('Enter')
  await expect(picker).toHaveValue('Pola Wstrzymana')
  await drawer.getByLabel('Data').fill('2026-08-05')
  await drawer.getByRole('link', { name: 'Przejdź do Klientów' }).click()
  const leave = page.getByRole('alertdialog', { name: 'Wyjść bez zapisywania?' })
  await expect(leave).toBeVisible()
  await leave.getByRole('button', { name: 'Wróć do edycji' }).click()
  await expect(drawer).toBeVisible()
})

test('@owner cannot save a session when no active specialist is available', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  await installClientWorkspace(page, [], () => {}, [], [])
  await page.goto('./#/calendar?date=2026-08-04')
  await page.getByRole('button', { name: 'Nowa sesja' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })

  await expect(drawer).toContainText('Brak aktywnej specjalistki dostępnej do tej sesji.')
  await expect(drawer.getByRole('button', { name: 'Dodaj sesję' })).toBeDisabled()
})

test('@owner creates a client-card session and opens its highlighted day without a caller range', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const appointments = []
  await installClientWorkspace(page, appointments)
  await page.route('**/api/v1/appointments', async (route) => {
    appointments.push(createdAppointment)
    await route.fulfill({ ...json({ data: { appointment: createdAppointment } }), status: 201 })
  })
  await page.goto('./#/client?id=cl_ola')

  await page.getByRole('button', { name: 'Umów sesję' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await drawer.getByLabel('Data').fill('2026-08-04')
  await drawer.getByLabel('Godzina').fill('13:00')
  await drawer.getByRole('button', { name: 'Dodaj sesję' }).click()

  await expect(page).toHaveURL(/#\/calendar\?date=2026-08-04&highlightSessionIds=apt_client_create$/)
  await expect(page.getByText(/Sesja została dodana.*Ola Aktywna.*13:00.*180\s*zł/)).toBeVisible()
  await expect(page.getByText('Sesję zapisano, ale nie udało się odświeżyć Grafiku.', { exact: true })).toHaveCount(0)
})

test('@owner reschedules a client-card session across months through canonical source then destination windows', async ({ page }) => {
  await freezeTime(page, '2026-08-04T08:00:00.000Z')
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner)
  const source = {
    ...createdAppointment,
    id: 'apt_client_reschedule',
    startsAt: '2026-08-04T09:00:00.000Z',
    endsAt: '2026-08-04T09:50:00.000Z',
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-01T08:00:00.000Z',
    charge: { ...createdAppointment.charge, id: 'chg_client_reschedule' },
  }
  const appointments = [source]
  const refreshReads = []
  let editAccepted = false
  await installClientWorkspace(page, appointments, (range) => {
    if (editAccepted) refreshReads.push(range)
  })
  await page.route('**/api/v1/appointments/apt_client_reschedule/edits', async (route) => {
    const edited = {
      ...source,
      startsAt: '2026-09-02T09:00:00.000Z',
      endsAt: '2026-09-02T09:50:00.000Z',
      version: 2,
      updatedAt: '2026-08-04T08:05:00.000Z',
      charge: { ...source.charge, version: 2 },
    }
    appointments.splice(0, 1, edited)
    editAccepted = true
    await route.fulfill(json({ data: { appointment: edited } }))
  })

  await page.goto('./#/client?id=cl_ola')
  await page.getByRole('button', { name: 'Przełóż' }).click()
  const drawer = page.getByRole('dialog', { name: 'Przełóż sesję' })
  await expect(drawer.getByLabel('Data')).toBeFocused()
  await drawer.getByLabel('Data').fill('2026-09-02')
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()

  await expect.poll(() => refreshReads.slice(0, 2)).toEqual([
    { from: '2026-08-01', to: '2026-08-31' },
    { from: '2026-09-01', to: '2026-09-30' },
  ])
  await expect(page).toHaveURL(/#\/calendar\?date=2026-09-02&highlightSessionIds=apt_client_reschedule$/)
  await expect(page.getByText('Sesję zapisano, ale nie udało się odświeżyć Grafiku.', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edytuj sesję — Ola Aktywna, 11:00' })).toBeEnabled()
})

test('@owner client card hides session creation without appointment capability', async ({ page }) => {
  await installSession(page, ROLE_DEFAULT_CAPABILITIES.owner.filter(
    (capability) => capability !== 'appointment.manage',
  ))
  await installClientWorkspace(page)
  await page.goto('./#/client?id=cl_ola')

  await expect(page.getByRole('button', { name: 'Umów sesję' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Nowa sesja' })).toHaveCount(0)
})
