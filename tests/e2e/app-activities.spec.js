import { expect, test } from '@playwright/test'

const NOW = '2026-08-01T10:00:00.000Z'

const program = (code) => ({
  id: `apg_${code}`, code, label: code === 'tus' ? 'TUS' : 'Angielski',
  status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
})

const activityWorkspace = ({
  from, to, attendanceStatus = 'present', createdClass = null,
  createdGroupLabel = null, createdMembership = null, createdParticipantName = null,
  emptyTusMonth = null, englishCount = 1, includeClass = false, latestTus = '2026-08',
  specialistScope = false, tusCount = 1,
}) => ({
  data: {
    from, to, complete: true, currentDay: '2026-08-28',
    latestPopulatedMonths: { tus: latestTus, english: '2026-08' },
    programs: [program('english'), program('tus')],
    groups: [
      {
        id: 'agr_english', programId: 'apg_english', label: 'Fikcyjny program angielski',
        details: null, status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
      },
      ...(createdGroupLabel ? [{
        id: 'agr_created', programId: 'apg_tus', label: createdGroupLabel,
        details: null, status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
      }] : []),
      {
      id: 'agr_fikcyjna', programId: 'apg_tus', label: 'Fikcyjna grupa TUS',
      details: null, status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
      },
    ].sort((left, right) => left.id.localeCompare(right.id)),
    groupLeaders: specialistScope ? [{
      id: 'agl_fikcyjna', groupId: 'agr_fikcyjna', specialistId: 'sp_local_specialist',
      startsOn: '2026-01-01', endsOn: null, status: 'active', version: 1,
      createdAt: NOW, updatedAt: NOW,
    }] : [],
    participants: [
      ...(createdParticipantName ? [{
        id: 'acp_created', programId: 'apg_english', name: createdParticipantName,
        clientId: null, historicalClientId: null, status: 'active', version: 1,
        createdAt: NOW, updatedAt: NOW,
      }] : []),
      {
      id: 'acp_english_zero', programId: 'apg_english', name: 'Fikcyjny Zero',
      clientId: null, historicalClientId: null, status: 'active', version: 1,
      createdAt: NOW, updatedAt: NOW,
    }, {
      id: 'acp_fikcyjna', programId: 'apg_tus', name: 'Fikcyjna Uczestniczka',
      clientId: null, historicalClientId: null, status: 'active', version: 1,
      createdAt: NOW, updatedAt: NOW,
    }, {
      id: 'acp_unassigned', programId: 'apg_tus', name: 'Fikcyjny Nieprzypisany',
      clientId: null, historicalClientId: null, status: 'active', version: 1,
      createdAt: NOW, updatedAt: NOW,
    },
      ...Array.from({ length: englishCount - 1 }, (_, index) => ({
        id: `acp_english_${String(index + 1).padStart(3, '0')}`,
        programId: 'apg_english', name: `Fikcyjna Angielska ${String(index + 1).padStart(3, '0')}`,
        clientId: null, historicalClientId: null, status: 'active', version: 1,
        createdAt: NOW, updatedAt: NOW,
      })),
      ...Array.from({ length: tusCount - 1 }, (_, index) => ({
        id: `acp_tus_${String(index + 1).padStart(3, '0')}`,
        programId: 'apg_tus', name: `Fikcyjny TUS ${String(index + 1).padStart(3, '0')}`,
        clientId: null, historicalClientId: null, status: 'active', version: 1,
        createdAt: NOW, updatedAt: NOW,
      })),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    memberships: from === emptyTusMonth ? [] : [
      ...(createdMembership ? [createdMembership] : []),
      {
      id: 'amb_fikcyjna', participantId: 'acp_fikcyjna', programId: 'apg_tus',
      groupId: 'agr_fikcyjna', membershipKind: 'observation',
      period: { precision: 'month', day: null, month: from },
      startsOn: null, endsOn: null, status: 'active', version: 1,
      createdAt: NOW, updatedAt: NOW,
      },
      ...Array.from({ length: tusCount - 1 }, (_, index) => ({
        id: `amb_tus_${String(index + 1).padStart(3, '0')}`,
        participantId: `acp_tus_${String(index + 1).padStart(3, '0')}`,
        programId: 'apg_tus', groupId: 'agr_fikcyjna', membershipKind: 'observation',
        period: { precision: 'month', day: null, month: from },
        startsOn: null, endsOn: null, status: 'active', version: 1,
        createdAt: NOW, updatedAt: NOW,
      })),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    classes: createdClass ? [createdClass] : includeClass ? [{
      id: 'acl_fikcyjna', groupId: 'agr_fikcyjna', date: `${from}-18`, time: null,
      durationMinutes: null, topic: null, status: 'completed', version: 1,
      createdAt: NOW, updatedAt: NOW,
    }] : [],
    attendance: includeClass ? [{
      id: 'aat_fikcyjna', classId: 'acl_fikcyjna', participantId: 'acp_fikcyjna',
      status: attendanceStatus, version: attendanceStatus === 'present' ? 1 : 2,
      createdAt: NOW, updatedAt: NOW,
    }] : [],
    charges: [{
      id: 'ach_english_zero', participantId: 'acp_english_zero', programId: 'apg_english',
      groupId: null, membershipId: null,
      period: { precision: 'month', day: null, month: from }, lessonCount: 0,
      responsibleSpecialistId: 'sp_owner_link', financeEntryId: 'fin_english_zero',
      status: 'active', version: 1,
      finance: {
        amountGrosze: 0, paidAmountGrosze: 0,
        paymentMethod: 'unknown', settlementStatus: 'unpaid',
      },
      createdAt: NOW, updatedAt: NOW,
    }, ...Array.from({ length: englishCount - 1 }, (_, index) => ({
      id: `ach_english_${String(index + 1).padStart(3, '0')}`,
      participantId: `acp_english_${String(index + 1).padStart(3, '0')}`,
      programId: 'apg_english', groupId: null, membershipId: null,
      period: { precision: 'month', day: null, month: from }, lessonCount: 1,
      responsibleSpecialistId: 'sp_owner_link', financeEntryId: `fin_english_${index + 1}`,
      status: 'active', version: 1,
      finance: {
        amountGrosze: 9_000, paidAmountGrosze: 9_000,
        paymentMethod: 'transfer', settlementStatus: 'paid',
      },
      createdAt: NOW, updatedAt: NOW,
    })), ...(from === emptyTusMonth ? [] : [{
      id: 'ach_fikcyjna', participantId: 'acp_fikcyjna', programId: 'apg_tus',
      groupId: 'agr_fikcyjna', membershipId: 'amb_fikcyjna',
      period: { precision: 'month', day: null, month: from }, lessonCount: null,
      responsibleSpecialistId: specialistScope ? 'sp_local_specialist' : 'sp_owner_link',
      financeEntryId: 'fin_fikcyjna',
      status: 'active', version: 1,
      finance: {
        amountGrosze: 34_000, paidAmountGrosze: 0,
        paymentMethod: 'transfer', settlementStatus: 'unpaid',
      },
      createdAt: NOW, updatedAt: NOW,
    }, ...Array.from({ length: tusCount - 1 }, (_, index) => ({
      id: `ach_tus_${String(index + 1).padStart(3, '0')}`,
      participantId: `acp_tus_${String(index + 1).padStart(3, '0')}`,
      programId: 'apg_tus', groupId: 'agr_fikcyjna',
      membershipId: `amb_tus_${String(index + 1).padStart(3, '0')}`,
      period: { precision: 'month', day: null, month: from }, lessonCount: null,
      responsibleSpecialistId: specialistScope ? 'sp_local_specialist' : 'sp_owner_link',
      financeEntryId: `fin_tus_${index + 1}`, status: 'active', version: 1,
      finance: {
        amountGrosze: 34_000, paidAmountGrosze: 34_000,
        paymentMethod: 'transfer', settlementStatus: 'paid',
      },
      createdAt: NOW, updatedAt: NOW,
    }))])].sort((left, right) => left.id.localeCompare(right.id)),
    payments: [],
  },
})

const installActivityFixture = async (page, {
  emptyTusMonth = null, groupConflict = false, includeClass = false,
  latestTus = '2026-08', specialistScope = false, tusCount = 1, englishCount = 1,
} = {}) => {
  let attendanceStatus = 'present'
  let createdClass = null
  let createdGroupLabel = null
  let createdMembership = null
  let createdParticipantName = null
  let loads = 0
  const commands = []
  await page.route('**/api/v1/activities/workspace?*', (route) => {
    loads += 1
    const url = new URL(route.request().url())
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activityWorkspace({
        from, to, attendanceStatus, createdClass, createdGroupLabel,
        createdMembership, createdParticipantName, includeClass,
        emptyTusMonth, englishCount, latestTus, specialistScope, tusCount,
      })),
    })
  })
  await page.route('**/api/v1/activities/groups', async (route) => {
    const input = route.request().postDataJSON()
    commands.push({ kind: 'group', body: input, headers: route.request().headers() })
    if (groupConflict) {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: {
          code: 'VERSION_CONFLICT', correlationId: 'cor_activity_group_conflict',
        } }),
      })
    }
    createdGroupLabel = input.label
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: {
        group: {
          id: 'agr_created', programId: input.programId, label: input.label,
          details: input.details, status: 'active', version: 1,
          createdAt: NOW, updatedAt: NOW,
        },
        groupLeaders: [],
      } }),
    })
  })
  await page.route('**/api/v1/activities/participants', async (route) => {
    const input = route.request().postDataJSON()
    commands.push({ kind: 'participant', body: input, headers: route.request().headers() })
    createdParticipantName = input.name
    return route.fulfill({
      status: 201, contentType: 'application/json',
      body: JSON.stringify({ data: { participant: {
        id: 'acp_created', programId: input.programId, name: input.name,
        clientId: input.clientId, historicalClientId: input.historicalClientId,
        status: 'active', version: 1, createdAt: NOW, updatedAt: NOW,
      } } }),
    })
  })
  await page.route('**/api/v1/activities/memberships', async (route) => {
    const input = route.request().postDataJSON()
    commands.push({ kind: 'membership', body: input, headers: route.request().headers() })
    createdMembership = {
      id: 'amb_created', participantId: input.participantId, programId: 'apg_tus',
      groupId: input.groupId, membershipKind: 'interval',
      period: { precision: 'unknown', day: null, month: null },
      startsOn: input.startsOn, endsOn: input.endsOn, status: 'active', version: 1,
      createdAt: NOW, updatedAt: NOW,
    }
    return route.fulfill({
      status: 201, contentType: 'application/json',
      body: JSON.stringify({ data: { membership: createdMembership } }),
    })
  })
  await page.route('**/api/v1/activities/classes', async (route) => {
    const input = route.request().postDataJSON()
    commands.push({ kind: 'class', body: input, headers: route.request().headers() })
    createdClass = {
      id: 'acl_created', groupId: input.groupId, date: input.date, time: input.time,
      durationMinutes: input.durationMinutes, topic: input.topic, status: input.status,
      version: 1, createdAt: NOW, updatedAt: NOW,
    }
    return route.fulfill({
      status: 201, contentType: 'application/json',
      body: JSON.stringify({ data: { class: createdClass } }),
    })
  })
  await page.route('**/api/v1/activities/classes/acl_fikcyjna/attendance', async (route) => {
    const input = route.request().postDataJSON()
    attendanceStatus = input.status
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { attendance: {
        id: 'aat_fikcyjna', classId: 'acl_fikcyjna', participantId: input.participantId,
        status: input.status, version: input.expectedVersion + 1,
        createdAt: NOW, updatedAt: NOW,
      } } }),
    })
  })
  return { commands, loads: () => loads }
}

test('@owner protected TUS renders canonical group facts without demo schedule or classes', async ({ page }) => {
  await installActivityFixture(page)
  await page.goto('./#/tus?ym=2026-08')

  await expect(page.getByRole('heading', { level: 1, name: 'Grupy TUS' })).toBeVisible()
  const group = page.getByRole('article', { name: 'Fikcyjna grupa TUS' })
  await expect(group.getByRole('heading', { name: 'Fikcyjna grupa TUS' })).toBeVisible()
  await expect(group).toContainText('340 zł')
  await expect(group).toContainText('Pozostało')
  await expect(page.getByText('Brak zapisanych zajęć w tym miesiącu')).toBeVisible()
  await expect(page.getByText(/co tydzień/i)).toHaveCount(0)
})

test('@owner English keeps an explicit zero-lesson zero-amount ungrouped row', async ({ page }) => {
  await installActivityFixture(page)
  await page.goto('./#/english?ym=2026-08')

  await expect(page.getByRole('heading', { level: 1, name: 'Angielski' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Nowa grupa angielskiego' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edytuj grupę angielskiego' })).toBeVisible()
  const row = page.getByRole('row', { name: /Fikcyjny Zero/ })
  await expect(row).toContainText('Bez przypisanej grupy')
  await expect(row.getByRole('cell').nth(2)).toHaveText('0')
  await expect(row.getByRole('cell').nth(3)).toHaveText('0 zł')
})

test('@owner protected group creation closes only after canonical same-month reload', async ({ page }) => {
  const fixture = await installActivityFixture(page)
  await page.goto('./#/tus?ym=2026-08')
  await expect(page.getByRole('heading', { name: 'Fikcyjna grupa TUS' })).toBeVisible()

  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
  await drawer.getByLabel('Nazwa grupy').fill('Fikcyjna grupa utworzona')
  await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Fikcyjna grupa utworzona' })).toBeVisible()
  expect(fixture.loads()).toBeGreaterThanOrEqual(2)
})

test('@owner protected participant drawer contains no demo contact, age, fee, or schedule fields', async ({ page }) => {
  await installActivityFixture(page)
  await page.goto('./#/english?ym=2026-08')

  await page.getByRole('button', { name: 'Nowy uczestnik' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowy uczestnik angielskiego' })
  await expect(drawer.getByLabel('Imię i nazwisko')).toBeVisible()
  await expect(drawer.getByLabel(/wiek|telefon|opłata|dzień tygodnia/i)).toHaveCount(0)
})

test('@owner TUS exposes the canonical participant command to centre scope', async ({ page }) => {
  await installActivityFixture(page)
  await page.goto('./#/tus?ym=2026-08')

  await page.getByRole('button', { name: 'Nowy uczestnik TUS' }).click()
  await expect(page.getByRole('dialog', { name: 'Nowy uczestnik TUS' })
    .getByLabel('Imię i nazwisko')).toBeVisible()
})

test('@owner protected group exposes an explicit dated membership drawer', async ({ page }) => {
  await installActivityFixture(page)
  await page.goto('./#/tusGroup?id=agr_fikcyjna&ym=2026-08')

  await page.getByRole('button', { name: 'Dodaj przypisanie' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowe przypisanie do grupy' })
  await expect(drawer.getByLabel('Uczestnik')).toBeVisible()
  await expect(drawer.getByLabel('Data rozpoczęcia')).toHaveValue('2026-08-01')
})

test('@owner protected group creates only a one-off civil-dated class', async ({ page }) => {
  await installActivityFixture(page)
  await page.goto('./#/tusGroup?id=agr_fikcyjna&ym=2026-08')

  await page.getByRole('button', { name: 'Dodaj zajęcia' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowe zajęcia TUS' })
  await expect(drawer.getByLabel('Data zajęć')).toBeVisible()
  await expect(drawer.getByLabel('Godzina')).toHaveValue('')
  await expect(drawer.getByLabel(/cykl|co tydzień|liczba spotkań/i)).toHaveCount(0)
})

test('@owner attendance toggles only a real class participant and reconciles canonical state', async ({ page }) => {
  const fixture = await installActivityFixture(page, { includeClass: true })
  await page.goto('./#/tusGroup?id=agr_fikcyjna&ym=2026-08')

  const attendance = page.getByRole('button', {
    name: 'Obecność: Fikcyjna Uczestniczka, 2026-08-18, obecna',
  })
  await expect(attendance).toHaveAttribute('aria-pressed', 'true')
  await attendance.click()
  await expect(page.getByRole('button', {
    name: 'Obecność: Fikcyjna Uczestniczka, 2026-08-18, nieobecna',
  })).toHaveAttribute('aria-pressed', 'false')
  expect(fixture.loads()).toBeGreaterThanOrEqual(2)
})

test('@owner activity conflict keeps the draft open and reloads the canonical month', async ({ page }) => {
  const fixture = await installActivityFixture(page, { groupConflict: true })
  await page.goto('./#/tus?ym=2026-08')

  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
  await drawer.getByLabel('Nazwa grupy').fill('Fikcyjny szkic konfliktu')
  await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()

  await expect(drawer).toBeVisible()
  await expect(drawer.getByLabel('Nazwa grupy')).toHaveValue('Fikcyjny szkic konfliktu')
  await expect(drawer.getByRole('alert')).toContainText('Grupa zmieniła się w innym oknie')
  expect(fixture.loads()).toBeGreaterThanOrEqual(2)
})

test('@owner participant create posts the exact canonical DTO and renders the refreshed record', async ({ page }) => {
  const fixture = await installActivityFixture(page)
  await page.goto('./#/english?ym=2026-08')
  await page.getByRole('button', { name: 'Nowy uczestnik' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowy uczestnik angielskiego' })
  await drawer.getByLabel('Imię i nazwisko').fill('Fikcyjna Nowa Uczestniczka')
  await drawer.getByRole('button', { name: 'Utwórz uczestnika' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(page.getByText('Fikcyjna Nowa Uczestniczka', { exact: true })).toBeVisible()
  const command = fixture.commands.find(({ kind }) => kind === 'participant')
  expect(command.body).toEqual({
    programId: 'apg_english', name: 'Fikcyjna Nowa Uczestniczka',
    clientId: null, historicalClientId: null,
  })
  expect(command.headers['idempotency-key']).toMatch(/^[A-Za-z0-9._~-]{8,128}$/)
  expect(fixture.loads()).toBeGreaterThanOrEqual(2)
})

test('@owner membership create posts explicit dates and renders the refreshed assignment', async ({ page }) => {
  const fixture = await installActivityFixture(page)
  await page.goto('./#/tusGroup?id=agr_fikcyjna&ym=2026-08')
  await page.getByRole('button', { name: 'Dodaj przypisanie' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowe przypisanie do grupy' })
  await drawer.getByLabel('Uczestnik').selectOption({ label: 'Fikcyjny Nieprzypisany' })
  await drawer.getByRole('button', { name: 'Dodaj przypisanie' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Przypisania uczestników' }))
    .toContainText('Fikcyjny Nieprzypisany')
  const command = fixture.commands.find(({ kind }) => kind === 'membership')
  expect(command.body).toEqual({
    participantId: 'acp_unassigned', groupId: 'agr_fikcyjna',
    startsOn: '2026-08-01', endsOn: null,
  })
  expect(command.headers['idempotency-key']).toMatch(/^[A-Za-z0-9._~-]{8,128}$/)
  expect(fixture.loads()).toBeGreaterThanOrEqual(2)
})

test('@owner class create posts nullable optional facts and renders the refreshed one-off class', async ({ page }) => {
  const fixture = await installActivityFixture(page)
  await page.goto('./#/tusGroup?id=agr_fikcyjna&ym=2026-08')
  await page.getByRole('button', { name: 'Dodaj zajęcia' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowe zajęcia TUS' })
  await drawer.getByLabel('Data zajęć').fill('2026-08-21')
  await drawer.getByRole('button', { name: 'Dodaj zajęcia' }).click()

  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 3, name: '2026-08-21' })).toBeVisible()
  const command = fixture.commands.find(({ kind }) => kind === 'class')
  expect(command.body).toEqual({
    groupId: 'agr_fikcyjna', date: '2026-08-21', time: null,
    durationMinutes: null, topic: null, status: 'scheduled',
  })
  expect(command.headers['idempotency-key']).toMatch(/^[A-Za-z0-9._~-]{8,128}$/)
  expect(fixture.loads()).toBeGreaterThanOrEqual(2)
})

test('@specialist renders only the D1-scoped DTO and conceals a direct other-group ID', async ({ page }) => {
  await installActivityFixture(page, { includeClass: true, specialistScope: true })
  await page.goto('./#/tus?ym=2026-08')

  await expect(page.getByRole('heading', { name: 'Fikcyjna grupa TUS' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Nowa grupa' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Nowy uczestnik' })).toHaveCount(0)
  await expect(page.locator('.view').getByRole('link', { name: /rejestr|finanse/i })).toHaveCount(0)

  await page.getByRole('link', { name: 'Otwórz grupę — Fikcyjna grupa TUS' }).click()
  await expect(page.getByRole('button', { name: 'Edytuj grupę' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edytuj zajęcia' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Dodaj przypisanie' })).toHaveCount(0)

  await page.goto('./#/tusGroup?id=agr_innego_specjalisty&ym=2026-08')
  await expect(page.getByText('Nie znaleziono grupy', { exact: true })).toBeVisible()
  await expect(page.getByText(/należy do innej|brak uprawnień/i)).toHaveCount(0)
})

test('@coordinator sees centre activity routes and eligible creation actions', async ({ page }) => {
  await installActivityFixture(page)
  await page.goto('./#/tus?ym=2026-08')
  await expect(page.getByRole('button', { name: 'Nowa grupa' })).toBeVisible()
  await page.goto('./#/english?ym=2026-08')
  await expect(page.getByRole('button', { name: 'Nowy uczestnik' })).toBeVisible()
})

test('@owner empty current month stays selected until the real latest-month link enters history', async ({ page }) => {
  await installActivityFixture(page, { emptyTusMonth: '2026-08', latestTus: '2026-07' })
  await page.goto('./#/tus?ym=2026-08')

  await expect(page.locator('time[datetime="2026-08"]')).toBeVisible()
  const latest = page.getByRole('link', { name: /Przejdź do ostatniego miesiąca z danymi/ })
  await expect(latest).toHaveAttribute('href', '#/tus?ym=2026-07')
  await latest.click()
  await expect(page).toHaveURL(/#\/tus\?ym=2026-07$/)
  await expect(latest).toHaveCount(0)

  await page.goBack()
  await expect(page).toHaveURL(/#\/tus\?ym=2026-08$/)
  await page.goForward()
  await expect(page).toHaveURL(/#\/tus\?ym=2026-07$/)
  await page.reload()
  await expect(page).toHaveURL(/#\/tus\?ym=2026-07$/)
})

test('@owner protected activities contain long facts at desktop, tablet, phone, and real coarse touch', async ({ browser }) => {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 800, height: 1024 },
    { width: 390, height: 844 },
    { width: 320, height: 844 },
  ]) {
    const context = await browser.newContext({
      hasTouch: true,
      viewport,
      extraHTTPHeaders: { 'X-BWM-Local-Identity': 'owner@example.test' },
    })
    const page = await context.newPage()
    await installActivityFixture(page)
    await page.goto('http://127.0.0.1:5174/#/english?ym=2026-08')
    await expect(page.getByRole('heading', { level: 1, name: 'Angielski' })).toBeVisible()
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.evaluate(() => ({
      local: localStorage.length, session: sessionStorage.length,
    }))).toEqual({ local: 0, session: 0 })
    if (viewport.width <= 640) {
      await page.getByRole('navigation', { name: 'Nawigacja dolna' })
        .getByRole('button', { name: 'Menu' }).click()
      await expect(page.getByRole('dialog', { name: 'Nawigacja' })
        .getByRole('link', { name: 'Angielski' })).toBeVisible()
    }
    await context.close()
  }
})

test('@owner canonical fixtures expose exactly 25 TUS and 165 English participants', async ({ page }) => {
  await installActivityFixture(page, { tusCount: 25, englishCount: 165 })
  await page.goto('./#/tus?ym=2026-08')
  await expect(page.getByRole('group', { name: 'Podsumowanie miesiąca' })
    .locator('.figures__item').filter({ hasText: 'Uczestnicy' }))
    .toContainText('25')

  await page.goto('./#/english?ym=2026-08')
  await expect(page.getByRole('group', { name: 'Podsumowanie miesiąca' })
    .locator('.figures__item').filter({ hasText: 'Uczestnicy' }))
    .toContainText('165')
})
