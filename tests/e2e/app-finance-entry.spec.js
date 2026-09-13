import { expect, test } from '@playwright/test'

// Browser contract tests: Access-asserted finance commands are simulated here.
// Their actual transactions and authorization are covered by the D1 worker suites.
// Participant/group setup and ordinary directory reads still use the local Worker.
const json = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify({ data }) })
const settlement = (entry) => Object.fromEntries(['accountingMonth', 'paidAmountGrosze',
  'paymentMethod', 'settlementStatus', 'invoiceStatus'].map((field) => [field, entry[field]]))

test('@owner keeps invalid manual finance input editable without sending or locking a save', async ({ page }) => {
  const requests = []
  await page.route('**/api/v1/finance/entries', (route) => {
    requests.push(route.request().postDataJSON())
    return route.abort()
  })
  await page.goto('./#/payments')
  await page.getByRole('button', { name: 'Dodaj pozycję', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa pozycja finansowa' })
  await expect(drawer.getByLabel('Opis pozycji')).toHaveAttribute('placeholder', 'Wpisz, za co jest ta pozycja')
  await drawer.getByRole('button', { name: 'Dodaj pozycję', exact: true }).click()
  await expect(drawer.getByLabel('Opis pozycji')).toHaveAttribute('aria-invalid', 'true')
  await expect(drawer.getByLabel('Kwota (zł)', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await expect(drawer.getByText('Wpisz, za co jest ta pozycja', { exact: true })).toBeVisible()
  await expect(drawer.getByText('Wpisz kwotę, np. 180 albo 180,50', { exact: true })).toBeVisible()
  await expect(drawer.getByLabel('Opis pozycji')).toBeFocused()
  expect(requests).toEqual([])
  await drawer.getByLabel('Opis pozycji').fill('Opłata za zajęcia')
  await drawer.getByLabel('Kwota (zł)', { exact: true }).fill('10,001')
  await drawer.getByRole('button', { name: 'Dodaj pozycję', exact: true }).click()
  await expect(drawer.getByText('Wpisz kwotę, np. 180 albo 180,50', { exact: true })).toBeVisible()
  await drawer.getByLabel('Kwota (zł)', { exact: true }).fill('180')
  await drawer.getByLabel('Łącznie wpłacono (zł)').fill('10,001')
  await drawer.getByRole('button', { name: 'Dodaj pozycję', exact: true }).click()
  await expect(drawer.getByLabel('Łącznie wpłacono (zł)')).toHaveAttribute('aria-invalid', 'true')
  await expect(drawer.getByLabel('Łącznie wpłacono (zł)')).toBeFocused()
  await expect(drawer.getByLabel('Opis pozycji')).toBeEnabled()
  await expect(drawer.getByRole('button', { name: 'Anuluj', exact: true })).toBeEnabled()
  await expect(drawer.getByRole('button', { name: 'Ponów ten sam zapis' })).toHaveCount(0)
  expect(requests).toEqual([])
  await drawer.getByLabel('Opis pozycji').fill('Opłata za zajęcia')
  await expect(drawer.getByLabel('Opis pozycji')).toHaveValue('Opłata za zajęcia')
})

test('@owner lets a new entry follow its date until the accounting month is selected manually', async ({ page }) => {
  await page.goto('./#/payments')
  await page.getByRole('button', { name: 'Dodaj pozycję', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa pozycja finansowa' })
  const month = drawer.getByLabel('Miesiąc rozliczenia')
  await drawer.getByLabel('Data').fill('2026-08-14')
  await expect(month).toHaveValue('2026-08')
  await month.selectOption('2026-07')
  await drawer.getByLabel('Data').fill('2026-09-02')
  await expect(month).toHaveValue('2026-07')
  await expect(drawer.getByText(
    'Zwykle miesiąc z daty; zmień, jeśli pozycja ma się liczyć do innego miesiąca.',
    { exact: true },
  )).toBeVisible()
})

async function installEntryContract(page, { programId = null } = {}) {
  let entry = null
  let charge = null
  const history = []
  const requests = []
  const adjustments = []
  let committedKey = null
  const entryId = 'fin_browser_contract'
  const chargeId = 'ach_browser_contract'
  await page.route(programId ? '**/api/v1/activities/charges' : '**/api/v1/finance/entries', async (route) => {
    const body = route.request().postDataJSON()
    const key = route.request().headers()['idempotency-key']
    expect(key).toMatch(/^[A-Za-z0-9._~-]{8,128}$/)
    requests.push({ body, key })
    if (programId && entry && key !== committedKey) return route.fulfill({ status: 409,
      contentType: 'application/json', body: JSON.stringify({ error: {
        code: 'ACTIVITY_CHARGE_EXISTS', correlationId: 'cor_browser_duplicate',
      } }) })
    if (entry) expect({ body, key }).toEqual(requests[0])
    else {
      committedKey = key
      const now = new Date().toISOString()
      if (programId) {
        const tus = programId === 'apg_tus'
        expect(body).toEqual({ participantId: expect.stringMatching(/^acp_/),
          groupId: tus ? expect.stringMatching(/^agr_/) : null,
          membershipId: tus ? expect.stringMatching(/^amb_/) : null,
          responsibleSpecialistId: 'sp_local_specialist', accountingMonth: expect.stringMatching(/^\d{4}-\d{2}$/),
          amountGrosze: tus ? 34000 : 9000, lessonCount: tus ? null : 1,
          paidAmountGrosze: 0, paymentMethod: 'unknown', settlementStatus: 'unpaid', invoiceStatus: 'not_required' })
        charge = { id: chargeId, participantId: body.participantId, programId,
          groupId: body.groupId, membershipId: body.membershipId,
          period: { precision: 'month', month: body.accountingMonth, day: null },
          lessonCount: body.lessonCount, responsibleSpecialistId: body.responsibleSpecialistId,
          financeEntryId: entryId, status: 'active', version: 1, createdAt: now, updatedAt: now }
      } else expect(body).toEqual({ kind: 'expense', recordType: 'expense', accountingMonth: expect.stringMatching(/^\d{4}-\d{2}$/),
        occurredOn: null, amountGrosze: 12345, paidAmountGrosze: 0, paymentMethod: 'unknown', settlementStatus: 'unpaid',
        invoiceStatus: 'not_required', counterparty: '', sourceLabel: 'Fikcyjny zakup pomocy edukacyjnych',
        invoiceNote: '', specialistId: null, lessonCount: null, source: null })
      entry = { id: entryId, version: 1, kind: programId ? 'income' : body.kind,
        recordType: programId ? programId.slice(4) : body.recordType,
        accountingMonth: body.accountingMonth, occurredOn: null,
        amountGrosze: body.amountGrosze, paidAmountGrosze: body.paidAmountGrosze,
        paymentMethod: body.paymentMethod, settlementStatus: body.settlementStatus, invoiceStatus: body.invoiceStatus,
        appointmentId: null, counterparty: body.counterparty ?? '', sourceLabel: body.sourceLabel ?? 'Fikcyjne rozliczenie zajęć' }
    }
    // Model a committed write whose response was lost; retry must not create another entry.
    if (!programId && requests.length === 1) return route.abort('failed')
    return route.fulfill(json(programId ? { chargeId, entryId, version: 1 } : { entryId, version: 1 }, 201))
  })
  await page.route(`**/api/v1/finance/entries/${entryId}`, (route) => route.fulfill(json({
    entry, adjustments: history, historyTruncated: false,
  })))
  await page.route(`**/api/v1/finance/entries/${entryId}/adjustments`, (route) => {
    const body = route.request().postDataJSON()
    expect(body).toEqual({ expectedVersion: entry.version, reason: programId
      ? 'Potwierdzono fikcyjną wpłatę TUS' : 'Potwierdzono fikcyjną zapłatę i fakturę.',
      accountingMonth: entry.accountingMonth, paidAmountGrosze: programId ? 34000 : 12345,
      paymentMethod: programId ? 'unknown' : 'transfer', settlementStatus: 'paid', invoiceStatus: programId ? 'not_required' : 'issued' })
    expect(route.request().headers()['idempotency-key']).toMatch(/^[A-Za-z0-9._~-]{8,128}$/)
    adjustments.push(body)
    const before = settlement(entry)
    entry = { ...entry, ...settlement(body), version: entry.version + 1 }
    history.unshift({ id: `fadj_browser_${entry.version}`, createdAt: new Date().toISOString(),
      reason: body.reason, before, after: settlement(entry) })
    if (charge) charge = { ...charge, version: charge.version + 1, updatedAt: history[0].createdAt }
    return route.fulfill(json({ entryId, version: entry.version }))
  })
  if (programId) await page.route('**/api/v1/activities/workspace?*', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    if (charge) {
      const { from, to } = payload.data
      if (entry.accountingMonth >= from && entry.accountingMonth <= to) {
        payload.data.charges.push({ ...charge, finance: { amountGrosze: entry.amountGrosze,
          paidAmountGrosze: entry.paidAmountGrosze, paymentMethod: entry.paymentMethod, settlementStatus: entry.settlementStatus } })
        payload.data.charges.sort((a, b) => a.id.localeCompare(b.id))
        payload.data.latestPopulatedMonths[programId.slice(4)] = entry.accountingMonth
      }
    }
    return route.fulfill({ response, json: payload })
  })
  else await page.route('**/api/v1/finance/window?*', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    if (entry && payload.data.selectedMonth === entry.accountingMonth) {
      payload.data.rows.push({ id: entry.id, sourceKind: 'panel', appointmentId: null,
        accountingMonth: entry.accountingMonth, occurredOn: null, kind: 'expense', recordType: 'expense',
        revenueGrosze: 0, receivableGrosze: 0, collectedGrosze: 0, expenseGrosze: entry.amountGrosze,
        specialistId: null, serviceId: null, program: null, paymentMethod: entry.paymentMethod,
        invoiceStatus: entry.invoiceStatus, version: entry.version, settlementStatus: entry.settlementStatus,
        counterparty: entry.counterparty, sourceLabel: entry.sourceLabel })
      payload.data.kpis.expensesGrosze += entry.amountGrosze
      payload.data.kpis.incomeGrosze -= entry.amountGrosze
      Object.assign(payload.data.trend.at(-1), payload.data.kpis)
      payload.data.coverage.monthOnlyCount += 1
      payload.data.latestPopulatedMonth = entry.accountingMonth
    }
    return route.fulfill({ response, json: payload })
  })
  return { requests, adjustments }
}

test('@owner UI contract creates a compact expense and retains its settlement classification on correction', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { requests, adjustments } = await installEntryContract(page)
  await page.goto('./#/payments')
  await page.getByRole('button', { name: 'Dodaj pozycję', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa pozycja finansowa' })
  await drawer.getByLabel('Rodzaj').selectOption('expense')
  await expect(drawer.getByLabel('Łącznie wpłacono (zł)')).toHaveCount(0)
  await expect(drawer.getByLabel('Forma płatności')).toHaveCount(0)
  await expect(drawer.getByLabel('Status płatności')).toHaveCount(0)
  await expect(drawer.getByLabel('Stan faktury')).toHaveCount(0)
  await drawer.getByLabel('Opis pozycji').fill('Fikcyjny zakup pomocy edukacyjnych')
  await drawer.getByLabel('Kwota (zł)', { exact: true }).fill('123,45')
  await drawer.getByRole('button', { name: 'Dodaj pozycję', exact: true }).click()
  await expect(drawer.getByRole('alert')).toContainText('Nie potwierdzono zapisu')
  await expect(drawer.getByLabel('Kwota (zł)', { exact: true })).toBeDisabled()
  await drawer.getByRole('button', { name: 'Ponów ten sam zapis' }).click()
  await expect(drawer).toHaveCount(0)
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])

  const row = page.getByRole('row').filter({ hasText: 'Fikcyjny zakup pomocy edukacyjnych' })
  await row.getByRole('button', { name: 'Rozliczenie / faktura' }).click()
  const edit = page.getByRole('dialog', { name: 'Rozliczenie i faktura' })
  await expect(edit.getByLabel('Kwota zapłacona (zł)')).toHaveValue('0.00')
  await expect(edit.getByLabel('Stan zapłaty')).toHaveValue('unpaid')
  await expect(edit.getByLabel('Forma zapłaty')).toHaveValue('unknown')
  await expect(edit.getByLabel('Stan faktury')).toHaveValue('not_required')
  await edit.getByLabel('Kwota zapłacona (zł)').fill('123,45')
  await edit.getByLabel('Stan zapłaty').selectOption('paid')
  await edit.getByLabel('Forma zapłaty').selectOption('transfer')
  await edit.getByLabel('Stan faktury').selectOption('issued')
  await edit.getByLabel('Powód korekty').fill('Potwierdzono fikcyjną zapłatę i fakturę.')
  await edit.getByRole('button', { name: 'Zapisz korektę' }).click()
  await expect(edit).toHaveCount(0)
  await row.getByRole('button', { name: 'Rozliczenie / faktura' }).click()
  await expect(edit.getByLabel('Kwota zapłacona (zł)')).toHaveValue('123.45')
  await expect(edit.getByLabel('Stan faktury')).toHaveValue('issued')
  await expect(edit.getByRole('region', { name: 'Historia korekt' })).toContainText('Potwierdzono fikcyjną zapłatę i fakturę.')
  expect(adjustments).toHaveLength(1)
})

test('@owner UI contract bills individual English lessons and rejects a duplicate monthly charge', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { requests } = await installEntryContract(page, { programId: 'apg_english' })
  await page.goto('./#/english')
  await page.getByRole('button', { name: 'Nowy uczestnik', exact: true }).click()
  const participant = page.getByRole('dialog', { name: 'Nowy uczestnik angielskiego' })
  await participant.getByLabel('Imię i nazwisko').fill('Fikcyjny Uczeń Rozliczenia')
  await participant.getByRole('button', { name: 'Utwórz uczestnika' }).click()
  await expect(participant).toHaveCount(0)
  for (const duplicate of [false, true]) {
    await page.getByRole('button', { name: 'Dodaj rozliczenie miesiąca' }).click()
    const drawer = page.getByRole('dialog', { name: 'Nowe rozliczenie miesiąca' })
    await drawer.getByLabel('Uczestnik', { exact: true }).selectOption({ label: 'Fikcyjny Uczeń Rozliczenia' })
    await drawer.getByLabel('Odpowiedzialny specjalista').selectOption({ label: 'Zofia Fikcyjna' })
    await drawer.getByLabel('Liczba lekcji').fill('1')
    await drawer.getByLabel('Kwota (zł)', { exact: true }).fill('90')
    await drawer.getByRole('button', { name: 'Dodaj pozycję' }).click()
    if (duplicate) await expect(drawer.getByRole('alert')).toContainText('już istnieje')
    else {
      await expect(drawer).toHaveCount(0)
      await expect(page.getByRole('row').filter({ hasText: 'Fikcyjny Uczeń Rozliczenia' })).toContainText('90')
    }
  }
  expect(requests).toHaveLength(2)
  expect(requests[0].body).toEqual(requests[1].body)
  expect(requests[0].key).not.toEqual(requests[1].key)
})

test('@owner UI contract bills a TUS participant through an explicit group membership', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { requests, adjustments } = await installEntryContract(page, { programId: 'apg_tus' })
  await page.goto('./#/tus')
  await page.getByRole('button', { name: 'Nowy uczestnik TUS' }).click()
  const participant = page.getByRole('dialog', { name: 'Nowy uczestnik TUS' })
  await participant.getByLabel('Imię i nazwisko').fill('Fikcyjny Uczestnik Rozliczenia TUS')
  await participant.getByRole('button', { name: 'Utwórz uczestnika' }).click()
  await expect(participant).toHaveCount(0)
  await page.getByRole('button', { name: 'Nowa grupa', exact: true }).click()
  const group = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
  await group.getByLabel('Nazwa grupy').fill('Fikcyjna grupa rozliczenia TUS')
  await group.getByRole('button', { name: 'Utwórz grupę' }).click()
  await expect(group).toHaveCount(0)
  await page.getByRole('link', { name: 'Otwórz grupę — Fikcyjna grupa rozliczenia TUS' }).click()
  const month = await page.locator('.month-nav time').getAttribute('datetime')
  await page.getByRole('button', { name: 'Zapisz do grupy', exact: true }).click()
  const membership = page.getByRole('dialog', { name: 'Zapisz uczestnika do grupy' })
  await membership.getByLabel('Uczestnik').selectOption({ label: 'Fikcyjny Uczestnik Rozliczenia TUS' })
  await membership.getByLabel('Data rozpoczęcia').fill(`${month}-01`)
  await membership.getByRole('button', { name: 'Zapisz do grupy', exact: true }).click()
  await expect(membership).toHaveCount(0)
  await page.getByRole('button', { name: 'Dodaj rozliczenie miesiąca' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowe rozliczenie miesiąca' })
  await drawer.getByLabel('Uczestnik', { exact: true }).selectOption({ label: 'Fikcyjny Uczestnik Rozliczenia TUS' })
  await expect(drawer.getByLabel('Przypisanie do grupy')).toHaveCount(0)
  await expect(drawer.getByLabel('Miesiąc rozliczenia')).toHaveCount(0)
  await drawer.getByLabel('Odpowiedzialny specjalista').selectOption({ label: 'Zofia Fikcyjna' })
  await drawer.getByLabel('Kwota (zł)', { exact: true }).fill('340')
  await drawer.getByRole('button', { name: 'Dodaj pozycję' }).click()
  await expect(drawer).toHaveCount(0)
  const charge = page.getByRole('row').filter({ hasText: 'Fikcyjny Uczestnik Rozliczenia TUS' })
  await expect(charge).toContainText('340')
  await charge.getByRole('button', { name: 'Rozliczenie / faktura' }).click()
  const adjustment = page.getByRole('dialog', { name: 'Rozliczenie i faktura' })
  await adjustment.getByLabel('Łącznie wpłacono (zł)').fill('340')
  await adjustment.getByLabel('Status płatności').selectOption('paid')
  await adjustment.getByLabel('Powód korekty').fill('Potwierdzono fikcyjną wpłatę TUS')
  await adjustment.getByRole('button', { name: 'Zapisz korektę' }).click()
  await expect(adjustment).toHaveCount(0)
  await expect(charge.getByText('Opłacona', { exact: true })).toBeVisible()
  await expect(page.getByText('Dane są teraz niedostępne')).toHaveCount(0)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ body: {
    participantId: expect.stringMatching(/^acp_/), groupId: expect.stringMatching(/^agr_/),
    membershipId: expect.stringMatching(/^amb_/), accountingMonth: month,
    amountGrosze: 34_000, paidAmountGrosze: 0, settlementStatus: 'unpaid',
  }, key: expect.stringMatching(/^[A-Za-z0-9._~-]{8,128}$/) })
  expect(adjustments).toHaveLength(1)
})
