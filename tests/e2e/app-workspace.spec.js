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
  id: 'sp_anna', displayName: 'Anna Nowak', professionalTitle: 'Specjalistka',
  standardRateGrosze: 18_000,
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
  cancellationReason: null,
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
  cancellationReason: null,
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
  cancellationReason: 'client',
  updatedAt: '2026-07-16T10:00:00.000Z',
}

const restoredAppointment = {
  ...scheduledAppointment,
  version: 3,
  updatedAt: '2026-07-16T11:00:00.000Z',
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

const currentWeekSpecialist = {
  ...activeSpecialist,
  id: 'sp_local_specialist',
  displayName: 'Zofia Fikcyjna',
}

const currentWeekClient = {
  ...activeClient,
  assignment: {
    ...activeClient.assignment,
    specialistId: currentWeekSpecialist.id,
  },
}

const currentWeekAppointment = {
  ...scheduledAppointment,
  specialistId: currentWeekSpecialist.id,
}

const currentWeekCompletedAppointment = {
  ...completedAppointment,
  specialistId: currentWeekSpecialist.id,
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

const correctedPaymentAppointment = {
  ...paymentRecordedAppointment,
  version: 4,
  updatedAt: '2026-07-16T12:00:00.000Z',
  payment: {
    status: 'partial', collectedGrosze: 10_000, outstandingGrosze: 8_000,
    latestMethod: 'transfer', latestReceivedAt: '2026-01-05T11:00:00.000Z',
  },
  paymentEntries: [
    {
      id: 'pay_recorded', amountGrosze: 12_000, method: 'card',
      receivedAt: '2026-01-04T11:00:00.000Z',
      correctedAt: '2026-07-16T12:00:00.000Z', replacementEntryId: 'pay_replacement',
    },
    {
      id: 'pay_replacement', amountGrosze: 10_000, method: 'transfer',
      receivedAt: '2026-01-05T11:00:00.000Z', correctedAt: null, replacementEntryId: null,
    },
  ],
}

const reversedPaymentAppointment = {
  ...paymentRecordedAppointment,
  version: 4,
  updatedAt: '2026-07-16T12:00:00.000Z',
  payment: {
    status: 'unpaid', collectedGrosze: 0, outstandingGrosze: 18_000,
    latestMethod: null, latestReceivedAt: null,
  },
  paymentEntries: [{
    ...paymentRecordedAppointment.paymentEntries[0],
    correctedAt: '2026-07-16T12:00:00.000Z', replacementEntryId: null,
  }],
}

const historicalWorkbookClient = {
  id: 'hcl_workbook_history', name: 'Historia bez godziny', status: 'historical',
  activeClientId: null, version: 1,
  createdAt: '2026-07-20T08:00:00.000Z', updatedAt: '2026-07-20T08:00:00.000Z',
}

const historicalWorkbookOccurrence = {
  id: 'hoc_workbook_history', historicalClientId: 'hcl_workbook_history',
  counterparty: null, specialistId: 'sp_anna', serviceId: 'zajecia',
  serviceLabel: 'Wizyta historyczna bez godziny',
  period: { precision: 'month', day: null, month: '2026-07' },
  status: 'recorded', version: 1, sourceRecordId: 'wbs_workbook_history',
  createdAt: '2026-07-20T08:00:00.000Z', updatedAt: '2026-07-20T08:00:00.000Z',
}

const workspaceData = (from, to, {
  specialists = [activeSpecialist],
  clients = [activeClient],
  appointments = [],
  historicalClients = [],
  historicalOccurrences = [],
  latestPopulatedMonth = null,
} = {}) => ({
  window: { from, to, timeZone: 'Europe/Warsaw', complete: true },
  specialists,
  clients,
  appointments,
  historicalClients,
  historicalOccurrences,
  latestPopulatedMonth,
})

const workspaceEnvelope = (from, to, appointment = null) => json(200, {
  data: workspaceData(from, to, {
    appointments: appointment === null ? [] : [appointment],
  }),
})

const financeMonths = (selectedMonth) => {
  const [year, month] = selectedMonth.split('-').map(Number)
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 6 + index, 1))
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

const zeroFinanceKpis = () => ({
  revenueGrosze: 0, collectedGrosze: 0, outstandingGrosze: 0,
  expensesGrosze: 0, incomeGrosze: 0, verificationGrosze: 0,
})

// This mirrors the complete GET /api/v1/finance/window DTO.  Finance owns the
// ledger amounts; workspace only supplies the appointment used by payment actions.
const financeWindow = (selectedMonth, appointment = null, specialistLabels = [
  { id: activeSpecialist.id, label: activeSpecialist.displayName },
]) => {
  const paymentTotals = (appointment?.paymentEntries ?? [])
    .filter(({ correctedAt }) => correctedAt === null)
    .reduce((totals, { method, amountGrosze }) => {
      totals.set(method, (totals.get(method) ?? 0) + amountGrosze)
      return totals
    }, new Map())
  paymentTotals.set('outstanding', appointment === null ? 0 : appointment.payment.outstandingGrosze)
  paymentTotals.set('verification', 0)
  const paymentSplit = Object.fromEntries([...paymentTotals.entries()]
    .sort(([left], [right]) => left.localeCompare(right)))
  const row = appointment === null ? null : {
    id: `fin_${appointment.id.slice(4)}`, sourceKind: 'panel', appointmentId: appointment.id,
    accountingMonth: selectedMonth, occurredOn: appointment.startsAt.slice(0, 10),
    kind: 'income', recordType: 'income',
    revenueGrosze: appointment.charge.expectedAmountGrosze,
    receivableGrosze: appointment.charge.expectedAmountGrosze,
    collectedGrosze: appointment.payment.collectedGrosze, expenseGrosze: 0,
    specialistId: appointment.specialistId, serviceId: appointment.serviceId,
    program: null, paymentMethod: 'unknown', invoiceStatus: 'not_required',
    version: Math.max(appointment.version, appointment.charge.version),
    settlementStatus: appointment.payment.status, counterparty: null, sourceLabel: null,
  }
  const revenueGrosze = row?.revenueGrosze ?? 0
  const collectedGrosze = row?.collectedGrosze ?? 0
  const selected = {
    revenueGrosze, collectedGrosze, outstandingGrosze: revenueGrosze - collectedGrosze,
    expensesGrosze: 0, incomeGrosze: revenueGrosze, verificationGrosze: 0,
  }
  const months = financeMonths(selectedMonth)
  return {
    currentMonth: '2026-07', selectedMonth, fromMonth: months[0], toMonth: selectedMonth,
    months, latestPopulatedMonth: row ? selectedMonth : null, kpis: selected,
    trend: months.map((month) => ({
      month, ...(month === selectedMonth ? selected : zeroFinanceKpis()),
    })),
    splits: {
      specialist: row ? { [row.specialistId]: revenueGrosze } : {},
      service: row ? { zajecia: revenueGrosze } : {},
      payment: paymentSplit,
      invoice: row ? { not_required: { count: 1, revenueGrosze } } : {},
      program: {
        english: { count: 0, revenueGrosze: 0 },
        tus: { count: 0, revenueGrosze: 0 },
      },
    },
    specialistLabels: row ? specialistLabels : [], rows: row ? [row] : [],
    coverage: {
      dateOnlyCount: 0, monthOnlyCount: 0, timedCount: row ? 1 : 0, unknownCount: 0,
    },
    unknownPeriodCount: 0, complete: true,
  }
}

const containsHistory = (from, to) => from <= '2026-07-15' && to >= '2026-07-15'

test('@owner exposes protected activities and waits for a complete monthly report', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  let startFinance
  let releaseFinance
  const financeStarted = new Promise((resolve) => { startFinance = resolve })
  const financeReleased = new Promise((resolve) => { releaseFinance = resolve })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      completedAppointment,
    ))
  })
  await page.route('**/api/v1/finance/window?*', async (route) => {
    startFinance()
    await financeReleased
    await route.fulfill(json(200, { data: financeWindow('2026-07', completedAppointment) }))
  })

  await page.goto('./#/tus')
  await expect(page.locator('.topbar__title b')).toHaveText('Zajęcia TUS')
  await expect(page.getByRole('link', { name: 'Zajęcia TUS', exact: true })).toHaveCount(1)

  await page.goto('./#/team')
  await expect(page.getByRole('status', { name: 'Stan zespołu' })).toContainText('Wczytuję zespół')
  await expect(page.getByRole('heading', { level: 1, name: /Zespół/ })).toBeVisible()
  const protectedSpecialistName = page.getByRole('heading', { level: 2, name: 'Anna Nowak', exact: true })
  await expect(protectedSpecialistName).toBeVisible()
  expect(await protectedSpecialistName.evaluate((heading) => heading.textContent)).toBe('Anna Nowak')
  await expect(page.getByRole('main')).not.toContainText('undefined')
  await expect(page.getByRole('link', { name: 'Otwórz profil — Anna Nowak' })).toHaveCount(0)

  await page.goto('./#/psych?id=sp_anna')
  await expect(page.locator('.topbar__title b')).toHaveText('Profil specjalistki')
  await expect(page.getByRole('heading', { level: 1, name: 'Anna Nowak' })).toBeVisible()

  await page.goto('./#/settings')
  await expect(page.getByText('Google Calendar', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('form', { name: 'Zespół i stawki' })).toHaveCount(0)
  await expect(page.getByRole('form', { name: 'Dane centrum' })).toHaveCount(0)

  await page.goto('./#/reports?ym=2026-07')
  await financeStarted
  await expect(page.getByRole('status').filter({ hasText: 'Wczytuję raport…' })).toBeVisible()
  releaseFinance()
  await expect(page.getByRole('heading', { level: 1, name: 'Raport — lipiec 2026' })).toBeVisible()
  await expect(page.locator('.month-nav__label')).toHaveText('Lipiec 2026')
  await expect(page.getByRole('heading', { name: 'Zajęcia grupowe TUS' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Eksport (demo)' })).toHaveCount(0)
})

test('@owner falls back from invalid civil report months without rendering errors', async ({ page }) => {
  const pageErrors = []
  const financeRequests = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    await route.fulfill(workspaceEnvelope(from, to, completedAppointment))
  })
  await page.route('**/api/v1/finance/window?*', async (route) => {
    const month = new URL(route.request().url()).searchParams.get('month')
    financeRequests.push(month)
    await route.fulfill(json(200, { data: financeWindow(month, completedAppointment) }))
  })

  for (const ym of ['2025-00', '2025-13']) {
    await page.goto(`./#/reports?ym=${ym}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Raport — lipiec 2026' })).toBeVisible()
    await expect(page.locator('.month-nav__label')).toHaveText('Lipiec 2026')
  }

  expect(pageErrors).toEqual([])
  expect(financeRequests.length).toBeGreaterThanOrEqual(2)
  expect(financeRequests.every((month) => month === '2026-07')).toBe(true)
})

test('@owner keeps untimed workbook history outside Calendar sessions', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(json(200, { data: workspaceData(
      url.searchParams.get('from'), url.searchParams.get('to'), {
        appointments: [scheduledAppointment],
        historicalClients: [historicalWorkbookClient],
        historicalOccurrences: [historicalWorkbookOccurrence],
        latestPopulatedMonth: '2026-07',
      },
    ) }))
  })

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await expect(plan.getByText('Ola Aktywna', { exact: true })).toBeVisible()
  await expect(plan.getByText('Historia bez godziny', { exact: true })).toHaveCount(0)
  await expect(plan.getByText('Wizyta historyczna bez godziny', { exact: true }))
    .toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test('@owner opens the Calendar week picker', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      completedAppointment,
    ))
  })

  await page.goto('./#/calendar?date=2026-07-15')
  await expect(page.getByRole('region', { name: 'Plan dnia' })).toBeVisible()
  await page.getByRole('button', { name: /^Wybierz tydzień:/ }).click()
  const picker = page.getByRole('dialog', { name: 'Wybierz tydzień' })
  await expect(picker.getByText('lipiec', { exact: true })).toBeVisible()
  await picker.getByRole('button', { name: 'Następny miesiąc' }).click()
  await expect(page).toHaveURL(/#\/calendar\?date=2026-08-01/)
})

test('@owner keeps the Calendar Weekend choice after reload', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      scheduledAppointment,
    ))
  })

  await page.goto('./#/calendar?date=2026-07-15&mode=cal')
  const weekends = page.getByRole('button', { name: 'Weekendy', exact: true })
  await expect(weekends).toHaveAttribute('aria-pressed', 'true')
  await weekends.click()
  await expect(weekends).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.cal__dow')).toHaveCount(5)
  expect(await page.evaluate(() => localStorage.getItem('bwm.calendar.weekends'))).toBe('false')

  await page.reload()
  await expect(page.getByRole('button', { name: 'Weekendy', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.cal__dow')).toHaveCount(5)
})

test('@owner keeps full Calendar day titles with counts below them', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      scheduledAppointment,
    ))
  })

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  const planTitle = plan.locator('.agenda-day__title-text')
  await expect(planTitle).toContainText('Środa, 15 lipca')
  await expect(plan.locator('.agenda-day__count')).toContainText('sesja')
  await expect(page.locator('.cal-toolbar > .faint')).toHaveCount(0)
  expect(await planTitle.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap')

  await page.getByRole('radio', { name: 'Miesiąc' }).click()
  const dayPanel = page.locator('.cal-day-panel')
  await expect(dayPanel.locator('.cal-day-panel__title-text')).toContainText('Środa, 15 lipca')
  await expect(dayPanel.locator('.cal-day-panel__count')).toContainText('sesja')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('radio', { name: 'Plan dnia' }).click()
  await page.goto('./#/calendar?date=2026-07-16')
  await expect(plan.locator('.agenda-day__title-text')).toContainText('Czwartek, 16 lipca')
  await expect(plan.locator('.agenda-day__count')).toHaveCount(0)
  await expect(plan.getByText('Brak sesji tego dnia', { exact: true })).toBeVisible()
})

test('@owner lands on a populated dashboard before visiting any other view', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  const windows = []
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    windows.push([from, to])
    await route.fulfill(workspaceEnvelope(
      from,
      to,
      from === '2026-07-13' ? scheduledAppointment : null,
    ))
  })

  await page.goto('./#/dashboard')
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await expect(dashboard.getByText('Ola Aktywna', { exact: true }).first()).toBeVisible()
  await expect(dashboard.getByText('Wolny dzień', { exact: true })).toHaveCount(0)
  await expect(page.locator('.today-card')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Panel dnia:/ })).toHaveCount(0)
  await expect.poll(() => windows.length).toBe(2)
  expect(windows).toContainEqual(['2026-07-13', '2026-07-19'])
  expect(windows).toContainEqual(['2026-04-14', '2026-07-15'])
  expect(pageErrors).toEqual([])
})

test('@owner reuses the in-flight current week request when navigating to Dziś', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  const currentWeek = { from: '2026-07-13', to: '2026-07-19' }
  let currentWeekReads = 0
  let releaseWorkspace
  const workspaceReleased = new Promise((resolve) => { releaseWorkspace = resolve })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from !== currentWeek.from || to !== currentWeek.to) {
      await route.fulfill(workspaceEnvelope(from, to))
      return
    }
    currentWeekReads += 1
    await workspaceReleased
    await route.fulfill(workspaceEnvelope(
      from,
      to,
      scheduledAppointment,
    ))
  })

  await page.goto('./#/settings')
  await expect.poll(() => currentWeekReads).toBe(1)
  await page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Dziś' }).click()
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await expect(dashboard.getByText('Wczytuję grafik dnia…', { exact: true })).toBeVisible()
  await page.waitForTimeout(100)

  try {
    expect(currentWeekReads).toBe(1)
  } finally {
    releaseWorkspace()
  }
  await expect(dashboard.getByText('Ola Aktywna', { exact: true }).first()).toBeVisible()
  await expect(dashboard.getByText('Wolny dzień', { exact: true })).toHaveCount(0)
  expect(currentWeekReads).toBe(1)
})

test('@all loads one current week for the day panel outside Dziś without false empty copy', async ({ page }, testInfo) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  const windows = []
  let releaseWorkspace
  const workspaceReleased = new Promise((resolve) => { releaseWorkspace = resolve })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    windows.push([from, to])
    await workspaceReleased
    await route.fulfill(json(200, { data: workspaceData(from, to, {
      specialists: [currentWeekSpecialist],
      clients: [currentWeekClient],
      appointments: [currentWeekAppointment],
    }) }))
  })

  await page.goto('./#/settings')
  await expect.poll(() => windows).toEqual([['2026-07-13', '2026-07-19']])
  try {
    await expect(page.getByRole('button', { name: 'Panel dnia: Grafik dnia…' })).toBeVisible()
    await expect(page.locator('.today-card')).toHaveCount(0)
    await expect(page.getByText('Wolny dzień', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Dziś bez sesji', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Wszystkie sesje rozliczone', { exact: true })).toHaveCount(0)
  } finally {
    releaseWorkspace()
  }

  const chip = page.getByRole('button', { name: 'Panel dnia: Następna o 13:00 · Ola A.' })
  await expect(chip).toBeVisible()
  await chip.click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit.getByText('Ola Aktywna', { exact: true }).first()).toBeVisible()
  await expect(cockpit.getByText('Dziś bez sesji', { exact: true })).toHaveCount(0)
  await expect(cockpit.getByText('Wszystkie sesje rozliczone', { exact: true })).toHaveCount(0)
  if (testInfo.project.name !== 'specialist') {
    await expect(cockpit.getByText('Brak zaległości w tym tygodniu', { exact: true })).toBeVisible()
  }
  expect(windows).toEqual([['2026-07-13', '2026-07-19']])
})

test('@owner reports an unavailable current week without claiming an empty day', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  let reads = 0
  await page.route('**/api/v1/workspace?*', async (route) => {
    reads += 1
    await route.fulfill(errorEnvelope(503, 'INTERNAL_ERROR'))
  })

  await page.goto('./#/settings')

  const chip = page.getByRole('button', { name: 'Panel dnia: Grafik dnia niedostępny' })
  await expect(chip).toBeVisible()
  await expect(page.locator('.today-card')).toHaveCount(0)
  await expect(page.getByText('Wolny dzień', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Dziś bez sesji', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Wszystkie sesje rozliczone', { exact: true })).toHaveCount(0)
  await chip.click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit.getByText('Grafik dnia niedostępny', { exact: true })).toBeVisible()
  await expect(cockpit.getByText('Dziś bez sesji', { exact: true })).toHaveCount(0)
  expect(reads).toBe(1)
})

test('@owner labels dashboard debt with its loaded 93-day range', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  const windows = []
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    windows.push([from, to])
    const dashboardBalance = {
      ...completedAppointment,
      id: 'apt_dashboard_due',
      startsAt: '2026-04-14T08:00:00.000Z',
      endsAt: '2026-04-14T08:50:00.000Z',
      payment: {
        status: 'partial', collectedGrosze: 6_000, outstandingGrosze: 12_000,
        latestMethod: 'transfer', latestReceivedAt: '2026-04-14T10:00:00.000Z',
      },
      paymentEntries: [{
        id: 'pay_dashboard_due', amountGrosze: 6_000, method: 'transfer',
        receivedAt: '2026-04-14T10:00:00.000Z', correctedAt: null, replacementEntryId: null,
      }],
    }
    await route.fulfill(workspaceEnvelope(
      from,
      to,
      from === '2026-04-14' ? dashboardBalance : null,
    ))
  })

  await page.goto('./#/dashboard')
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await expect.poll(() => windows).toContainEqual(['2026-04-14', '2026-07-15'])
  await expect(dashboard.getByText('Do zapłaty (ostatnie 3 miesiące)', { exact: true })).toBeVisible()
  await expect(dashboard.getByText('120 zł', { exact: true })).toBeVisible()
  const due = dashboard.getByRole('button', { name: /Do zapłaty \(ostatnie 3 miesiące\)/ })
  await expect(due).toContainText('Pokaż ›')
  await due.click()
  await expect(page).toHaveURL(/#\/payments(?:\?.*)?$/)
  expect(page.url()).not.toContain('allPeriods')
  expect(page.url()).not.toContain('unpaidOnly')
})

test('@coordinator loads the same 93-day dashboard balance range', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  const windows = []
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    windows.push([from, to])
    await route.fulfill(workspaceEnvelope(from, to))
  })

  await page.goto('./#/dashboard')
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await expect.poll(() => windows).toContainEqual(['2026-04-14', '2026-07-15'])
  await expect(dashboard.getByText('Do zapłaty (ostatnie 3 miesiące)', { exact: true })).toBeVisible()
})

test('@specialist shows only today’s billable sessions without the centre balance request', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  const windows = []
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    windows.push([from, to])
    await route.fulfill(workspaceEnvelope(from, to, {
      ...currentWeekCompletedAppointment,
      payment: {
        status: 'partial', collectedGrosze: 8_000, outstandingGrosze: 10_000,
        latestMethod: 'card', latestReceivedAt: '2026-07-15T14:00:00.000Z',
      },
      paymentEntries: [{
        id: 'pay_specialist_dashboard_due', amountGrosze: 8_000, method: 'card',
        receivedAt: '2026-07-15T14:00:00.000Z', correctedAt: null, replacementEntryId: null,
      }],
    }))
  })

  await page.goto('./#/dashboard')
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await expect(dashboard.getByText('Do zapłaty za dzisiejsze sesje', { exact: true })).toBeVisible()
  await expect(dashboard.getByText('100 zł', { exact: true })).toBeVisible()
  await dashboard.getByRole('button', { name: /Do zapłaty za dzisiejsze sesje/ }).click()
  await expect(page).toHaveURL(/#\/payments$/)
  expect(windows).not.toContainEqual(['2026-04-14', '2026-07-15'])
})

test('@owner keeps dashboard figures neutral and retries every required window after an error', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  let weekReads = 0
  let balanceReads = 0
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('from') === '2026-04-14') {
      balanceReads += 1
      await route.fulfill(errorEnvelope(503, 'INTERNAL_ERROR'))
      return
    }
    weekReads += 1
    await route.fulfill(workspaceEnvelope(url.searchParams.get('from'), url.searchParams.get('to')))
  })

  await page.goto('./#/dashboard')
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  const figures = dashboard.getByRole('group', { name: 'Podsumowanie dnia' })
  await expect(dashboard.getByText('Nie udało się wczytać całego podsumowania dnia', { exact: true })).toBeVisible()
  await expect(dashboard.getByText('Nie pokazujemy niepełnych danych. Spróbuj ponownie.', { exact: true })).toBeVisible()
  await expect(dashboard.getByText('Nie udało się wczytać grafiku dnia', { exact: true })).toHaveCount(0)
  await expect(dashboard.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
  await expect(dashboard.getByRole('button')).toHaveCount(1)
  await expect(figures.locator('.figures__value')).toHaveText(['-', '-', '-', '-'])
  await dashboard.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect.poll(() => balanceReads).toBe(2)
  expect(weekReads).toBe(1)
})

test('@owner shows only the retry action after a covered Dashboard refresh fails', async ({ page }) => {
  await freezeTime(page, '2026-07-15T12:00:00.000Z')
  let refreshFailed = false
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    if (refreshFailed && url.searchParams.get('from') === '2026-07-13'
      && url.searchParams.get('to') === '2026-07-19') {
      await route.fulfill(errorEnvelope(503, 'INTERNAL_ERROR'))
      return
    }
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      scheduledAppointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/edits', async (route) => {
    refreshFailed = true
    await route.fulfill(json(200, { data: { appointment: completedAppointment } }))
  })

  await page.goto('./#/dashboard')
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await expect(dashboard.getByRole('button', { name: 'Nowa sesja' })).toBeVisible()

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' }).click()
  await plan.getByRole('menuitemradio', { name: 'Odbyta' }).click()
  await expect(page.getByText('Status sesji zapisano, ale nie udało się odświeżyć Grafiku.', { exact: true })).toBeVisible()

  await page.goto('./#/dashboard')
  await expect(dashboard.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
  await expect(dashboard.getByRole('button', { name: 'Spróbuj ponownie' })).toHaveCount(1)
})

test('@owner recovers Dashboard after an unrelated range failure and keeps the phone action gated', async ({ page }) => {
  const windows = []
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    windows.push([from, to])
    if (from === '2026-08-01' && to === '2026-08-31') {
      await route.fulfill(errorEnvelope(503, 'INTERNAL_ERROR'))
      return
    }
    await route.fulfill(workspaceEnvelope(from, to, scheduledAppointment))
  })

  await page.goto('./#/dashboard')
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await expect(dashboard.getByRole('button', { name: 'Nowa sesja' })).toBeVisible()
  await expect.poll(() => windows).toContainEqual(['2026-04-14', '2026-07-15'])

  await page.goto('./#/calendar?date=2026-08-15&ym=2026-08&mode=cal')
  await expect(page.getByRole('alert', { name: 'Stan Grafiku' })).toContainText('Grafik jest teraz niedostępny')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./#/dashboard')
  await expect(dashboard.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
  await expect(dashboard.getByRole('button', { name: 'Spróbuj ponownie' })).toHaveCount(1)
  const tabbar = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  await expect(tabbar.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)

  await dashboard.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect.poll(() => windows.filter(([from, to]) => (
    (from === '2026-07-13' && to === '2026-07-19')
      || (from === '2026-04-14' && to === '2026-07-15')
  )).length).toBe(4)
  await expect(dashboard.getByRole('button', { name: 'Nowa sesja' })).toBeVisible()
  await expect(tabbar.getByRole('button', { name: 'Nowa sesja' })).toBeVisible()
})

for (const state of [
  {
    label: 'upcoming',
    now: '2026-07-15T08:00:00.000Z',
    appointment: currentWeekAppointment,
    chip: 'Panel dnia: Następna o 13:00 · Ola A.',
    animation: 'none',
  },
  {
    label: 'running',
    now: '2026-07-15T11:20:00.000Z',
    appointment: currentWeekAppointment,
    chip: 'Panel dnia: Teraz: Ola A., do 13:50',
    animation: 'chip-breathe',
  },
  {
    label: 'finished',
    now: '2026-07-15T18:00:00.000Z',
    appointment: currentWeekCompletedAppointment,
    chip: 'Panel dnia: Na dziś to wszystko',
    animation: 'none',
  },
  {
    label: 'empty',
    now: '2026-07-15T08:00:00.000Z',
    appointment: null,
    chip: 'Panel dnia: Dziś bez sesji',
    animation: 'none',
  },
]) {
  test(`@owner day chip renders the ${state.label} state truthfully`, async ({ page }) => {
    await freezeTime(page, state.now)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.route('**/api/v1/workspace?*', async (route) => {
      const url = new URL(route.request().url())
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      await route.fulfill(json(200, { data: workspaceData(from, to, {
        specialists: [currentWeekSpecialist],
        clients: [currentWeekClient],
        appointments: state.appointment === null ? [] : [state.appointment],
      }) }))
    })

    await page.goto('./#/settings')

    const chip = page.getByRole('button', { name: state.chip })
    await expect(chip).toBeVisible()
    await expect(chip.locator('.today-chip__dot')).toHaveCSS('animation-name', state.animation)
    await chip.click()
    const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
    if (state.label === 'finished') {
      await expect(cockpit.getByText('Na dziś to wszystko', { exact: true })).toBeVisible()
      await expect(cockpit.getByText('Dziś bez sesji', { exact: true })).toHaveCount(0)
      await expect(cockpit.getByText('Ola Aktywna', { exact: true })).toBeVisible()
      await expect(cockpit.getByText('Do zapłaty (ten tydzień)', { exact: false })).toBeVisible()
      await expect(cockpit).toContainText('180 zł')
    }
    if (state.label === 'empty') {
      await expect(cockpit.getByText('Dziś bez sesji', { exact: true })).toBeVisible()
    }
  })
}

for (const [label, status, code] of [
  ['an infrastructure failure', 500, 'INTERNAL_ERROR'],
  ['a rejected request', 400, 'VALIDATION_FAILED'],
]) {
  test(`@owner recovers the client directory with one retry after ${label}`, async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await freezeTime(page, '2026-07-15T08:00:00.000Z')
    let directoryReads = 0
    await page.route('**/api/v1/workspace?*', async (route) => {
      const url = new URL(route.request().url())
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      if (from === '2026-04-14' && to === '2026-07-15') directoryReads += 1
      if (directoryReads === 1 && from === '2026-04-14' && to === '2026-07-15') {
        await route.fulfill(json(status, {
          error: { code, correlationId: '11111111-1111-4111-8111-111111111111' },
        }))
        return
      }
      await route.fulfill(workspaceEnvelope(from, to))
    })

    await page.goto('./#/clients')
    const directoryState = page.getByLabel('Stan kartoteki')
    await expect(directoryState).toContainText('Kartoteka jest teraz niedostępna')
    await directoryState.getByRole('button', { name: 'Spróbuj ponownie' }).click()

    await expect(page.getByText('Ola Aktywna', { exact: true })).toBeVisible()
    expect(directoryReads).toBe(2)
    expect(pageErrors).toEqual([])
  })
}

test('@owner keeps a repeated workspace retry failure handled by the UI', async ({ page }) => {
  const pageErrors = []
  let directoryReads = 0
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('from') === '2026-04-14' && url.searchParams.get('to') === '2026-07-15') {
      directoryReads += 1
      await route.fulfill(errorEnvelope(503, 'INTERNAL_ERROR'))
      return
    }
    await route.fulfill(workspaceEnvelope(url.searchParams.get('from'), url.searchParams.get('to')))
  })

  await page.goto('./#/clients')
  const directoryState = page.getByRole('alert', { name: 'Stan kartoteki' })
  await expect(directoryState).toContainText('Kartoteka jest teraz niedostępna')
  await directoryState.getByRole('button', { name: 'Spróbuj ponownie' }).click()
  await expect.poll(() => directoryReads).toBe(2)
  await expect(directoryState).toContainText('Kartoteka jest teraz niedostępna')
  expect(pageErrors).toEqual([])
})

test('@owner renders only complete canonical workspace windows as read-only history', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if ((from === '2026-04-14' && to === '2026-07-15')
      || (from === '2026-04-01' && to === '2026-04-30')) {
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    const history = containsHistory(from, to)
    await route.fulfill(json(200, { data: workspaceData(from, to, {
      clients: history ? [activeClient, archivedClient] : [activeClient],
      appointments: history ? [historicalAppointment, scheduledAppointment] : [],
    }) }))
  })
  await page.route('**/api/v1/finance/window?*', async (route) => {
    const month = new URL(route.request().url()).searchParams.get('month')
    await route.fulfill(json(200, { data: financeWindow(month, historicalAppointment, [{
      id: 'sp_history', label: 'Specjalistka archiwalna',
    }]) }))
  })

  await page.goto('./#/clients')
  await expect.poll(() => pageErrors).toEqual([])
  await expect(page.getByText('Alicja Testowa', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('status', { name: 'Stan kartoteki' })).toContainText('Wczytuję kartotekę')
  await expect(page.getByText('Ola Aktywna', { exact: true })).toBeVisible()
  await expect(page.getByText('Zofia Historyczna', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Nie powinna się pojawić', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Dodaj klienta' })).toHaveCount(1)

  await page.goto('./#/dashboard')
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  await expect(dashboard.getByText('Ola Aktywna', { exact: true }).first()).toBeVisible()
  await expect(dashboard.getByRole('button', { name: 'Otwórz sesję' })).toHaveCount(0)
  await expect(dashboard.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(1)
  await expect(dashboard.getByRole('button', { name: 'Nowy klient' })).toHaveCount(0)
  await expect(dashboard.locator('button.today-session')).toHaveCount(0)

  await page.goto('./#/settings')
  await page.getByRole('button', { name: /Panel dnia/ }).click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit).toBeVisible()
  await expect(cockpit.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(0)
  await expect(cockpit.getByRole('button', { name: 'Nowy klient' })).toHaveCount(0)
  await expect(cockpit.locator('button.cockpit__next, button.spine__row')).toHaveCount(0)
  await cockpit.getByRole('button', { name: 'Zamknij panel dnia' }).click()

  await page.goto('./#/team')
  await expect(page.getByRole('heading', { level: 1, name: /Zespół/ })).toBeVisible()
  await expect(page.getByRole('main').getByRole('button', { name: 'Dodaj specjalistkę' })).toHaveCount(1)

  await page.goto('./#/psych?id=sp_anna')
  await expect(page.locator('.topbar__title b')).toHaveText('Profil specjalistki')
  await expect(page.getByRole('heading', { level: 1, name: 'Anna Nowak' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  const bottomNavigation = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  await expect(bottomNavigation.getByRole('button', { name: 'Nowa sesja' })).toHaveCount(1)
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
  await expect(archivedRow.getByRole('button', { name: /Dodaj wpłatę/ })).toHaveCount(0)

  await page.goto('./#/payments?ym=2026-07')
  await page.getByRole('group', { name: 'Widok wpływów' }).getByRole('button', { name: 'Wszystkie' }).click()
  const income = page.locator('.finance-window__table').filter({
    has: page.getByRole('heading', { name: 'Wpływy miesiąca' }),
  })
  await expect(income).toContainText('Zofia Historyczna')
  await expect(income).toContainText('Specjalistka archiwalna')
  const ledger = page.getByRole('table', { name: 'Lista wpływów' })
  const historicalPaymentRow = ledger.locator('tbody tr', { hasText: 'Zofia Historyczna' })
  await expect(page.getByRole('button', { name: 'Wszystkie okresy' })).toHaveCount(0)
  await expect(historicalPaymentRow.getByRole('button', { name: /Dodaj wpłatę/ })).toHaveCount(0)
  await expect(historicalPaymentRow.getByRole('button', { name: /Skoryguj wpłatę/ })).toHaveCount(0)

  await page.goto('./#/calendar?date=2026-04-15&ym=2026-04&mode=cal')
  await expect(page.getByRole('status', { name: 'Stan Grafiku' })).toContainText('Wczytuję Grafik')
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
    await route.fulfill(json(200, { data: workspaceData(
      url.searchParams.get('from'), url.searchParams.get('to'), {
        clients: [archivedClient], appointments: [archivedScheduledAppointment],
      },
    ) }))
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
  await source.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Calendar drag target is unavailable')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect.poll(() => edits).toBe(0)
})

test('@owner cancels and restores a Calendar appointment through the canonical commands', async ({ page }) => {
  const cancellations = []
  const restorations = []
  let cancellationAccepted = false
  let restorationAccepted = false
  let workspaceReadsAfterCancellation = 0
  let appointment = scheduledAppointment
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    if (cancellationAccepted && !restorationAccepted) workspaceReadsAfterCancellation += 1
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
    cancellationAccepted = true
    await route.fulfill(json(200, { data: { appointment: cancelledAppointment } }))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/restoration', async (route) => {
    restorations.push({ method: route.request().method(), body: route.request().postData() })
    appointment = restoredAppointment
    restorationAccepted = true
    await route.fulfill(json(200, { data: { appointment: restoredAppointment } }))
  })

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  const status = plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' })
  await expect(status).toBeVisible()
  await status.click()
  await plan.getByRole('menuitem', { name: 'Odwołaj sesję…' }).click()

  const dialog = page.getByRole('dialog', { name: 'Odwołaj sesję?' })
  await expect(dialog).toContainText('Ola Aktywna')
  await expect(dialog).toContainText('15 lipca')
  await expect(dialog).toContainText('Anna Nowak')
  const confirm = dialog.getByRole('button', { name: 'Odwołaj sesję', exact: true })
  await expect(confirm).toBeDisabled()
  await dialog.getByRole('radio', { name: 'Odwołanie przez klienta' }).check()
  await confirm.click()

  await expect(plan.getByText('Odwołana', { exact: true })).toBeVisible()
  expect(cancellations).toEqual([{
    method: 'POST', body: JSON.stringify({ expectedVersion: 1, reason: 'client' }),
  }])
  await expect.poll(() => workspaceReadsAfterCancellation).toBe(1)
  const undo = page.getByRole('button', { name: 'Cofnij' })
  await expect(undo).toHaveCount(1)
  await undo.click()
  await expect(plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' })).toBeVisible()
  expect(restorations).toEqual([{
    method: 'POST', body: JSON.stringify({ expectedVersion: 2 }),
  }])
})

test('@owner changes a Calendar status through the canonical edit command and refreshes its covered range', async ({ page }) => {
  const edits = []
  let editAccepted = false
  let workspaceReadsAfterEdit = 0
  let appointment = scheduledAppointment
  await freezeTime(page, '2026-07-15T12:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    if (editAccepted) workspaceReadsAfterEdit += 1
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      appointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/edits', async (route) => {
    edits.push({ method: route.request().method(), body: route.request().postData() })
    appointment = edits.length === 1
      ? completedAppointment
      : { ...scheduledAppointment, version: 3, updatedAt: '2026-07-16T11:00:00.000Z' }
    editAccepted = true
    await route.fulfill(json(200, { data: { appointment } }))
  })

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' }).click()
  await plan.getByRole('menuitemradio', { name: 'Odbyta' }).click()

  await expect(plan.getByRole('button', { name: 'Status: Odbyta — Ola Aktywna, 13:00' })).toBeVisible()
  await page.getByRole('button', { name: 'Cofnij' }).click()
  await expect(plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' })).toBeVisible()
  expect(edits).toEqual([
    {
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
    },
    {
      method: 'POST',
      body: JSON.stringify({
        expectedVersion: 2,
        specialistId: 'sp_anna',
        serviceId: 'zajecia',
        date: '2026-07-15',
        time: '13:00',
        durationMinutes: 50,
        expectedAmountGrosze: 18_000,
        location: 'Gabinet 1',
        status: 'scheduled',
      }),
    },
  ])
  await expect.poll(() => workspaceReadsAfterEdit).toBe(2)
})

test('@owner refreshes and refuses Calendar status undo when its returned version is stale', async ({ page }) => {
  let attempts = 0
  let appointment = scheduledAppointment
  await freezeTime(page, '2026-07-15T12:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'), url.searchParams.get('to'), appointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/edits', async (route) => {
    attempts += 1
    if (attempts === 1) {
      appointment = completedAppointment
      await route.fulfill(json(200, { data: { appointment } }))
      return
    }
    appointment = {
      ...scheduledAppointment, status: 'noshow', version: 3,
      updatedAt: '2026-07-16T11:00:00.000Z',
      payment: { ...scheduledAppointment.payment, outstandingGrosze: 18_000 },
    }
    await route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  })

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' }).click()
  await plan.getByRole('menuitemradio', { name: 'Odbyta' }).click()
  await page.getByRole('button', { name: 'Cofnij' }).click()

  await expect(plan.getByRole('button', { name: 'Status: Nieobecność — Ola Aktywna, 13:00' })).toBeVisible()
  await expect(page.getByText('Nie można cofnąć zmiany sesji. Grafik został odświeżony.', { exact: true })).toBeVisible()
})

test('@owner undoes a Calendar drag with the returned appointment version and full prior edit body', async ({ page }) => {
  const edits = []
  let appointment = scheduledAppointment
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'), url.searchParams.get('to'), appointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/edits', async (route) => {
    const body = route.request().postDataJSON()
    edits.push(body)
    appointment = edits.length === 1
      ? {
          ...scheduledAppointment, startsAt: '2026-07-16T11:00:00.000Z',
          endsAt: '2026-07-16T11:50:00.000Z', version: 2,
          updatedAt: '2026-07-16T10:00:00.000Z',
        }
      : { ...scheduledAppointment, version: 3, updatedAt: '2026-07-16T11:00:00.000Z' }
    await route.fulfill(json(200, { data: { appointment } }))
  })

  await page.goto('./#/calendar?date=2026-07-15&ym=2026-07&mode=cal')
  const source = page.locator('.cal__day[data-iso="2026-07-15"] .cal__item', { hasText: 'Ola' })
  const target = page.locator('.cal__day[data-iso="2026-07-16"]')
  await expect(source).toBeVisible()
  await expect(target).toBeVisible()
  await source.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Calendar drag target is unavailable')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect(page).toHaveURL(/#\/calendar\?date=2026-07-16&highlightSessionIds=apt_scheduled$/)
  await page.getByRole('button', { name: 'Cofnij' }).click()
  await expect(page).toHaveURL(/#\/calendar\?date=2026-07-15&highlightSessionIds=apt_scheduled$/)
  await expect(page.getByRole('region', { name: 'Plan dnia' })
    .getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' })).toBeVisible()
  expect(edits).toEqual([
    {
      expectedVersion: 1, specialistId: 'sp_anna', serviceId: 'zajecia',
      date: '2026-07-16', time: '13:00', durationMinutes: 50,
      expectedAmountGrosze: 18_000, location: 'Gabinet 1', status: 'scheduled',
    },
    {
      expectedVersion: 2, specialistId: 'sp_anna', serviceId: 'zajecia',
      date: '2026-07-15', time: '13:00', durationMinutes: 50,
      expectedAmountGrosze: 18_000, location: 'Gabinet 1', status: 'scheduled',
    },
  ])
})

test('@owner cleans up an active Calendar drag when leaving before pointer release', async ({ page }) => {
  let edits = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'), url.searchParams.get('to'), scheduledAppointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/edits', async (route) => {
    edits += 1
    await route.abort()
  })

  await page.goto('./#/calendar?date=2026-07-15&ym=2026-07&mode=cal')
  const source = page.locator('.cal__day[data-iso="2026-07-15"] .cal__item', { hasText: 'Ola' })
  const target = page.locator('.cal__day[data-iso="2026-07-16"]')
  await source.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Calendar drag target is unavailable')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 5 })
  await expect(page.locator('.drag-ghost')).toBeVisible()

  await page.evaluate(() => { window.location.hash = '#/clients' })
  await expect(page).toHaveURL(/#\/clients$/)
  await expect(page.locator('.drag-ghost')).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveClass(/is-grabbing/)
  await page.mouse.up()
  await expect.poll(() => edits).toBe(0)
})

test('@owner leaves a pending accepted Calendar drag without stale UI effects', async ({ page }) => {
  let calendarWorkspaceReads = 0
  let editRequests = 0
  let releaseEdit
  let appointment = scheduledAppointment
  const editReleased = new Promise((resolve) => { releaseEdit = resolve })
  const movedAppointment = {
    ...scheduledAppointment,
    startsAt: '2026-07-16T11:00:00.000Z',
    endsAt: '2026-07-16T11:50:00.000Z',
    version: 2,
    updatedAt: '2026-07-16T08:05:00.000Z',
  }
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from === '2026-07-01' && to === '2026-07-31') calendarWorkspaceReads += 1
    await route.fulfill(workspaceEnvelope(from, to, appointment))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/edits', async (route) => {
    editRequests += 1
    await editReleased
    appointment = movedAppointment
    await route.fulfill(json(200, { data: { appointment: movedAppointment } }))
  })

  await page.goto('./#/calendar?date=2026-07-15&ym=2026-07&mode=cal')
  const source = page.locator('.cal__day[data-iso="2026-07-15"] .cal__item', { hasText: 'Ola' })
  const target = page.locator('.cal__day[data-iso="2026-07-16"]')
  await source.scrollIntoViewIfNeeded()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Calendar drag target is unavailable')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => editRequests).toBe(1)

  await page.evaluate(() => { window.location.hash = '#/settings' })
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(page.locator('.drag-ghost')).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveClass(/is-grabbing/)
  releaseEdit()
  await expect.poll(() => calendarWorkspaceReads).toBe(2)
  await expect(page.getByText(/Sesja została przełożona/)).toHaveCount(0)
  await page.goto('./#/calendar?date=2026-07-16&ym=2026-07&mode=cal')
  await expect(page.locator('.cal__day[data-iso="2026-07-16"] .cal__item', { hasText: 'Ola' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edytuj sesję — Ola Aktywna, 13:00' })).toBeEnabled()
})

test('@owner keeps the Calendar on canonical data after a cancellation conflict', async ({ page }) => {
  let cancellationRejected = false
  let workspaceReadsAfterCancellation = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    if (cancellationRejected) workspaceReadsAfterCancellation += 1
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      scheduledAppointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/cancellation', (route) => {
    cancellationRejected = true
    return route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  })

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' }).click()
  await plan.getByRole('menuitem', { name: 'Odwołaj sesję…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Odwołaj sesję?' })
  await dialog.getByRole('radio', { name: 'Odwołanie przez klienta' }).check()
  await dialog.getByRole('button', { name: 'Odwołaj sesję', exact: true }).click()

  await expect(plan.getByRole('button', { name: 'Status: Zaplanowana — Ola Aktywna, 13:00' })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveText('Sesja została zmieniona. Odśwież Grafik i spróbuj ponownie.')
  expect(workspaceReadsAfterCancellation).toBe(1)
})

test('@owner rolls a Calendar drag back after the canonical reschedule command conflicts', async ({ page }) => {
  const edits = []
  let editRejected = false
  let workspaceReadsAfterEdit = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    if (editRejected) workspaceReadsAfterEdit += 1
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      scheduledAppointment,
    ))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/edits', async (route) => {
    edits.push({ method: route.request().method(), body: route.request().postData() })
    editRejected = true
    await route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
  })

  await page.goto('./#/calendar?date=2026-07-15&ym=2026-07&mode=cal')
  const source = page.locator('.cal__day[data-iso="2026-07-15"] .cal__item', { hasText: 'Ola' })
  const target = page.locator('.cal__day[data-iso="2026-07-16"]')
  await expect(source).toBeVisible()
  await expect(target).toBeVisible()
  await source.scrollIntoViewIfNeeded()
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
  expect(workspaceReadsAfterEdit).toBe(0)
  await expect(source).toBeVisible()
  await expect(target.locator('.cal__item', { hasText: 'Ola' })).toHaveCount(0)
})

test('@owner reconciles POST /appointments/:appointmentId/payments in the finance window', async ({ page }) => {
  const payments = []
  let financeWorkspaceReads = 0
  let paymentAccepted = false
  let financeReadsAfterPayment = 0
  let appointment = completedAppointment
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('from') === '2026-07-01'
      && url.searchParams.get('to') === '2026-07-31') financeWorkspaceReads += 1
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      appointment,
    ))
  })
  await page.route('**/api/v1/finance/window?*', async (route) => {
    if (paymentAccepted) financeReadsAfterPayment += 1
    const month = new URL(route.request().url()).searchParams.get('month')
    await route.fulfill(json(200, { data: financeWindow(month, appointment) }))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/payments', async (route) => {
    payments.push({ method: route.request().method(), body: route.request().postData() })
    appointment = paymentRecordedAppointment
    paymentAccepted = true
    await route.fulfill(json(200, { data: { appointment: paymentRecordedAppointment } }))
  })

  await page.goto('./#/payments?ym=2026-07')
  const ledger = page.getByRole('table', { name: 'Lista wpływów' })
  const row = ledger.locator('tbody tr', { hasText: 'Ola Aktywna' })
  await row.getByRole('button', { name: /Dodaj wpłatę/ }).click()
  const entry = page.getByRole('dialog', { name: 'Dodaj wpłatę' })
  await entry.getByLabel('Kwota wpłaty').fill('120')
  await entry.getByLabel('Forma płatności').selectOption('card')
  await entry.getByLabel('Data wpłaty').fill('2026-01-04')
  await entry.getByRole('button', { name: 'Zapisz wpłatę' }).click()

  await expect(entry).toHaveCount(0)
  await expect(page.getByText('Wpłata zapisana: 120 zł, Karta', { exact: true })).toBeVisible()
  await expect(row.locator('td').nth(5)).toHaveText('120 zł')
  await expect(row.locator('td').nth(6)).toHaveText('60 zł')
  await expect(page.getByRole('heading', { name: 'Finanse — lipiec 2026' })).toBeVisible()
  await expect(page.getByText('Finanse są teraz niedostępne', { exact: true })).toHaveCount(0)
  expect(payments).toEqual([{
    method: 'POST',
    body: JSON.stringify({
      expectedVersion: 2,
      amountGrosze: 12_000,
      method: 'card',
      receivedAt: '2026-01-04T11:00:00.000Z',
    }),
  }])
  await expect.poll(() => financeWorkspaceReads).toBe(2)
  await expect.poll(() => financeReadsAfterPayment).toBeGreaterThan(0)

  await page.goto('./#/calendar?date=2026-07-15')
  const plan = page.getByRole('region', { name: 'Plan dnia' })
  await expect(plan.getByRole('button', {
    name: /Dodaj wpłatę.*Ola Aktywna.*15 lipca 2026.*13:00/i,
  })).toBeVisible()
})

test('@owner keeps protected payment input after a command failure', async ({ page }) => {
  let financeWorkspaceReads = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('from') === '2026-07-01'
      && url.searchParams.get('to') === '2026-07-31') financeWorkspaceReads += 1
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'),
      url.searchParams.get('to'),
      completedAppointment,
    ))
  })
  await page.route('**/api/v1/finance/window?*', async (route) => {
    const month = new URL(route.request().url()).searchParams.get('month')
    await route.fulfill(json(200, { data: financeWindow(month, completedAppointment) }))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/payments', (route) => (
    route.fulfill(errorEnvelope(409, 'PAYMENT_AMOUNT_CONFLICT'))
  ))

  await page.goto('./#/payments?ym=2026-07')
  const row = page.getByRole('table', { name: 'Lista wpływów' })
    .locator('tbody tr', { hasText: 'Ola Aktywna' })
  await row.getByRole('button', { name: /Dodaj wpłatę/ }).click()
  const entry = page.getByRole('dialog', { name: 'Dodaj wpłatę' })
  await entry.getByLabel('Kwota wpłaty').fill('120')
  await entry.getByLabel('Forma płatności').selectOption('card')
  await entry.getByLabel('Data wpłaty').fill('2026-01-04')
  await entry.getByRole('button', { name: 'Zapisz wpłatę' }).click()

  await expect(entry).toBeVisible()
  await expect(entry.getByLabel('Kwota wpłaty')).toHaveValue('120')
  await expect(entry.getByLabel('Forma płatności')).toHaveValue('card')
  await expect(entry.getByLabel('Data wpłaty')).toHaveValue('2026-01-04')
  await expect(entry.getByText('Nie udało się zapisać wpłaty. Spróbuj ponownie.', { exact: true })).toBeVisible()
  expect(financeWorkspaceReads).toBe(1)
})

test('@owner reconciles POST /payments/:paymentId/corrections in the finance window', async ({ page }) => {
  const corrections = []
  let financeWorkspaceReads = 0
  let correctionAccepted = false
  let financeReadsAfterCorrection = 0
  let appointment = paymentRecordedAppointment
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('from') === '2026-07-01'
      && url.searchParams.get('to') === '2026-07-31') financeWorkspaceReads += 1
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'), url.searchParams.get('to'), appointment,
    ))
  })
  await page.route('**/api/v1/finance/window?*', async (route) => {
    if (correctionAccepted) financeReadsAfterCorrection += 1
    const month = new URL(route.request().url()).searchParams.get('month')
    await route.fulfill(json(200, { data: financeWindow(month, appointment) }))
  })
  await page.route('**/api/v1/payments/pay_recorded/corrections', async (route) => {
    corrections.push({ method: route.request().method(), body: route.request().postData() })
    appointment = correctedPaymentAppointment
    correctionAccepted = true
    await route.fulfill(json(200, { data: { appointment: correctedPaymentAppointment } }))
  })

  await page.goto('./#/payments?ym=2026-07')
  const ledger = page.getByRole('table', { name: 'Lista wpływów' })
  await ledger.getByRole('button', { name: /Skoryguj wpłatę/ }).click()
  const correction = page.getByRole('dialog', { name: 'Skoryguj wpłatę' })
  await correction.getByLabel('Powód korekty').fill('  Błędna forma płatności  ')
  await correction.getByLabel('Dodaj wpłatę zastępczą').check()
  await correction.getByLabel('Kwota zastępcza').fill('100')
  await correction.getByLabel('Forma zastępcza').selectOption('transfer')
  await correction.getByLabel('Data zastępcza').fill('2026-01-05')
  await correction.getByRole('button', { name: 'Zapisz korektę' }).click()

  await expect(ledger).toContainText('Skorygowana')
  const row = ledger.locator('tbody tr', { hasText: 'Ola Aktywna' })
  await expect(row.locator('td').nth(5)).toHaveText('100 zł')
  await expect(row.locator('td').nth(6)).toHaveText('80 zł')
  await expect(page.getByRole('heading', { name: 'Finanse — lipiec 2026' })).toBeVisible()
  await expect(page.getByText('Finanse są teraz niedostępne', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cofnij' })).toHaveCount(0)
  expect(corrections).toEqual([{
    method: 'POST',
    body: JSON.stringify({
      expectedVersion: 3,
      reason: 'Błędna forma płatności',
      replacement: {
        amountGrosze: 10_000,
        method: 'transfer',
        receivedAt: '2026-01-05T11:00:00.000Z',
      },
    }),
  }])
  await expect.poll(() => financeWorkspaceReads).toBe(2)
  await expect.poll(() => financeReadsAfterCorrection).toBeGreaterThan(0)
})

test('@owner keeps protected correction input after a command failure', async ({ page }) => {
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    await route.fulfill(workspaceEnvelope(
      url.searchParams.get('from'), url.searchParams.get('to'), paymentRecordedAppointment,
    ))
  })
  await page.route('**/api/v1/finance/window?*', async (route) => {
    const month = new URL(route.request().url()).searchParams.get('month')
    await route.fulfill(json(200, { data: financeWindow(month, paymentRecordedAppointment) }))
  })
  await page.route('**/api/v1/payments/pay_recorded/corrections', (route) => (
    route.fulfill(errorEnvelope(409, 'PAYMENT_CORRECTION_CONFLICT'))
  ))

  await page.goto('./#/payments?ym=2026-07')
  await page.getByRole('table', { name: 'Lista wpływów' })
    .getByRole('button', { name: /Skoryguj wpłatę/ }).click()
  const correction = page.getByRole('dialog', { name: 'Skoryguj wpłatę' })
  await correction.getByLabel('Powód korekty').fill('Błędna forma płatności')
  await correction.getByLabel('Dodaj wpłatę zastępczą').check()
  await correction.getByLabel('Kwota zastępcza').fill('100')
  await correction.getByLabel('Forma zastępcza').selectOption('transfer')
  await correction.getByLabel('Data zastępcza').fill('2026-01-05')
  await correction.getByRole('button', { name: 'Zapisz korektę' }).click()

  await expect(correction).toBeVisible()
  await expect(correction.getByLabel('Powód korekty')).toHaveValue('Błędna forma płatności')
  await expect(correction.getByLabel('Dodaj wpłatę zastępczą')).toBeChecked()
  await expect(correction.getByLabel('Kwota zastępcza')).toHaveValue('100')
  await expect(correction.getByLabel('Forma zastępcza')).toHaveValue('transfer')
  await expect(correction.getByLabel('Data zastępcza')).toHaveValue('2026-01-05')
  await expect(correction.getByText('Nie udało się zapisać korekty.', { exact: true })).toBeVisible()
})

test('@owner cannot replay an accepted correction after an unrelated canonical load', async ({ page }) => {
  const corrections = []
  let financeWorkspaceReads = 0
  let unrelatedWorkspaceReads = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from === '2026-07-01' && to === '2026-07-31') {
      financeWorkspaceReads += 1
    }
    if (financeWorkspaceReads === 1 && from === '2026-07-01' && to === '2026-07-31') {
      await route.fulfill(workspaceEnvelope(
        from, to, paymentRecordedAppointment,
      ))
      return
    }
    if (financeWorkspaceReads === 2 && from === '2026-07-01' && to === '2026-07-31') {
      await route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
      return
    }
    if (from === '2026-06-01' && to === '2026-06-30') unrelatedWorkspaceReads += 1
    await route.fulfill(workspaceEnvelope(
      from, to, from === '2026-07-13' && to === '2026-07-19'
        ? paymentRecordedAppointment
        : null,
    ))
  })
  await page.route('**/api/v1/finance/window?*', async (route) => {
    const month = new URL(route.request().url()).searchParams.get('month')
    await route.fulfill(json(200, { data: financeWindow(month, paymentRecordedAppointment) }))
  })
  await page.route('**/api/v1/payments/pay_recorded/corrections', async (route) => {
    corrections.push({ method: route.request().method(), body: route.request().postData() })
    await route.fulfill(json(200, { data: { appointment: reversedPaymentAppointment } }))
  })

  await page.goto('./#/payments?ym=2026-07')
  const ledger = page.getByRole('table', { name: 'Lista wpływów' })
  await ledger.getByRole('button', { name: /Skoryguj wpłatę/ }).click()
  const correction = page.getByRole('dialog', { name: 'Skoryguj wpłatę' })
  await correction.getByLabel('Powód korekty').fill('Błędna forma płatności')
  await correction.getByRole('button', { name: 'Zapisz korektę' }).click()
  await expect.poll(() => financeWorkspaceReads).toBe(2)

  await page.goto('./#/calendar?date=2026-06-15&ym=2026-06&mode=cal')
  await expect.poll(() => unrelatedWorkspaceReads).toBe(1)
  await page.goto('./#/payments?ym=2026-07')
  await expect(ledger.getByRole('button', { name: /Skoryguj wpłatę/ })).toBeDisabled()
  expect(corrections).toHaveLength(1)
})

test('@owner cannot replay an accepted payment after an unrelated canonical load', async ({ page }) => {
  const payments = []
  let financeWorkspaceReads = 0
  let unrelatedWorkspaceReads = 0
  await freezeTime(page, '2026-07-15T08:00:00.000Z')
  await page.route('**/api/v1/workspace?*', async (route) => {
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (from === '2026-07-01' && to === '2026-07-31') {
      financeWorkspaceReads += 1
    }
    if (financeWorkspaceReads === 1 && from === '2026-07-01' && to === '2026-07-31') {
      await route.fulfill(workspaceEnvelope(
        from, to, completedAppointment,
      ))
      return
    }
    if (financeWorkspaceReads === 2 && from === '2026-07-01' && to === '2026-07-31') {
      await route.fulfill(errorEnvelope(409, 'VERSION_CONFLICT'))
      return
    }
    if (from === '2026-06-01' && to === '2026-06-30') unrelatedWorkspaceReads += 1
    await route.fulfill(workspaceEnvelope(
      from, to, from === '2026-07-13' && to === '2026-07-19'
        ? completedAppointment
        : null,
    ))
  })
  await page.route('**/api/v1/finance/window?*', async (route) => {
    const month = new URL(route.request().url()).searchParams.get('month')
    await route.fulfill(json(200, { data: financeWindow(month, completedAppointment) }))
  })
  await page.route('**/api/v1/appointments/apt_scheduled/payments', async (route) => {
    payments.push({ method: route.request().method(), body: route.request().postData() })
    await route.fulfill(json(200, { data: { appointment: paymentRecordedAppointment } }))
  })

  await page.goto('./#/payments?ym=2026-07')
  const row = page.getByRole('table', { name: 'Lista wpływów' })
    .locator('tbody tr', { hasText: 'Ola Aktywna' })
  await row.getByRole('button', { name: /Dodaj wpłatę/ }).click()
  const entry = page.getByRole('dialog', { name: 'Dodaj wpłatę' })
  await entry.getByLabel('Kwota wpłaty').fill('120')
  await entry.getByLabel('Forma płatności').selectOption('card')
  await entry.getByLabel('Data wpłaty').fill('2026-01-04')
  await entry.getByRole('button', { name: 'Zapisz wpłatę' }).click()
  await expect.poll(() => financeWorkspaceReads).toBe(2)

  await page.goto('./#/calendar?date=2026-06-15&ym=2026-06&mode=cal')
  await expect.poll(() => unrelatedWorkspaceReads).toBe(1)
  await page.goto('./#/payments?ym=2026-07')
  await expect(row.getByRole('button', { name: /Dodaj wpłatę/ })).toBeDisabled()
  expect(payments).toHaveLength(1)
})
