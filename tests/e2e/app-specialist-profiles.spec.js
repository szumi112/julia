import { expect, test } from '@playwright/test'

test('@owner orders protected Team by professional name and presents Julia without an owner badge', async ({ page }) => {
  await page.route('**/api/v1/session', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.actor = {
      ...body.data.actor,
      displayName: 'Julia Wolanin',
      professionalTitle: 'Specjalistka',
      specialistId: 'sp_julia',
    }
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/v1/workspace?*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.data.specialists = [
      ...body.data.specialists,
      {
        id: 'sp_julia',
        displayName: 'Julia Wolanin',
        professionalTitle: 'Specjalistka',
        standardRateGrosze: 18_000, longRateGrosze: 25_000, specialization: '',
        status: 'active',
        version: 1,
        staffVersion: 1,
        accessStatus: 'enabled',
      },
    ].toSorted((left, right) => left.displayName.localeCompare(right.displayName, 'pl')
      || left.id.localeCompare(right.id))
    await route.fulfill({ response, json: body })
  })

  await page.goto('./#/team')

  const julia = page.locator('.team-card').filter({ hasText: 'Julia Wolanin' })
  await expect(julia).toBeVisible()
  const names = await page.locator('.team-grid .team-card__name').allTextContents()
  expect(names).toEqual(names.toSorted((left, right) => left.localeCompare(right, 'pl')))
  expect(names).toContain('Julia Wolanin')
  await expect(julia).toContainText('Specjalistka')
  await expect(julia).toContainText(/180\s*zł \/ 60 min/)
  await expect(julia).toContainText('Ma dostęp')
  await expect(julia).not.toContainText('Właściciel')
})

test('@owner creates, edits, and invites one stable specialist profile', async ({ page }) => {
  const profilePayloads = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /^\/api\/v1\/specialists(?:\/[^/]+\/edits)?$/.test(new URL(request.url()).pathname)) {
      profilePayloads.push(JSON.parse(request.postData()))
    }
  })
  await page.goto('.')
  await page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Zespół' })
    .click()
  await expect(page.getByText(
    'Profil specjalistki i dostęp do panelu tworzysz osobno.',
    { exact: true },
  )).toBeVisible()

  await page.getByRole('button', { name: 'Dodaj specjalistkę' }).click()
  const createDialog = page.getByRole('dialog', { name: 'Dodaj profil specjalistki' })
  await expect(createDialog).toContainText('Klientów i sesje przypiszesz jej, gdy przyjmie zaproszenie do panelu.')
  await expect(createDialog.getByRole('button', { name: 'Dodaj specjalistkę' })).toBeVisible()
  await expect(createDialog.getByRole('button', { name: 'Zamknij' })).toHaveCount(2)
  await expect(createDialog.getByLabel('Tytuł zawodowy')).toHaveValue('Specjalistka')
  await expect(createDialog.getByLabel('Stawka za 60 min (zł)')).toHaveValue('180')
  await createDialog.getByLabel('Tytuł zawodowy').fill('')
  await createDialog.getByLabel('Stawka za 60 min (zł)').fill('')
  await createDialog.getByRole('button', { name: 'Dodaj specjalistkę' }).click()
  await expect(createDialog.getByText('Wpisz imię i nazwisko.', { exact: true })).toBeVisible()
  await expect(createDialog.getByText('Wpisz tytuł, np. psycholożka.', { exact: true })).toBeVisible()
  await expect(createDialog.getByText('Wpisz stawkę, np. 180.', { exact: true })).toBeVisible()
  await createDialog.getByLabel('Imię i nazwisko').fill('Anna Janowska')
  await createDialog.getByLabel('Tytuł zawodowy').fill('Psycholożka')
  await createDialog.getByLabel('Stawka za 60 min (zł)').fill('185,50')
  await expect(createDialog.getByLabel('Stawka za 90 min (zł)')).toHaveValue('250')
  await createDialog.getByLabel('Stawka za 90 min (zł)').fill('270')
  await createDialog.getByLabel('Specjalizacja (opcjonalnie)').fill('Terapia nastolatków')
  await createDialog.getByRole('radio', { name: 'Orbita' }).check()
  await createDialog.getByRole('button', { name: 'Dodaj specjalistkę' }).click()

  let profile = page.locator('article').filter({ hasText: 'Anna Janowska' })
  await expect(page.getByText('Specjalistka została dodana do zespołu · Anna Janowska', { exact: true })).toBeVisible()
  await expect(profile).toContainText('Brak dostępu do panelu')
  await expect(profile).toContainText('Psycholożka')
  await expect(profile).toContainText('185,50 zł')
  await expect(profile).toContainText('270 zł / 90 min')
  await expect(profile).toContainText('Terapia nastolatków')
  await expect(profile.locator('.avatar__art--orbit')).toBeVisible()
  expect(profilePayloads[0]).toMatchObject({
    avatarKey: 'orbit', longRateGrosze: 27_000, specialization: 'Terapia nastolatków',
  })

  await profile.getByRole('button', { name: 'Edytuj profil' }).click()
  const editDialog = page.getByRole('dialog', { name: 'Edytuj profil specjalistki' })
  await expect(editDialog).toContainText('Klienci i dostęp do panelu pozostaną bez zmian.')
  await editDialog.getByLabel('Imię i nazwisko').fill('Anna Janowska-Kowalska')
  await expect(editDialog.getByLabel('Tytuł zawodowy')).toHaveValue('Psycholożka')
  await expect(editDialog.getByLabel('Stawka za 90 min (zł)')).toHaveValue('270')
  await expect(editDialog.getByLabel('Specjalizacja (opcjonalnie)')).toHaveValue('Terapia nastolatków')
  await editDialog.getByLabel('Tytuł zawodowy').fill('Psychoterapeutka')
  await editDialog.getByRole('radio', { name: 'Kropki' }).check()
  await editDialog.getByRole('button', { name: 'Zapisz zmiany' }).click()

  profile = page.locator('article').filter({ hasText: 'Anna Janowska-Kowalska' })
  await expect(page.getByText('Dane specjalistki zostały zapisane · Anna Janowska-Kowalska', { exact: true })).toBeVisible()
  await expect(profile).toContainText('Brak dostępu do panelu')
  await expect(profile).toContainText('Psychoterapeutka')
  await expect(profile).not.toContainText('Właściciel')
  await expect(profile.locator('.avatar__art--cross')).toBeVisible()
  expect(profilePayloads[1]).toMatchObject({ avatarKey: 'cross' })
  await page.reload()
  profile = page.locator('article').filter({ hasText: 'Anna Janowska-Kowalska' })
  await expect(profile.locator('.avatar__art--cross')).toBeVisible()
  const invitationAttempts = []
  let invitedSpecialistId = null
  await page.route('**/api/v1/workspace?*', async (route) => {
    if (!invitedSpecialistId) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    const body = await response.json()
    body.data.specialists = body.data.specialists.map((specialist) => specialist.id === invitedSpecialistId
      ? { ...specialist, version: 3, staffVersion: 1, accessStatus: 'invited' }
      : specialist)
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/v1/specialists/*/invitations', async (route) => {
    invitationAttempts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
      url: route.request().url(),
    })
    if (invitationAttempts.length === 1) {
      await route.abort('connectionfailed')
      return
    }
    invitedSpecialistId = new URL(route.request().url()).pathname.split('/').at(-2)
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          staff: {
            id: 'stf_specialist_profile_invite',
            displayName: 'Anna Janowska-Kowalska',
            email: 'anna-j@example.test',
            role: 'specialist',
            status: 'pending',
            version: 1,
            specialistId: invitedSpecialistId,
          },
          invitation: {
            id: 'inv_specialist_profile_invite',
            status: 'provisioning',
            expiresAt: '2030-01-08T00:00:00.000Z',
            emailSentAt: null,
            version: 1,
          },
        },
      }),
    })
  })
  await profile.getByRole('button', { name: 'Zaproś do panelu' }).click()
  const accessDialog = page.getByRole('dialog', {
    name: 'Zaproś do panelu — Anna Janowska-Kowalska',
  })
  await expect(accessDialog.getByRole('heading', { name: 'Zaproś do panelu' })).toBeVisible()
  await expect(accessDialog).toContainText('Anna Janowska-Kowalska')
  await expect(accessDialog).toContainText('Psychoterapeutka')
  await expect(accessDialog.getByText('Na ten adres wyślemy link do panelu.', { exact: true })).toBeVisible()
  await accessDialog.getByRole('button', { name: 'Zaproś do panelu' }).click()
  await expect(accessDialog.getByText('Podaj poprawny adres e-mail.', { exact: true })).toBeVisible()
  await accessDialog.getByLabel('Adres e-mail').fill('anna-j@example.test')
  await accessDialog.getByRole('button', { name: 'Zaproś do panelu' }).click()
  await expect(accessDialog.getByRole('button', { name: 'Spróbuj ponownie' })).toBeVisible()
  await expect(accessDialog).toContainText(
    'Nie mamy pewności, czy zmiany się zapisały. Kliknij „Spróbuj ponownie”, niczego nie zmieniając.',
  )
  await accessDialog.getByRole('button', { name: 'Spróbuj ponownie' }).click()

  await expect(profile).toContainText('Zaproszenie wysłane')
  await expect(profile.getByRole('button', { name: 'Zaproś do panelu' })).toHaveCount(0)
  await expect(page.getByText('Wysyłamy zaproszenie do anna-j@example.test', { exact: true })).toBeVisible()
  expect(invitationAttempts).toHaveLength(2)
  expect(invitationAttempts[1]).toEqual(invitationAttempts[0])
  expect(JSON.parse(invitationAttempts[0].body)).toEqual({
    email: 'anna-j@example.test',
    expectedVersion: 2,
  })
  expect(invitationAttempts[0].key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/)
  expect(new URL(invitationAttempts[0].url).search).toBe('')
})
