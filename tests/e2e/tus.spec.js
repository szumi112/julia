import { test, expect } from '@playwright/test'

async function login(page) {
  await page.goto('.')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await expect(page.getByRole('main')).toBeVisible()
}

async function switchToTherapist(page) {
  await page.getByRole('button', { name: /Tryb demonstracyjny.*Julia Wolanin/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Marta Zielińska/ }).click()
}

async function openGroup(page, name) {
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await page.getByRole('link', { name: `Otwórz grupę — ${name}` }).click()
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible()
}

function localIsoDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

test('owner reviews TUS groups and toggles attendance', async ({ page }) => {
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  const cell = page.locator('.att:not([disabled])').first()
  const pressed = await cell.getAttribute('aria-pressed')
  await cell.click()
  await expect(cell).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true')
})

test('group cards surface their age bands', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  const group = page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS 5–6 lat' })
  await expect(group.getByText('5–6 lat', { exact: true })).toBeVisible()
})

test('TUS overview reports group and child counts', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await expect(page.locator('.view-head__sub')).toContainText('2 grupy · 9 dzieci w grupach · 2 oczekują na przydział')
})

test('attendance columns expose each child’s full name', async ({ page }) => {
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  await expect(page.getByRole('columnheader', { name: 'Hania Malik', exact: true })).toBeVisible()
})

test('group identity shows both leading psychologists', async ({ page }) => {
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  await expect(page.locator('.id-band__leaders .avatar')).toHaveCount(2)
})

test('class edit controls include the weekday and topic', async ({ page }) => {
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  const firstCell = page.locator('.att-table tbody tr').first().locator('td').first()
  const topic = (await firstCell.locator('.muted, .faint').textContent())?.trim()
  const edit = firstCell.getByRole('button')
  await expect(edit).toContainText(topic)
  await expect(edit).toHaveAccessibleName(/· (nd|pn|wt|śr|cz|pt|sb) ·/)
})

test('attendance unlocks when an open class reaches its start minute', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-07-15T15:59:00+02:00') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  const attendance = page.getByRole('button', { name: 'Hania Malik — 15 lipca' })

  await expect(attendance).toBeDisabled()
  await page.clock.fastForward(120_000)
  await expect(attendance).toBeEnabled()
})

test('a newly created empty group has bounded month navigation', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
  await drawer.getByLabel('Nazwa grupy').fill('Grupa TUS testowa')
  await drawer.getByLabel('Wiek od').fill('7')
  await drawer.getByLabel('Wiek do').fill('8')
  await drawer.locator('label.check').first().click()
  await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()
  await page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS testowa' }).click()

  await expect(page.getByRole('button', { name: 'Poprzedni miesiąc' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Następny miesiąc' })).toBeDisabled()
})

test('new group can add an existing child client from a searchable member picker', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
  const search = drawer.getByRole('combobox', { name: 'Szukaj dzieci' })

  await search.fill('Ignacy Lis')
  await expect(drawer.getByRole('listbox', { name: 'Wyniki wyszukiwania dzieci' })).toHaveAttribute('aria-multiselectable', 'true')
  await expect(drawer.getByRole('option', { name: /Ignacy Lis.*Grupa TUS 5–6 lat/ })).toBeDisabled()
  await search.fill('Ignacy Borkowski')
  await drawer.getByRole('option', { name: /Ignacy Borkowski.*Renata Gawrys/ }).click()
  await expect(drawer.getByRole('list', { name: 'Wybrane dzieci' })).toContainText('Ignacy Borkowski')

  await drawer.getByLabel('Nazwa grupy').fill('Grupa TUS z kartoteki')
  await drawer.getByLabel('Wiek od').fill('6')
  await drawer.getByLabel('Wiek do').fill('7')
  await drawer.locator('label.check').first().click()
  await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()

  await page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS z kartoteki' }).click()
  const roster = page.getByRole('heading', { name: 'Dzieci' }).locator('..')
  const importedChild = roster.locator('tbody tr').filter({ hasText: 'Ignacy Borkowski' })
  await expect(importedChild).toContainText('Ignacy Borkowski')
  await expect(roster).toContainText('Renata Gawrys')
  await expect(importedChild).not.toContainText(/·\s*l\./)
})

test('Escape closes member search without discarding the group drawer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
  const search = drawer.getByRole('combobox', { name: 'Szukaj dzieci' })

  await search.fill('Ignacy')
  await expect(drawer.getByRole('listbox', { name: 'Wyniki wyszukiwania dzieci' })).toBeVisible()
  await search.press('Escape')

  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('listbox', { name: 'Wyniki wyszukiwania dzieci' })).toHaveCount(0)
  await search.press('Escape')
  await expect(drawer).toHaveCount(0)
})

test('Escape closes parent search without discarding the child form', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  await page.getByRole('dialog', { name: 'Nowa grupa TUS' }).getByRole('button', { name: 'Dodaj nowe dziecko' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowe dziecko i rodzic' })
  const search = drawer.getByRole('combobox', { name: 'Szukaj rodzica lub opiekuna' })

  await search.fill('Renata')
  await expect(drawer.getByRole('listbox', { name: 'Wyniki wyszukiwania rodziców' })).toBeVisible()
  await search.press('Escape')

  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('listbox', { name: 'Wyniki wyszukiwania rodziców' })).toHaveCount(0)
  await search.press('Escape')
  await expect(drawer).toHaveCount(0)
})

test('parent search arrow keys select beyond the first result', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  await page.getByRole('dialog', { name: 'Nowa grupa TUS' }).getByRole('button', { name: 'Dodaj nowe dziecko' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowe dziecko i rodzic' })
  const search = drawer.getByRole('combobox', { name: 'Szukaj rodzica lub opiekuna' })

  await search.fill('anna')
  await search.press('ArrowDown')
  await search.press('Enter')

  await expect(drawer.locator('.parent-picked')).toContainText('Hanna Stępień')
})

test('parent search keeps a keyboard-active result inside the visible menu', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  await page.getByRole('dialog', { name: 'Nowa grupa TUS' }).getByRole('button', { name: 'Dodaj nowe dziecko' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowe dziecko i rodzic' })
  const search = drawer.getByRole('combobox', { name: 'Szukaj rodzica lub opiekuna' })

  await search.focus()
  for (let step = 0; step < 10; step++) await search.press('ArrowDown')
  const activeId = await search.getAttribute('aria-activedescendant')
  const activeOption = drawer.locator(`[id="${activeId}"]`)
  const activeIsVisible = await activeOption.evaluate((option) => {
    const menu = option.closest('[role="listbox"]')
    const optionRect = option.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    return optionRect.top >= menuRect.top && optionRect.bottom <= menuRect.bottom
  })

  expect(activeIsVisible).toBe(true)
})

test('group quick-create reuses a staged parent for linked siblings', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await page.getByRole('button', { name: 'Nowa grupa' }).click()
  let drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })

  await drawer.getByRole('button', { name: 'Dodaj nowe dziecko' }).click()
  drawer = page.getByRole('dialog', { name: 'Nowe dziecko i rodzic' })
  await drawer.getByLabel('Imię i nazwisko dziecka').fill('Mila Kowalska')
  await drawer.getByLabel('Wiek').fill('5')
  await drawer.getByRole('button', { name: 'Dodaj nowego rodzica' }).click()
  await drawer.getByLabel('Imię i nazwisko rodzica').fill('Anna Kowalska')
  await drawer.getByLabel('Telefon rodzica').fill('+48 600 123 456')
  await drawer.getByLabel('E-mail rodzica (opcjonalnie)').fill('anna.kowalska@example.com')
  await drawer.locator('label.check').filter({ hasText: 'Rodzic podpisał regulamin' }).click()
  await drawer.getByRole('button', { name: 'Dodaj do grupy' }).click()

  drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
  await expect(drawer.getByRole('list', { name: 'Wybrane dzieci' })).toContainText('Mila Kowalska')
  await drawer.getByRole('button', { name: 'Dodaj nowe dziecko' }).click()
  drawer = page.getByRole('dialog', { name: 'Nowe dziecko i rodzic' })
  await drawer.getByLabel('Imię i nazwisko dziecka').fill('Leo Kowalski')
  await drawer.getByLabel('Wiek').fill('7')
  await drawer.getByRole('combobox', { name: 'Szukaj rodzica lub opiekuna' }).fill('Anna Kowalska')
  await drawer.getByRole('option', { name: /Anna Kowalska.*do utworzenia z grupą/i }).click()
  await drawer.getByRole('button', { name: 'Dodaj do grupy' }).click()

  drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
  const selectedChildren = drawer.getByRole('list', { name: 'Wybrane dzieci' })
  await expect(selectedChildren).toContainText('Leo Kowalski')
  await expect(selectedChildren).toContainText('Mila Kowalska')
  await drawer.getByLabel('Nazwa grupy').fill('Grupa TUS nowa rodzina')
  await drawer.getByLabel('Wiek od').fill('5')
  await drawer.getByLabel('Wiek do').fill('5')
  await drawer.locator('label.check').first().click()
  await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()

  await page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS nowa rodzina' }).click()
  const roster = page.getByRole('heading', { name: 'Dzieci' }).locator('..')
  await expect(roster).toContainText('Mila Kowalska')
  await expect(roster).toContainText('Leo Kowalski')
  await expect(roster).toContainText('Anna Kowalska')
  await roster.getByRole('button', { name: 'Otwórz kartę klienta: Mila Kowalska' }).click()
  await expect(page.getByRole('heading', { name: 'Mila Kowalska' })).toBeVisible()
  await page.getByRole('button', { name: 'Anna Kowalska (rodzic)' }).click()
  await expect(page.getByRole('heading', { name: 'Anna Kowalska' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Leo Kowalski (dziecko)' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mila Kowalska (dziecko)' })).toBeVisible()
})

test('owner assigns a waiting child to an age group', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  const waiting = page.locator('.tus-waiting')
  await waiting.getByRole('button', { name: 'Przypisz dziecko — Borys Cygan' }).click()
  const dialog = page.getByRole('dialog', { name: 'Przypisz do grupy — Borys Cygan' })
  await dialog.getByRole('radio', { name: /Grupa TUS 5–6 lat/ }).check()
  await dialog.getByRole('button', { name: 'Przypisz do grupy' }).click()
  await expect(waiting.getByText('Borys Cygan')).toHaveCount(0)

  await page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS 5–6 lat' }).click()
  const roster = page.getByRole('heading', { name: 'Dzieci' }).locator('..')
  const assigned = roster.locator('tbody tr').filter({ hasText: 'Borys Cygan' }).locator('td').first()
  await expect(assigned).toContainText('Borys Cygan')
})

test.describe('touch layout', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
    viewport: { width: 360, height: 800 },
  })

  test('attendance controls keep a 44px touch target on coarse pointers', async ({ page }) => {
    await login(page)
    await page.getByRole('button', { name: /Szukaj/ }).click()
    await page.getByRole('combobox', { name: 'Szukaj w Aurelii' }).fill('TUS')
    await page.getByRole('option', { name: /Zajęcia TUS/ }).click()
    await page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS 5–6 lat' }).click()

    const target = await page.locator('.att:not([disabled])').first().boundingBox()
    expect(target?.width).toBeGreaterThanOrEqual(44)
    expect(target?.height).toBeGreaterThanOrEqual(44)
  })
})

test('owner books a TUS payment from the month list', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  const payments = page.locator('.card').filter({ hasText: /Płatności ·/ })
  const paidFigure = page.locator('.figures__item').filter({ hasText: 'Opłacone' }).locator('.figures__value > span')
  await expect(payments).toBeVisible()
  const bookButtons = payments.getByRole('button', { name: 'Zaksięguj' })
  const dueBefore = await bookButtons.count()
  test.skip(dueBefore === 0, 'seeded month happens to be fully paid')
  const paidBefore = Number(await paidFigure.textContent())
  await bookButtons.first().click()
  await expect(page.getByText(/Płatność zaksięgowana/)).toBeVisible()
  await expect(payments.getByRole('button', { name: 'Zaksięguj' })).toHaveCount(dueBefore - 1)
  await expect.poll(async () => Number(await paidFigure.textContent())).toBe(paidBefore + 1)
})

test('owner updates TUS payment method and invoice flag', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  const payments = page.locator('.card').filter({ hasText: /Płatności ·/ })
  const firstRow = payments.locator('tbody tr').first()
  const method = firstRow.getByRole('button', { name: /Forma płatności:/ })

  await method.scrollIntoViewIfNeeded()
  await method.click()
  await page.getByRole('menuitemradio', { name: 'Gotówka' }).click()
  await expect(method).toHaveAccessibleName('Forma płatności: Gotówka')
  const invoice = firstRow.getByRole('checkbox')
  const checked = await invoice.isChecked()
  await firstRow.locator('label.check').click()
  await expect(invoice).toBeChecked({ checked: !checked })
})

test('therapist sees only led groups without payment controls', async ({ page }) => {
  await login(page)
  await switchToTherapist(page) // Marta Zielińska (p2) leads only Grupa TUS 5–6 lat
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await expect(page.getByText('Grupa TUS 5–6 lat')).toBeVisible()
  await expect(page.getByText('Grupa TUS 4 lata')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Nowa grupa' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS 5–6 lat' }).click()
  await expect(page.getByRole('heading', { name: /Grupa TUS 5–6 lat/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Płatności/ })).toHaveCount(0)
  await expect(page.locator('.att:not([disabled])').first()).toBeVisible()
})

test('class reschedule flows through the drawer with a move toast', async ({ page }) => {
  await login(page)
  await openGroup(page, 'Grupa TUS 4 lata')
  await page.locator('.att-table tbody .link').first().click()
  const drawer = page.getByRole('dialog', { name: 'Edycja zajęć' })
  await expect(drawer).toBeVisible()
  const date = drawer.getByLabel('Data')
  const value = await date.inputValue()
  const moved = new Date(`${value}T12:00:00`)
  moved.setDate(moved.getDate() + 1)
  await date.fill(moved.toISOString().slice(0, 10))
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(page.getByText('Zajęcia przeniesione')).toBeVisible()
})

test('owner can add and delete a TUS class', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await openGroup(page, 'Grupa TUS 5–6 lat')
  await page.getByRole('button', { name: 'Dodaj zajęcia' }).click()
  let drawer = page.getByRole('dialog', { name: 'Nowe zajęcia' })
  const today = localIsoDate()
  await drawer.getByLabel('Data').fill(today)
  await drawer.getByLabel('Godzina').fill('08:00')
  await drawer.getByLabel('Temat zajęć').fill('Próba zajęć do usunięcia')
  await drawer.getByRole('button', { name: 'Dodaj zajęcia' }).click()

  const added = page.getByRole('button', { name: /Próba zajęć do usunięcia/ })
  await expect(added).toBeVisible()
  await added.click()
  drawer = page.getByRole('dialog', { name: 'Edycja zajęć' })
  await drawer.getByRole('button', { name: 'Usuń', exact: true }).click()
  await drawer.getByRole('button', { name: 'Tak, usuń zajęcia' }).click()
  await expect(page.getByText('Próba zajęć do usunięcia')).toHaveCount(0)
})

test('family links surface on both client records', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('link', { name: 'Otwórz kartę — Renata Gawrys' }).click()
  await page.getByRole('button', { name: /Ignacy Borkowski \(dziecko\)/ }).click()
  await expect(page.getByRole('heading', { name: /Ignacy Borkowski/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Renata Gawrys \(rodzic\)/ })).toBeVisible()
})

test('family links support a neutral role and unlinking', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  await page.locator('.id-band__actions').getByRole('button', { name: 'Edytuj' }).click()
  let drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByLabel('Powiąż z klientem').selectOption({ label: 'Joanna Madej' })
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(page.getByRole('button', { name: 'Joanna Madej (rodzina)' })).toBeVisible()

  await page.locator('.id-band__actions').getByRole('button', { name: 'Edytuj' }).click()
  drawer = page.getByRole('dialog', { name: 'Edycja klienta' })
  await drawer.getByRole('button', { name: 'Usuń powiązanie z rodziną' }).click()
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  const family = page.locator('.care-overview__item').filter({ hasText: 'Rodzina' })
  await expect(family.getByText('—', { exact: true })).toBeVisible()
})

test('payment method is recorded from the calendar payment picker', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  const agenda = page.getByRole('region', { name: 'Plan dnia' })
  await agenda.getByRole('button', { name: /Zakończone i odwołane/ }).click()
  const unpaidRow = agenda.locator('[data-terminal="true"][data-payment="unpaid"]').first()
  const rowId = await unpaidRow.getAttribute('data-flip-id')
  const row = agenda.locator(`[data-flip-id="${rowId}"]`)
  const payPill = row.getByRole('button', { name: /Płatność: Nieopłacona/ })
  await payPill.scrollIntoViewIfNeeded()
  await payPill.click()
  await page.getByRole('menuitemradio', { name: 'Opłacona', exact: true }).click()
  await expect(page.getByText(/Płatność zmieniona: opłacona/)).toBeVisible()
  const paidPill = row.getByRole('button', { name: /Płatność: Opłacona/ })
  await paidPill.scrollIntoViewIfNeeded()
  await paidPill.click()
  await page.getByRole('menuitemradio', { name: 'Gotówka' }).click()
  await expect(page.getByText(/Forma płatności: gotówka/)).toBeVisible()
  await paidPill.click()
  await expect(page.getByRole('menuitemradio', { name: 'Gotówka' })).toHaveAttribute('aria-checked', 'true')
})

test('session form exposes payment method only for paid sessions', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: 'Nowa sesja' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await expect(drawer.getByRole('radiogroup', { name: 'Forma płatności' })).toHaveCount(0)
  await drawer.getByRole('radio', { name: 'Opłacona', exact: true }).click()
  await expect(drawer.getByRole('radiogroup', { name: 'Forma płatności' })).toBeVisible()
})

test('google calendar demo toggle connects and disconnects', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Ustawienia' }).click()
  await page.getByRole('button', { name: 'Połącz (demo)' }).click()
  await expect(page.getByText('Połączono z Google Calendar (demo)')).toBeVisible()
  const disconnect = page.getByRole('button', { name: 'Rozłącz' })
  await expect(disconnect).toBeVisible()
  await disconnect.click()
  await expect(page.getByRole('button', { name: 'Połącz (demo)' })).toBeVisible()
})

test.describe('Task 5 TUS redesign', () => {
  test('overview separates counts, searches in ordered sections, and focuses an assigned child', async ({ page }) => {
    await login(page)
    await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Grupy TUS', exact: true })).toBeVisible()
    const summary = page.locator('.view-head__sub')
    await expect(summary).toContainText('2 grupy')
    await expect(summary).toContainText('9 dzieci w grupach')
    await expect(summary).toContainText('2 oczekują na przydział')
    expect(await page.locator('.gcard').getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('aria-label')))).toEqual([
      'Otwórz grupę — Grupa TUS 4 lata',
      'Otwórz grupę — Grupa TUS 5–6 lat',
    ])
    const groupLink = page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS 5–6 lat', exact: true })
    await expect(groupLink).toHaveAccessibleName('Otwórz grupę — Grupa TUS 5–6 lat')
    const namedGroupCard = page.getByRole('article', { name: 'Grupa TUS 5–6 lat', exact: true })
    await expect(namedGroupCard.getByRole('heading', { level: 2, name: 'Grupa TUS 5–6 lat', exact: true })).toBeVisible()
    const groupCardLabels = await page.locator('.gcard').evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-labelledby')))
    expect(groupCardLabels.every(Boolean)).toBe(true)
    expect(new Set(groupCardLabels).size).toBe(groupCardLabels.length)

    await page.setViewportSize({ width: 1280, height: 420 })
    const content = page.locator('main.content')
    const savedScroll = await content.evaluate((element) => {
      element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight)
      return element.scrollTop
    })
    expect(savedScroll).toBeGreaterThan(0)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('button', { name: 'Zespół' }).click()
    await navigation.getByRole('button', { name: 'Zajęcia TUS' }).click()
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(savedScroll)

    const search = page.getByPlaceholder('Dziecko, rodzic lub grupa')
    await search.fill('5')
    const groupHeading = page.getByRole('heading', { name: 'Grupy', exact: true })
    const peopleHeading = page.getByRole('heading', { name: 'Dzieci i rodzice', exact: true })
    await expect(groupHeading).toBeVisible()
    await expect(peopleHeading).toBeVisible()
    expect(await groupHeading.evaluate((group, people) => Boolean(group.compareDocumentPosition(people) & Node.DOCUMENT_POSITION_FOLLOWING), await peopleHeading.elementHandle())).toBe(true)

    await search.fill('Hania Malik')
    await page.getByRole('link', { name: 'Otwórz dziecko — Hania Malik', exact: true }).click()
    const selectedChild = page.locator('[data-kid-id="k1"]')
    await expect(selectedChild).toBeFocused()
    await expect(selectedChild).toHaveAccessibleName('Wybrane dziecko — Hania Malik')
  })

  test('quick assignment orders recommendations, disables full groups, and restores coherent focus', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await login(page)
    await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
    const search = page.getByPlaceholder('Dziecko, rodzic lub grupa')
    await search.fill('5')
    await page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS 5–6 lat' }).click()
    await page.getByRole('button', { name: 'Edytuj grupę' }).click()
    let drawer = page.getByRole('dialog', { name: 'Edycja grupy TUS' })
    await drawer.getByLabel('Liczba miejsc').fill('5')
    await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
    await page.getByRole('button', { name: 'Wróć do zajęć TUS' }).click()
    await expect(search).toHaveValue('5')

    await page.getByRole('button', { name: 'Nowa grupa' }).click()
    drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
    await drawer.getByLabel('Nazwa grupy').fill('Grupa A rekomendowana')
    await drawer.getByLabel('Wiek od').fill('5')
    await drawer.getByLabel('Wiek do').fill('6')
    await drawer.getByLabel('Liczba miejsc').fill('8')
    await drawer.locator('label.check').first().click()
    await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()

    await search.fill('Borys Cygan')
    const searchAssignment = page.getByRole('button', { name: 'Przypisz dziecko — Borys Cygan' })
    await searchAssignment.click()
    let dialog = page.getByRole('dialog', { name: 'Przypisz do grupy — Borys Cygan' })
    const options = dialog.locator('.tus-assignment-option')
    await expect(options).toHaveCount(3)
    await expect(options.nth(0)).toContainText('Grupa A rekomendowana')
    await expect(options.nth(0)).toContainText('0/8')
    await expect(options.nth(0)).toContainText('Polecana')
    await expect(options.nth(1)).toContainText('Grupa TUS 4 lata')
    await expect(options.nth(1)).toContainText('4/8')
    await expect(options.nth(1)).toContainText('Poza przedziałem wiekowym')
    await expect(options.nth(1).getByRole('radio')).toBeEnabled()
    await expect(options.nth(2)).toContainText('Grupa TUS 5–6 lat')
    await expect(options.nth(2)).toContainText('5/5')
    await expect(options.nth(2).getByRole('radio')).toBeDisabled()
    await expect(options.nth(0).getByRole('radio')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(searchAssignment).toBeFocused()

    await searchAssignment.click()
    dialog = page.getByRole('dialog', { name: 'Przypisz do grupy — Borys Cygan' })
    const reopenedOptions = dialog.locator('.tus-assignment-option')
    await reopenedOptions.nth(1).getByRole('radio').check()
    await dialog.getByRole('button', { name: 'Przypisz do grupy' }).click()

    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('Borys Cygan przypisany do grupy Grupa TUS 4 lata')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Przypisz dziecko — Borys Cygan' })).toHaveCount(0)
    await expect(search).toBeFocused()
    await expect(page.locator('.view-head__sub')).toContainText('10 dzieci w grupach')
    await expect(page.locator('.view-head__sub')).toContainText('1 oczekuje na przydział')

    await search.fill('')
    await page.getByRole('link', { name: 'Otwórz grupę — Grupa TUS 4 lata' }).click()
    const assigned = page.locator('[data-kid-id="k10"]')
    await expect(assigned).toContainText('Borys Cygan')
    await expect(assigned).toContainText('Alina Cygan')
    await expect(assigned).toContainText('+48 610 329 465')
    await expect(assigned.getByRole('checkbox')).not.toBeChecked()
    const payment = page.locator('.card').filter({ hasText: /Płatności ·/ }).locator('tbody tr').filter({ hasText: 'Borys Cygan' })
    await expect(payment).toContainText('Nieopłacona')
  })

  test('quick assignment keeps ownership of Ctrl and Cmd K while its native modal is open', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await login(page)
    await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
    const search = page.getByPlaceholder('Dziecko, rodzic lub grupa')
    await search.fill('Borys Cygan')
    const assignment = page.getByRole('button', { name: 'Przypisz dziecko — Borys Cygan' })
    await assignment.click()

    const dialog = page.getByRole('dialog', { name: 'Przypisz do grupy — Borys Cygan' })
    const firstOption = dialog.getByRole('radio').first()
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true)
    await expect(firstOption).toBeFocused()

    for (const shortcut of ['Control+K', 'Meta+K']) {
      await page.keyboard.press(shortcut)
      await expect(page.getByRole('dialog', { name: 'Szukaj w Aurelii' })).toHaveCount(0)
      expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true)
      await expect(firstOption).toBeFocused()
    }

    await firstOption.press('Space')
    await expect(firstOption).toBeChecked()
    await dialog.getByRole('button', { name: 'Zamknij' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(assignment).toBeFocused()
  })

  test('group form validates integer bounds and synchronizes its readable age label', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await login(page)
    await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
    await page.getByRole('button', { name: 'Nowa grupa' }).click()
    const drawer = page.getByRole('dialog', { name: 'Nowa grupa TUS' })
    await drawer.getByLabel('Nazwa grupy').fill('Grupa TUS walidacja')
    await drawer.getByLabel('Wiek od').fill('5')
    await drawer.getByLabel('Wiek do').fill('4')
    await drawer.getByLabel('Liczba miejsc').fill('0')
    await drawer.locator('label.check').first().click()
    await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()

    await expect(drawer.getByLabel('Wiek do')).toHaveValue('4')
    await expect(drawer.getByLabel('Liczba miejsc')).toHaveValue('0')
    await expect(drawer.getByLabel('Wiek do')).toBeFocused()
    await expect(drawer).toContainText('Wiek końcowy nie może być mniejszy niż początkowy')
    await drawer.getByLabel('Wiek od').fill('3')
    await expect(drawer.getByText('Wiek końcowy nie może być mniejszy niż początkowy')).toHaveCount(0)
    await expect(drawer.getByText('Przedział: 3–4 lat')).toBeVisible()

    await drawer.getByLabel('Wiek do').fill('2.5')
    await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()
    await expect(drawer.getByText('Wiek musi być dodatnią liczbą całkowitą')).toBeVisible()
    await drawer.getByLabel('Wiek od').fill('2')
    await expect(drawer.getByText('Wiek musi być dodatnią liczbą całkowitą')).toBeVisible()

    await drawer.getByLabel('Wiek od').fill('5')
    await drawer.getByLabel('Wiek do').fill('5')
    await drawer.getByLabel('Liczba miejsc').fill('2.5')
    await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()
    await expect(drawer.getByLabel('Liczba miejsc')).toHaveValue('2.5')
    await expect(drawer).toContainText('Liczba miejsc musi być dodatnią liczbą całkowitą')

    await drawer.getByLabel('Liczba miejsc').fill('9')
    await expect(drawer.getByText('Przedział: 5 lat')).toBeVisible()
    await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()
    const groupCard = page.locator('.gcard').filter({ hasText: 'Grupa TUS walidacja' })
    await expect(groupCard).toContainText('5 lat')
  })

  test('therapist search never exposes waiting children or groups they do not lead', async ({ page }) => {
    await login(page)
    await switchToTherapist(page)
    await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
    await expect(page.locator('.view-head__sub')).toContainText('1 grupa')
    await expect(page.locator('.view-head__sub')).not.toContainText('oczek')
    await expect(page.getByText('Bez grupy', { exact: true })).toHaveCount(0)

    const search = page.getByPlaceholder('Dziecko, rodzic lub grupa')
    await search.fill('Borys Cygan')
    await expect(page.getByRole('link', { name: /Borys Cygan/ })).toHaveCount(0)
    await search.fill('Antek Duda')
    await expect(page.getByRole('link', { name: /Antek Duda/ })).toHaveCount(0)
    await search.fill('Hania Malik')
    await expect(page.getByRole('link', { name: 'Otwórz dziecko — Hania Malik' })).toBeVisible()
  })
})
