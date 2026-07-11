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
  await page.getByRole('button', { name: new RegExp(name) }).click()
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
  const group = page.getByRole('button', { name: /Grupa TUS 5–6 lat/ })
  await expect(group.getByText('5–6 lat', { exact: true })).toBeVisible()
})

test('TUS overview reports group and child counts', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Zajęcia TUS' }).click()
  await expect(page.locator('.view-head__sub')).toContainText('2 grupy · 11 dzieci')
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
  await drawer.getByLabel('Przedział wiekowy').fill('7–8 lat')
  await drawer.locator('label.check').first().click()
  await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()
  await page.getByRole('button', { name: /Grupa TUS testowa/ }).click()

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
  await drawer.getByLabel('Przedział wiekowy').fill('6–7 lat')
  await drawer.locator('label.check').first().click()
  await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()

  await page.getByRole('button', { name: /Grupa TUS z kartoteki/ }).click()
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
  await drawer.getByLabel('Przedział wiekowy').fill('5 lat')
  await drawer.locator('label.check').first().click()
  await drawer.getByRole('button', { name: 'Utwórz grupę' }).click()

  await page.getByRole('button', { name: /Grupa TUS nowa rodzina/ }).click()
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
  const waiting = page.locator('.card').filter({ hasText: 'Bez grupy' })
  const child = waiting.locator('.row').filter({ hasText: 'Borys Cygan' })
  await child.getByRole('button', { name: 'Przypisz' }).click()
  const drawer = page.getByRole('dialog', { name: 'Edycja profilu dziecka' })
  await drawer.getByLabel('Grupa').selectOption({ label: 'Grupa TUS 5–6 lat' })
  await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
  await expect(waiting.getByText('Borys Cygan')).toHaveCount(0)

  await page.getByRole('button', { name: /Grupa TUS 5–6 lat/ }).click()
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
    await page.getByRole('button', { name: /Grupa TUS 5–6 lat/ }).click()

    const box = await page.locator('.att:not([disabled])').first().boundingBox()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
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
  await page.getByRole('button', { name: /Grupa TUS 5–6 lat/ }).click()
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
  await page.getByRole('row', { name: /Renata Gawrys/ }).click()
  await page.getByRole('button', { name: /Ignacy Borkowski \(dziecko\)/ }).click()
  await expect(page.getByRole('heading', { name: /Ignacy Borkowski/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Renata Gawrys \(rodzic\)/ })).toBeVisible()
})

test('family links support a neutral role and unlinking', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
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

test('payment method is recorded from the payment picker', async ({ page }) => {
  // the popover closes on scroll and tweens on entry — keep the flow calm
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Finanse' }).click()
  // pin the row by id — `.is-due` is a live locator and jumps to the next
  // unpaid row the moment this one is settled. Fully unpaid rows are the
  // target: their method is always empty, so picking one must announce it.
  const unpaidRow = page
    .locator('tr.is-due')
    .filter({ has: page.getByRole('button', { name: 'Nieopłacona', exact: true }) })
    .first()
  const rowId = await unpaidRow.getAttribute('data-flip-id')
  const row = page.locator(`tr[data-flip-id="${rowId}"]`)
  const payPill = row.getByRole('button', { name: 'Nieopłacona', exact: true })
  await payPill.scrollIntoViewIfNeeded()
  await payPill.click()
  await page.getByRole('menuitemradio', { name: 'Opłacona', exact: true }).click()
  await expect(page.getByText(/Płatność zmieniona: opłacona/)).toBeVisible()
  const paidPill = row.getByRole('button', { name: 'Opłacona', exact: true })
  await paidPill.scrollIntoViewIfNeeded()
  await paidPill.click()
  await page.getByRole('menuitemradio', { name: 'Gotówka' }).click()
  await expect(page.getByText(/Forma płatności: gotówka/)).toBeVisible()
  await expect(row.getByText('Gotówka')).toBeVisible()
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
