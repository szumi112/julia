import { test, expect } from '@playwright/test'

async function login(page) {
  await page.goto('.')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await expect(page.getByRole('main')).toBeVisible()
}

async function openPhoneDestination(page, label) {
  const bottomNavigation = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  const direct = bottomNavigation.getByRole('link', { name: label, exact: true })
  if (await direct.count()) {
    await direct.click()
    return
  }
  await bottomNavigation.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('dialog', { name: 'Nawigacja' })
    .getByRole('link', { name: label, exact: true })
    .click()
}

async function addClient(page, name, psychId = 'p1') {
  await page.locator('.view-head__actions').getByRole('button', { name: 'Dodaj klienta' }).click()
  const dialog = page.getByRole('dialog', { name: 'Nowy klient' })
  await dialog.getByLabel('Imię i nazwisko').fill(name)
  await dialog.getByLabel('Specjalistka prowadząca').selectOption(psychId)
  await dialog.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(dialog).toBeHidden()
}

// The calendar navigates by week and by month; an arbitrary date is reached
// through the route the way every deep link into it does.
const openCalendarDay = (page, iso) =>
  page.evaluate((target) => { window.location.hash = target }, `#/calendar?date=${iso}`)
const selectedDay = (page) => page.locator('.day-strip__day.is-on')

async function setAgendaStatus(page, accessibleName, targetStatus) {
  const agenda = page.getByRole('region', { name: 'Plan dnia' })
  await agenda.getByRole('button', { name: accessibleName }).click()
  await page.getByRole('menuitemradio', { name: targetStatus, exact: true }).click()
}

async function expectTextStableAcrossFrames(locator, text, frames = 4) {
  await expect(locator).toContainText(text)
  for (let frame = 0; frame < frames; frame += 1) {
    await locator.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())))
    await expect(locator).toContainText(text)
  }
}

async function expectNoHorizontalPageOverflow(page) {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true)
}

async function freezeTime(page, iso) {
  // GSAP's ticker reads Date.now; reduced motion keeps the app in its final
  // visual state while the business clock is frozen for deterministic data.
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

async function switchToTherapist(page) {
  await page.getByRole('button', { name: /Tryb demonstracyjny.*Anna Maria Janowska/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Justyna Jarosz-Jarszewska/ }).click()
}

async function switchToCoordinator(page) {
  await page.getByRole('button', { name: /Tryb demonstracyjny/ }).click()
  await page.getByRole('button', { name: /Koordynatorka.*Julia Wolanin/ }).click()
}

async function installNamedMotionCapture(page) {
  await page.evaluate(() => {
    window.__namedMotion = []
    const classify = (targets) => {
      const elements = window.gsap.utils.toArray(targets)
      const element = elements[0]
      if (!element?.matches) return { kind: null, count: elements.length }
      if (element.matches('.cal__day')) return { kind: 'calendar-grid', count: elements.length }
      if (element.matches('.agenda__row, .empty')) return { kind: 'calendar-agenda', count: elements.length }
      if (element.matches('.form-warn')) return { kind: 'session-conflict', count: elements.length }
      if (element.matches('.toast')) return { kind: 'toast', count: elements.length }
      if (element.matches('.donut-seg')) return { kind: 'chart-donut', count: elements.length }
      if (element.matches('.hbar__fill')) return { kind: 'chart-bar', count: elements.length }
      if (element.tagName.toLowerCase() === 'path' && element.closest('[aria-label^="Wykres przychodów"]')) {
        return { kind: element.getAttribute('fill') === 'none' ? 'chart-area-line' : 'chart-area-fill', count: elements.length }
      }
      return { kind: null, count: elements.length }
    }
    const pick = (vars = {}) => ({
      autoAlpha: vars.autoAlpha,
      opacity: vars.opacity,
      scaleX: vars.scaleX,
      strokeDashoffset: vars.strokeDashoffset,
      visibility: vars.visibility,
    })
    const total = (vars = {}, count = 1) => {
      const stagger = typeof vars.stagger === 'number'
        ? vars.stagger * Math.max(count - 1, 0)
        : Number(vars.stagger?.amount || 0)
      return Number(vars.duration || 0) + Number(vars.delay || 0) + stagger
    }
    const originalFromTo = window.gsap.fromTo.bind(window.gsap)
    const originalTo = window.gsap.to.bind(window.gsap)
    window.gsap.fromTo = (targets, fromVars, toVars) => {
      const { kind, count } = classify(targets)
      if (kind) window.__namedMotion.push({ kind, method: 'fromTo', from: pick(fromVars), to: pick(toVars), total: total(toVars, count) })
      return originalFromTo(targets, fromVars, toVars)
    }
    window.gsap.to = (targets, toVars) => {
      const { kind, count } = classify(targets)
      if (kind) window.__namedMotion.push({ kind, method: 'to', to: pick(toVars), total: total(toVars, count) })
      return originalTo(targets, toVars)
    }
  })
}

function expectVisibleFastMotion(records, requiredKinds) {
  const kinds = new Set(records.map((record) => record.kind))
  for (const kind of requiredKinds) expect(kinds.has(kind), kind).toBe(true)
  for (const record of records.filter(({ kind }) => requiredKinds.includes(kind))) {
    expect(record.total, `${record.kind} total`).toBeLessThanOrEqual(0.25)
    for (const vars of [record.from, record.to].filter(Boolean)) {
      expect(vars.autoAlpha, `${record.kind} autoAlpha`).not.toBe(0)
      expect(vars.opacity, `${record.kind} opacity`).not.toBe(0)
      expect(vars.visibility, `${record.kind} visibility`).not.toBe('hidden')
    }
    expect(record.from?.scaleX, `${record.kind} scaleX`).not.toBe(0)
    expect(Number(record.from?.strokeDashoffset || 0), `${record.kind} stroke draw`).toBeLessThanOrEqual(0)
  }
}

test('the mock-data workspace opens after login', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('region', { name: 'Pulpit dnia' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})

test('demo login and logout remount a clean workspace', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Klienci' }).click()
  await addClient(page, 'Reset Autorytetu')
  await expect(page.getByText('Reset Autorytetu', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Wyloguj się' }).click()
  await expect(page.getByLabel('Hasło')).toBeVisible()
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await page.getByRole('navigation', { name: 'Nawigacja główna' })
    .getByRole('link', { name: 'Klienci' }).click()
  await expect(page.getByText('Reset Autorytetu', { exact: true })).toHaveCount(0)
})

test('navigation focuses the destination and a day cockpit excludes background controls', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Kalendarz' }).click()
  await expect(page.locator('.view')).toBeFocused()
  await page.getByRole('button', { name: /Panel dnia/ }).click()
  await expect(page.getByRole('dialog', { name: /Panel dnia/ })).toBeVisible()
  await expect(page.getByRole('main')).toHaveAttribute('inert', '')
  await expect(page.locator('.skip-link')).toHaveAttribute('inert', '')
})

test('skip link reveals on focus and moves focus to the main landmark', async ({ page }) => {
  await login(page)
  const skipLink = page.getByRole('link', { name: 'Przejdź do treści' })

  await skipLink.focus()
  await expect(skipLink).toBeFocused()
  expect((await skipLink.boundingBox()).y).toBeGreaterThanOrEqual(0)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
})

test('phone shell balances direct destinations around one full Menu entry point', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)

  const topbar = page.locator('.topbar')
  await expect(topbar.getByRole('button', { name: 'Otwórz menu' })).toHaveCount(0)
  await expect(topbar.getByText('Dziś', { exact: true })).toBeVisible()
  await expect(topbar.getByRole('button', { name: /Szukaj w panelu/ })).toBeVisible()

  const bottomNavigation = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  expect(await bottomNavigation.getByRole('link').allTextContents()).toEqual(['Dziś', 'Kalendarz', 'TUS'])
  await expect(bottomNavigation.getByRole('button', { name: 'Menu', exact: true })).toBeVisible()
  await expect(bottomNavigation.getByRole('button', { name: 'Nowa sesja' })).toBeVisible()
  const controls = await Promise.all([
    bottomNavigation.getByRole('link', { name: 'Dziś', exact: true }).boundingBox(),
    bottomNavigation.getByRole('link', { name: 'Kalendarz', exact: true }).boundingBox(),
    bottomNavigation.getByRole('button', { name: 'Nowa sesja' }).boundingBox(),
    bottomNavigation.getByRole('link', { name: 'TUS', exact: true }).boundingBox(),
    bottomNavigation.getByRole('button', { name: 'Menu', exact: true }).boundingBox(),
  ])
  expect(controls.every(Boolean)).toBe(true)
  expect(controls.map((box) => box.x)).toEqual([...controls.map((box) => box.x)].sort((a, b) => a - b))
  const fab = controls[2]
  expect(Math.abs(fab.x + fab.width / 2 - 195)).toBeLessThanOrEqual(1)

  await bottomNavigation.getByRole('button', { name: 'Menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  const drawerNavigation = drawer.getByRole('navigation', { name: 'Nawigacja główna' })
  expect(await drawerNavigation.getByRole('link').allTextContents())
    .toEqual(['Klienci', 'Zespół', 'Finanse', 'Raporty', 'Ustawienia'])
  for (const duplicate of ['Dziś', 'Kalendarz', 'Zajęcia TUS']) {
    await expect(drawer.getByRole('link', { name: duplicate, exact: true })).toHaveCount(0)
  }
  await expect(drawer.locator('.today-card')).toHaveCount(0)
  await expect(drawer.locator('.mobile-account__identity')).toContainText('Anna Maria Janowska')
  await expect(drawer.locator('.mobile-account__identity')).toContainText('Główna psycholożka')
  await expect(drawer.getByRole('group', { name: 'Tryb demonstracyjny' })).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Wyloguj się' })).toBeVisible()
})

test('tablet shell keeps its topbar opener and complete navigation drawer', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await login(page)

  await expect(page.getByRole('navigation', { name: 'Nawigacja dolna' })).toBeHidden()
  await page.locator('.topbar').getByRole('button', { name: 'Otwórz menu' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  for (const label of ['Dziś', 'Kalendarz', 'Zajęcia TUS']) {
    await expect(drawer.getByRole('link', { name: label, exact: true })).toBeVisible()
  }
  await expect(drawer.locator('.today-card')).toBeVisible()
})

test('mobile navigation drawer keeps role switching and logout reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  const menu = page.getByRole('navigation', { name: 'Nawigacja dolna' }).getByRole('button', { name: 'Menu' })

  await menu.click()
  let drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  const roles = drawer.getByRole('group', { name: 'Tryb demonstracyjny' })
  await expect(roles.getByRole('button', { name: /Koordynatorka.*Julia Wolanin/ })).toBeVisible()
  await roles.getByRole('button', { name: /Koordynatorka.*Julia Wolanin/ }).click()

  await menu.click()
  drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  await expect(drawer.getByRole('button', { name: 'Wyloguj się' })).toBeVisible()
  await drawer.getByRole('button', { name: 'Wyloguj się' }).click()
  await expect(page.getByRole('button', { name: 'Zaloguj się' })).toBeVisible()
})

test('mobile TUS shortcut and active pill survive a role change', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  const bottomNavigation = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  const tus = bottomNavigation.getByRole('link', { name: 'TUS', exact: true })

  await tus.click()
  await expect(page.locator('.topbar__title b')).toHaveText('Zajęcia TUS')
  await bottomNavigation.getByRole('button', { name: 'Menu' }).click()
  const roleButton = page.getByRole('dialog', { name: 'Nawigacja' })
    .getByRole('button', { name: /Specjalistka.*Justyna Jarosz-Jarszewska/ })
  await expect(roleButton).toBeVisible()
  await roleButton.click()

  await bottomNavigation.getByRole('button', { name: 'Menu' }).click()
  const therapistDrawer = page.getByRole('dialog', { name: 'Nawigacja' })
  for (const restricted of ['Finanse', 'Raporty', 'Zespół']) {
    await expect(therapistDrawer.getByRole('link', { name: restricted, exact: true })).toHaveCount(0)
  }
  await page.keyboard.press('Escape')

  await expect.poll(async () => {
    const tusBox = await tus.boundingBox()
    const pill = await bottomNavigation.locator('.tabbar__pill').boundingBox()
    return Math.abs((tusBox.x + tusBox.width / 2) - (pill.x + pill.width / 2))
  }).toBeLessThanOrEqual(1)
})

test('Figure exposes its formatted value on the first rendered frame', async ({ page }) => {
  await login(page)
  await page.evaluate(() => {
    window.__initialFigureTexts = []
    const capture = (root) => {
      const values = root.matches?.('.figures__value > span')
        ? [root]
        : [...(root.querySelectorAll?.('.figures__value > span') || [])]
      values.forEach((value) => window.__initialFigureTexts.push(value.textContent))
    }
    window.__figureObserver = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) capture(node)
      }))
    })
    window.__figureObserver.observe(document.body, { childList: true, subtree: true })
  })

  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Finanse' }).click()
  const firstFigure = page.locator('.figures__value > span').first()
  await expect(firstFigure).toBeVisible()
  await page.waitForTimeout(1800)
  const initialText = await page.waitForFunction(() => window.__initialFigureTexts[0]).then((handle) => handle.jsonValue())

  expect(initialText).toBe(await firstFigure.textContent())
})

test('navigation restores each route scroll position', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  const content = page.locator('main.content')

  await navigation.getByRole('link', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('region', { name: /Plan dnia/ })).toBeVisible()
  const savedScroll = await content.evaluate((element) => {
    element.scrollTop = 300
    return element.scrollTop
  })
  expect(savedScroll).toBeGreaterThan(50)

  await navigation.getByRole('link', { name: 'Klienci' }).click()
  await expect(page.getByRole('heading', { name: /Klienci/ })).toBeVisible()
  await navigation.getByRole('link', { name: 'Kalendarz' }).click()
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(savedScroll)
})

test('therapist demo mode keeps canonical labels while narrowing navigation', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await expect(navigation).toContainText('Dziś')
  await expect(navigation).toContainText('Kalendarz')
  await expect(navigation).toContainText('Klienci')
  await expect(navigation).not.toContainText('Mój dzień')
  await expect(navigation).not.toContainText('Finanse')
  await expect(navigation).not.toContainText('Raporty')
})

test('command navigation uses canonical destination labels', async ({ page }) => {
  await login(page)
  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  await palette.getByRole('combobox', { name: 'Szukaj w panelu' }).fill('kalendarz')

  await expect(palette.getByRole('option', { name: 'Kalendarz', exact: true })).toBeVisible()
  await expect(palette.getByText('Kalendarz sesji', { exact: true })).toHaveCount(0)
})

test('role switch cannot finish a pending forbidden navigation', async ({ page }) => {
  await login(page)
  await page.evaluate(async () => {
    const navigation = document.querySelector('nav[aria-label="Nawigacja główna"]')
    ;[...navigation.querySelectorAll('a')].find((item) => item.textContent.trim() === 'Finanse').click()
    ;[...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Tryb demonstracyjny') && button.textContent.includes('Anna Maria Janowska'))
      .click()
    await new Promise(requestAnimationFrame)
    ;[...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Specjalistka') && button.textContent.includes('Justyna Jarosz-Jarszewska'))
      .click()
  })

  await page.waitForTimeout(300)
  await expect(page.locator('.topbar__title b')).toHaveText('Dziś')
  await expect(
    page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Dziś' })
  ).toHaveAttribute('aria-current', 'page')
})

test('same-route view state does not leak when the demo role changes', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Klienci' }).click()
  const search = page.getByPlaceholder('Imię, e-mail lub telefon')
  await search.fill('Zofia')
  await expect(search).toHaveValue('Zofia')

  await switchToTherapist(page)

  await expect(page.getByPlaceholder('Imię, e-mail lub telefon')).toHaveValue('')
  await expect(page.getByRole('heading', { name: /Moi klienci/ })).toBeVisible()
})

test('role switch discards a client detail identity outside the next role scope', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  await expect(page.getByRole('heading', { name: 'Zofia Mazur' })).toBeVisible()

  await switchToTherapist(page)

  await expect(page.locator('.topbar__title b')).toHaveText('Klienci')
  await expect(page.getByRole('heading', { name: 'Zofia Mazur' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /Moi klienci/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Zofia Mazur/ })).toHaveCount(0)
})

test('role switch clears top-level route parameters and their derived filters', async ({ page }) => {
  await login(page)
  await page.getByRole('group', { name: 'Podsumowanie dnia' }).getByRole('button', { name: /Zaległe/ }).click()
  await expect(page.getByRole('region', { name: 'Zakres finansów' })).toContainText('Wszystkie okresy')
  await expect(page.getByRole('region', { name: 'Filtry listy rozliczeń' })).toContainText('Pozostałe do zapłaty')

  await switchToCoordinator(page)

  await expect(page.locator('.topbar__title b')).toHaveText('Finanse')
  await expect(page.getByRole('region', { name: 'Zakres finansów' })).not.toContainText('Zakres: Wszystkie okresy')
  await expect(page.getByRole('button', { name: 'Wszystkie płatności' })).toHaveAttribute('aria-pressed', 'true')
})

test('coarse pointers expose complete 44px targets without enlarging pills', async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()

  try {
    await login(page)
    const todayChip = page.locator('.today-chip')
    const todayChipHit = await todayChip.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const pseudo = getComputedStyle(element, '::after')
      return { height: rect.height, hitHeight: parseFloat(pseudo.height) }
    })
    expect(todayChipHit.height).toBe(36)
    expect(todayChipHit.hitHeight).toBeGreaterThanOrEqual(44)

    for (const selector of ['.spine__row', '.today-links__item']) {
      const target = page.locator(selector).first()
      await expect(target).toBeVisible()
      const box = await target.boundingBox()
      expect(box.height, selector).toBeGreaterThanOrEqual(44)
      expect(box.width, selector).toBeGreaterThanOrEqual(44)
    }

    await openPhoneDestination(page, 'Klienci')
    await page.getByRole('button', { name: /^Filtry/ }).click()
    const chip = page.getByRole('region', { name: 'Filtry klientów' }).locator('.chip').first()
    await expect(chip).toBeVisible()
    await chip.scrollIntoViewIfNeeded()
    const chipHit = await chip.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const ownsPoint = (y) => {
        const hit = document.elementFromPoint(rect.left + rect.width / 2, y)
        return hit === element || element.contains(hit)
      }
      const pseudo = getComputedStyle(element, '::after')
      return {
        height: rect.height,
        hitHeight: parseFloat(pseudo.height),
        top: ownsPoint(rect.top - 4.5),
        bottom: ownsPoint(rect.bottom + 4.5),
      }
    })
    expect(chipHit.height).toBe(34)
    expect(chipHit.hitHeight).toBeGreaterThanOrEqual(44)
    expect(chipHit.top).toBe(true)
    expect(chipHit.bottom).toBe(true)

    await openPhoneDestination(page, 'Ustawienia')
    const smallPrimary = page.getByRole('button', { name: 'Zapisz konto' })
    await smallPrimary.scrollIntoViewIfNeeded()
    const buttonHit = await smallPrimary.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const ownsPoint = (y) => {
        const hit = document.elementFromPoint(rect.left + rect.width / 2, y)
        return hit === element || element.contains(hit)
      }
      return { height: rect.height, top: ownsPoint(rect.top - 4), bottom: ownsPoint(rect.bottom + 4) }
    })
    expect(buttonHit.height).toBe(34)
    expect(buttonHit.top).toBe(true)
    expect(buttonHit.bottom).toBe(true)

    const toggle = page.locator('.toggle').first()
    const toggleHit = await toggle.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const pseudo = getComputedStyle(element, '::before')
      return { height: rect.height, hitHeight: parseFloat(pseudo.height) }
    })
    expect(toggleHit.height).toBe(27)
    expect(toggleHit.hitHeight).toBeGreaterThanOrEqual(44)

    await page.setViewportSize({ width: 800, height: 844 })
    const searchTrigger = page.locator('.cmd-trigger')
    await expect(searchTrigger).toBeVisible()
    const searchBox = await searchTrigger.boundingBox()
    expect(searchBox.height).toBeGreaterThanOrEqual(44)
  } finally {
    await context.close()
  }
})

test('shell and reveal motion finishes within 250ms', async ({ page }) => {
  await page.goto('.')
  await page.evaluate(() => {
    window.__task2Motion = []
    const original = window.gsap.fromTo.bind(window.gsap)
    window.gsap.fromTo = (targets, fromVars, toVars) => {
      const elements = window.gsap.utils.toArray(targets)
      const kind = elements.some((element) => element.matches?.('[data-shell-reveal]'))
        ? 'shell'
        : elements.some((element) => element.matches?.('[data-reveal]')) ? 'reveal' : null
      if (kind) {
        const stagger = typeof toVars.stagger === 'number'
          ? toVars.stagger * Math.max(elements.length - 1, 0)
          : Number(toVars.stagger?.amount || 0)
        window.__task2Motion.push({ kind, total: Number(toVars.duration || 0) + stagger })
      }
      return original(targets, fromVars, toVars)
    }
  })
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await expect(page.getByRole('main')).toBeVisible()

  const motion = await page.evaluate(() => window.__task2Motion)
  expect(motion.length).toBeGreaterThan(0)
  expect(Math.max(...motion.map((entry) => entry.total))).toBeLessThanOrEqual(0.25)

  const navIconDuration = await page.locator('.nav__item svg').first().evaluate((element) => (
    Math.max(...getComputedStyle(element).transitionDuration.split(',').map((value) => parseFloat(value)))
  ))
  expect(navIconDuration).toBeLessThanOrEqual(0.25)

  await page.setViewportSize({ width: 390, height: 844 })
  const tabMotion = await page.locator('.tabbar').evaluate((element) => {
    const duration = (selector) => Math.max(
      ...getComputedStyle(element.querySelector(selector)).transitionDuration
        .split(',')
        .map((value) => parseFloat(value))
    )
    return { icon: duration('.tabbar__item svg'), pill: duration('.tabbar__pill') }
  })
  expect(tabMotion.icon).toBeLessThanOrEqual(0.25)
  expect(tabMotion.pill).toBeLessThanOrEqual(0.25)
})

test('navigation commits its destination before the next paint', async ({ page }) => {
  await login(page)

  const titleAfterNextPaint = await page.evaluate(async () => {
    const navigation = document.querySelector('nav[aria-label="Nawigacja główna"]')
    ;[...navigation.querySelectorAll('a')].find((item) => item.textContent.trim() === 'Kalendarz').click()
    await new Promise(requestAnimationFrame)
    return document.querySelector('.topbar__title b').textContent
  })

  expect(titleAfterNextPaint).toBe('Kalendarz')
})

test('operational overlays never fade in and finish motion within 250ms', async ({ page }) => {
  await login(page)
  await page.evaluate(() => {
    window.__operationalMotion = []
    const classify = (targets) => {
      const element = window.gsap.utils.toArray(targets)[0]
      if (!element?.matches) return null
      if (element.matches('.cmd')) return 'command'
      if (element.matches('.cmd-back')) return 'command-backdrop'
      if (element.matches('.popover')) return 'popover'
      if (element.matches('.cockpit--pop')) return 'cockpit-desktop'
      if (element.matches('.cockpit--sheet')) return 'cockpit-phone'
      if (element.matches('.cockpit-back')) return 'cockpit-backdrop'
      return null
    }
    const pick = (vars = {}) => ({
      autoAlpha: vars.autoAlpha,
      delay: Number(vars.delay || 0),
      duration: Number(vars.duration || 0),
      opacity: vars.opacity,
      visibility: vars.visibility,
      y: vars.y,
    })
    const originalFromTo = window.gsap.fromTo.bind(window.gsap)
    const originalTo = window.gsap.to.bind(window.gsap)
    window.gsap.fromTo = (targets, fromVars, toVars) => {
      const kind = classify(targets)
      if (kind) window.__operationalMotion.push({ kind, method: 'fromTo', from: pick(fromVars), to: pick(toVars) })
      return originalFromTo(targets, fromVars, toVars)
    }
    window.gsap.to = (targets, toVars) => {
      const kind = classify(targets)
      if (kind) window.__operationalMotion.push({ kind, method: 'to', to: pick(toVars) })
      return originalTo(targets, toVars)
    }
  })

  await page.getByRole('button', { name: /Szukaj/ }).click()
  await expect(page.getByRole('dialog', { name: 'Szukaj w panelu' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Szukaj w panelu' })).toHaveCount(0)

  await page.getByRole('button', { name: /Tryb demonstracyjny.*Anna Maria Janowska/ }).click()
  await expect(page.getByRole('group', { name: 'Tryb demonstracyjny' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('group', { name: 'Tryb demonstracyjny' })).toHaveCount(0)

  await page.getByRole('button', { name: /Panel dnia/ }).click()
  await expect(page.getByRole('dialog', { name: 'Panel dnia' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Panel dnia' })).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('navigation', { name: 'Nawigacja dolna' })).toBeVisible()
  await page.getByRole('button', { name: /Panel dnia/ }).click()
  await expect(page.getByRole('dialog', { name: 'Panel dnia' }).locator('.cockpit--sheet')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Panel dnia' })).toHaveCount(0)

  const records = await page.evaluate(() => window.__operationalMotion)
  const kinds = new Set(records.map((record) => record.kind))
  for (const kind of ['cockpit-desktop', 'cockpit-phone', 'command', 'popover']) {
    expect(kinds.has(kind), kind).toBe(true)
  }
  for (const record of records) {
    expect(record.to.duration + record.to.delay, `${record.kind} ${record.method}`).toBeLessThanOrEqual(0.25)
    if (record.method !== 'fromTo') continue
    expect(record.from.autoAlpha, `${record.kind} autoAlpha`).not.toBe(0)
    expect(record.from.opacity, `${record.kind} opacity`).not.toBe(0)
    expect(record.from.visibility, `${record.kind} visibility`).not.toBe('hidden')
    if (record.kind === 'cockpit-phone') expect(String(record.from.y)).not.toContain('%')
  }
})

test('segmented, switch, and interactive control CSS transitions stay within 250ms', async ({ page }) => {
  await page.goto('.')
  const durations = await page.evaluate(() => {
    const fixture = document.createElement('div')
    fixture.innerHTML = `
      <button class="btn btn--primary"><span>Akcja</span></button>
      <button class="card card--lift">Karta</button>
      <div class="seg"><span class="seg__thumb"></span></div>
      <button class="toggle"></button>
      <div class="search"><input /></div>
      <button class="psy-card">Profil</button>
    `
    document.body.append(fixture)
    const maxDuration = (selector, pseudo) => Math.max(
      ...getComputedStyle(fixture.querySelector(selector), pseudo).transitionDuration
        .split(',')
        .map((value) => value.endsWith('ms') ? parseFloat(value) / 1000 : parseFloat(value))
    )
    const result = {
      button: maxDuration('.btn--primary', '::before'),
      card: maxDuration('.card--lift'),
      search: maxDuration('.search input'),
      segmented: maxDuration('.seg__thumb'),
      specialistCard: maxDuration('.psy-card'),
      switchTrack: maxDuration('.toggle'),
      switchThumb: maxDuration('.toggle', '::after'),
    }
    fixture.remove()
    return result
  })

  for (const [control, duration] of Object.entries(durations)) {
    expect(duration, control).toBeLessThanOrEqual(0.25)
  }
})

test('calendar operational swaps stay visible and finish within 250ms including stagger', async ({ page }) => {
  await login(page)
  await installNamedMotionCapture(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Kalendarz' }).click()

  await page.locator('.day-strip__day:not(.is-on)').first().click()
  await expect.poll(() => page.evaluate(() => window.__namedMotion.some(({ kind }) => kind === 'calendar-agenda'))).toBe(true)
  await page.getByRole('radio', { name: 'Miesiąc' }).click()
  await expect.poll(() => page.evaluate(() => window.__namedMotion.some(({ kind }) => kind === 'calendar-grid'))).toBe(true)

  const records = await page.evaluate(() => window.__namedMotion)
  expectVisibleFastMotion(records, ['calendar-agenda', 'calendar-grid'])
})

test('session conflict warning is visible immediately and finishes motion within 250ms', async ({ page }) => {
  await login(page)
  await installNamedMotionCapture(page)
  await page.getByRole('button', { name: 'Nowa sesja' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await drawer.getByLabel('Klient').selectOption({ label: 'Zofia Mazur' })
  await drawer.getByLabel('Godzina').fill('08:10')
  await expect(drawer.getByRole('status')).toBeVisible()

  const records = await page.evaluate(() => window.__namedMotion)
  expectVisibleFastMotion(records, ['session-conflict'])
})

test('toast messages use visible transform-only enter and exit motion within 250ms', async ({ page }) => {
  await login(page)
  await installNamedMotionCapture(page)
  await page.getByRole('region', { name: 'Skróty' }).getByRole('button', { name: 'Tablica zespołu' }).click()
  const board = page.getByRole('dialog', { name: 'Tablica zespołu' })
  await board.getByLabel('Nowy wpis na tablicy').fill('Wpis do testu globalnego ruchu')
  await board.getByRole('button', { name: 'Opublikuj' }).click()
  const toast = page.getByRole('button', { name: /Zamknij: Wpis dodany na tablicę/ })
  await expect(toast).toBeVisible()
  await toast.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.__namedMotion.filter(({ kind }) => kind === 'toast').length)).toBe(2)

  const records = await page.evaluate(() => window.__namedMotion)
  expect(records.filter(({ kind }) => kind === 'toast').map(({ method }) => method)).toEqual(['fromTo', 'to'])
  expectVisibleFastMotion(records, ['toast'])
  await expect(toast).toHaveCount(0)
})

test('Today cockpit progress transition finishes within 250ms', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /Panel dnia/ }).click()
  const progress = page.getByRole('dialog', { name: 'Panel dnia' }).locator('.cockpit__progress span')
  await expect(progress).toBeVisible()
  const duration = await progress.evaluate((element) => Math.max(
    ...getComputedStyle(element).transitionDuration.split(',').map((value) => (
      value.endsWith('ms') ? parseFloat(value) / 1000 : parseFloat(value)
    ))
  ))
  expect(duration).toBeLessThanOrEqual(0.25)
})

test('chart data stays visible while decorative motion finishes within 250ms', async ({ page }) => {
  await login(page)
  await installNamedMotionCapture(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Zespół' }).click()
  await page.getByRole('link', { name: /Otwórz profil —/ }).first().click()
  await expect.poll(() => page.evaluate(() => window.__namedMotion.some(({ kind }) => kind === 'chart-area-line'))).toBe(true)

  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Raporty' }).click()
  await expect.poll(() => page.evaluate(() => (
    ['chart-area-fill', 'chart-bar', 'chart-donut'].every((kind) => window.__namedMotion.some((record) => record.kind === kind))
  ))).toBe(true)

  const records = await page.evaluate(() => window.__namedMotion)
  expectVisibleFastMotion(records, ['chart-area-fill', 'chart-area-line', 'chart-bar', 'chart-donut'])
})

test('therapist session form is scoped to their own practice', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('button', { name: 'Nowa sesja' }).first().click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  const clients = drawer.getByLabel('Klient')
  const psychologists = drawer.getByLabel('Specjalistka')

  await expect(clients).toContainText('Gabriel Madej')
  await expect(clients).not.toContainText('Zofia Mazur')
  await expect(psychologists.locator('option')).toHaveCount(2)
  await expect(psychologists).toHaveValue('p2')
})

test('therapist client form cannot reassign care outside their practice', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('button', { name: 'Dodaj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  const psychologists = drawer.getByLabel('Specjalistka prowadząca')

  await expect(psychologists.locator('option')).toHaveCount(2)
  await expect(psychologists).toHaveValue('p2')
  await expect(drawer.getByLabel('Powiąż z klientem')).not.toContainText('Zofia Mazur')
})

test('demo role picker is a labelled button group and closes for command search', async ({ page }) => {
  await login(page)
  const picker = page.getByRole('button', { name: /Tryb demonstracyjny.*Anna Maria Janowska/ })
  await expect(picker).toContainText('Tryb demonstracyjny')
  await picker.click()
  const group = page.getByRole('group', { name: 'Tryb demonstracyjny' })
  await expect(group).toContainText('Tryb demonstracyjny')
  await expect(group.getByRole('button', { name: /Główna psycholożka.*Anna Maria Janowska/ })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Control+K')
  await expect(page.getByRole('dialog', { name: 'Szukaj w panelu' })).toBeVisible()
  await expect(group).toHaveCount(0)
})

test('therapist mode guards dashboard destinations and filters command palette', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await expect(page.getByRole('region', { name: 'Skróty' }).getByRole('link', { name: 'Zespół' })).toHaveCount(0)
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Dziś' })).toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  const search = palette.getByRole('combobox', { name: 'Szukaj w panelu' })
  await search.fill('raport')
  await expect(palette).not.toContainText('Raport miesięczny')
  await search.fill('julia')
  await expect(palette).not.toContainText('dr Anna Maria Janowska')
})

test('therapist search only exposes their client context and hides note prose from other roles', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('button', { name: /Szukaj/ }).click()
  await page.getByRole('combobox', { name: /Szukaj w panelu/ }).fill('Madej')
  await page.getByRole('option', { name: /Gabriel Madej/ }).click()
  await expect(page.getByRole('heading', { name: /Gabriel Madej/ })).toBeVisible()
  await expect(page.getByText(/Notatki kliniczne/)).toBeVisible()
  await expect(page.getByLabel('Nowa notatka')).toBeVisible()
})

test('centre roles receive a neutral clinical-notes state', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  await expect(page.getByText('Notatki są dostępne w widoku specjalistki.')).toBeVisible()
  await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
})

test('coordinator receives the neutral clinical-notes state', async ({ page }) => {
  await login(page)
  await switchToCoordinator(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  await expect(page.getByText('Notatki są dostępne w widoku specjalistki.')).toBeVisible()
  await expect(page.locator('.note__text')).toHaveCount(0)
  await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
})

test('non-owning therapist is remapped away from an unauthorized client detail', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  await switchToTherapist(page)
  await expect(page.locator('.topbar__title b')).toHaveText('Klienci')
  await expect(page.getByRole('heading', { name: /Moi klienci/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Zofia Mazur/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Zofia Mazur' })).toHaveCount(0)
  await expect(page.locator('.note__text')).toHaveCount(0)
  await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
  await expect(page.locator('.id-band__actions').getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Edytuj sesję/ })).toHaveCount(0)
  await expect(page.getByTitle('Zmień status sesji')).toHaveCount(0)
  await expect(page.getByTitle('Zmień płatność')).toHaveCount(0)
})

test('client detail adapts its primary CTA to the active role', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  await expect(page.getByRole('button', { name: 'Umów spotkanie' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Przygotuj sesję' })).toHaveCount(0)

  await switchToTherapist(page)
  await page.getByRole('link', { name: 'Otwórz kartę — Gabriel Madej' }).click()
  await expect(page.getByRole('button', { name: 'Przygotuj sesję' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Umów spotkanie' })).toHaveCount(0)
})

test('client detail presents care sections in record order, h1 first', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  // "Przegląd opieki" is the first section heading — the client name (h1)
  // must still precede every section heading in the outline
  await expect(page.locator('#care-overview-title')).toHaveText('Przegląd opieki')
  const headings = await page.locator('main h2').evaluateAll((elements) =>
    elements.map((element) => element.firstChild.textContent.trim())
  )
  expect(headings).toEqual([
    'Przegląd opieki',
    'Najbliższe spotkania',
    'Historia frekwencji',
    'Notatki kliniczne',
  ])
  const h1Precedes = await page.evaluate(() => {
    const h1 = document.querySelector('main h1')
    const firstH2 = document.querySelector('main h2')
    return Boolean(h1.compareDocumentPosition(firstH2) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(h1Precedes).toBe(true)
})

test('client form validates a supplied email and keeps email optional', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('button', { name: 'Dodaj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  await drawer.getByLabel('Imię i nazwisko').fill('Testowa osoba')
  await drawer.getByLabel('Specjalistka prowadząca').selectOption('p1')
  await drawer.getByLabel('E-mail').fill('niepoprawny-adres')
  await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(drawer.getByText('Podaj poprawny adres e-mail')).toBeVisible()
  await drawer.getByLabel('E-mail').fill('')
  await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  await expect(drawer).toHaveCount(0)
})

test('switching to therapist ignores a previous team client filter', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  await page.getByRole('button', { name: 'Anna', exact: true }).click()
  await expect(page.getByRole('row', { name: /Zofia Mazur/ })).toBeVisible()
  await switchToTherapist(page)
  await expect(page.getByRole('row', { name: /Gabriel Madej/ })).toBeVisible()
})

test('short lists render fully without a pager and history caps at ten rows', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  // 19 demo clients < 25: full roster, no pager anywhere on the view
  await expect(page.locator('tbody tr').first()).toBeVisible()
  expect(await page.locator('tbody tr').count()).toBeGreaterThan(15)
  await expect(page.getByRole('navigation', { name: 'Stronicowanie' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  await expect(page.getByRole('heading', { name: 'Historia frekwencji' })).toBeVisible()
  const historyRows = await page.locator('.client-record__section:has(h2:text("Historia frekwencji")) tbody tr').count()
  expect(historyRows).toBeLessThanOrEqual(10)
})

test('Today keeps the essential daily regions together', async ({ page }) => {
  await login(page)
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Poniedziałek|Wtorek|Środa|Czwartek|Piątek|Sobota|Niedziela), \d{1,2} \S+ \d{4}$/ })
  ).toBeVisible()
  await expect(page.locator('.today-hero')).toContainText(
    /\d{1,2}:\d{2}|\d+ sesji wymaga statusu|Dzień zakończony|Wolny dzień/
  )
  await expect(page.getByRole('group', { name: 'Podsumowanie dnia' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Skróty' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Plan dnia' })).toBeVisible()
})

test('Today is a compact viewport command centre without secondary reports', async ({ page }) => {
  await login(page)
  const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })

  await expect(dashboard).toBeVisible()
  await expect(dashboard.getByRole('region', { name: 'Dzień w skrócie' })).toHaveCount(0)
  await expect(dashboard.getByRole('region', { name: 'Skróty' })).toBeVisible()
  await expect(dashboard).not.toContainText('Przychód miesięczny')
  await expect(dashboard).not.toContainText('Najbliższe sesje')
  await expect(dashboard).not.toContainText('Zespół dziś')

  const contentOverflows = await page.locator('main.content').evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1
  )
  expect(contentOverflows).toBe(false)
})

test('Today keeps the page itself fixed on a short desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await login(page)

  const contentOverflows = await page.locator('main.content').evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1
  )
  expect(contentOverflows).toBe(false)
})

test('Today keeps the hero legible without horizontal overflow on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await login(page)

  await expect(page.locator('.today-hero').getByRole('heading', { level: 1 })).toBeVisible()
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  )
  expect(overflows).toBe(false)
})

test('team board is a Shell overlay that yields to global overlays', async ({ page }) => {
  await login(page)
  await page.getByRole('region', { name: 'Skróty' }).getByRole('button', { name: 'Tablica zespołu' }).click()
  const board = page.getByRole('dialog', { name: 'Tablica zespołu' })
  await expect(board).toBeVisible()
  const composer = board.getByLabel('Nowy wpis na tablicy')
  await composer.fill('Pierwszy wpis testowy')
  await board.getByRole('button', { name: 'Opublikuj' }).click()
  await composer.fill('Drugi wpis testowy')
  await board.getByRole('button', { name: 'Opublikuj' }).click()
  await expect(page.getByRole('main')).toHaveAttribute('inert', '')

  await page.keyboard.press('Control+K')
  await expect(board).toHaveCount(0)
  const palette = page.getByRole('dialog', { name: 'Szukaj w panelu' })
  await expect(palette).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await page.getByRole('button', { name: /Panel dnia/ }).click()
  await expect(page.getByRole('dialog', { name: 'Panel dnia' })).toBeVisible()
  await expect(board).toHaveCount(0)
})

test('toasts dismiss with the keyboard', async ({ page }) => {
  await login(page)
  await page.getByRole('region', { name: 'Skróty' }).getByRole('button', { name: 'Tablica zespołu' }).click()
  const board = page.getByRole('dialog', { name: 'Tablica zespołu' })
  const composer = board.getByLabel('Nowy wpis na tablicy')
  await composer.fill('Wpis do testu powiadomienia')
  await board.getByRole('button', { name: 'Opublikuj' }).click()
  const toast = page.getByRole('button', { name: /Zamknij: Wpis dodany na tablicę/ })
  await expect(toast).toBeVisible()
  await toast.focus()
  await page.keyboard.press('Enter')
  await expect(toast).toHaveCount(0)
})

test('enabling reduced motion clears active GSAP tweens', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Ustawienia' }).click()
  await page.evaluate(() => {
    window.__motionProbe = { value: 0 }
    window.gsap.to(window.__motionProbe, { value: 100, duration: 5 })
  })
  await page.getByRole('switch', { name: 'Ogranicz animacje' }).click()
  await expect.poll(() => page.evaluate(() => window.gsap.globalTimeline.getChildren().length)).toBe(0)
})

test('Today limits daily information to the active therapist', async ({ page }) => {
  await login(page)

  await switchToTherapist(page)
  await expect(page.getByRole('region', { name: 'Plan dnia' })).not.toContainText('Anna Maria Janowska')
  // arrears stay visible but stop being a link — therapists have no Payments route
  const arrears = page.getByRole('group', { name: 'Podsumowanie dnia' }).getByText('Zaległe')
  await expect(arrears).toBeVisible()
  await expect(page.locator('button.figures__item')).toHaveCount(0)
  await expect(page.getByText('Stan praktyki')).toHaveCount(0)
})

test('therapist Today omits all-team board posts and controls', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)

  await expect(page.getByText('Tablica zespołu', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Nowy wpis na tablicy')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Usuń wpis' })).toHaveCount(0)
  await expect(page.getByText(/Superwizja zespołowa/)).toHaveCount(0)
})

test('therapist cockpit excludes centre day and finance context', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('button', { name: /Panel dnia/ }).click()
  const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  await expect(cockpit).toBeVisible()
  await expect(cockpit).not.toContainText('Anna Maria Janowska')
  await expect(cockpit).not.toContainText('Zofia Mazur')
  await expect(cockpit).not.toContainText('Zaległe płatności')
  await expect(cockpit.locator('.cockpit__due')).toHaveCount(0)
})

test('therapist sidebar count is scoped to their daily sessions', async ({ page }) => {
  await login(page)
  const count = page.locator('.sidebar .today-card__line')
  await expect(count).toHaveText(/sesj[ei] w grafiku|Spokojny dzień/)
  const ownerCount = await count.textContent()
  expect(ownerCount).toMatch(/sesj[ei] w grafiku|Spokojny dzień/)
  await switchToTherapist(page)
  await expect(count).toHaveText(/sesj[ei] w grafiku|Spokojny dzień/)
  await expect(count).not.toHaveText(ownerCount)
})

test('older attention debt opens all-period unpaid payments', async ({ page }) => {
  await login(page)
  await page.getByRole('group', { name: 'Podsumowanie dnia' }).getByRole('button', { name: /Zaległe/ }).click()
  await expect(page.getByRole('region', { name: 'Zakres finansów' })).toContainText('Wszystkie okresy')
  await expect(page.getByRole('region', { name: 'Filtry listy rozliczeń' }).getByRole('button', { name: 'Pozostałe do zapłaty' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('tr.is-due')).not.toHaveCount(0)
})

test('calendar exposes explicit payment and attendance reset choices', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('group', { name: 'Płatność' })).toHaveCount(0)
  await page.getByRole('button', { name: /^Filtry/ }).click()
  const payment = page.getByRole('group', { name: 'Płatność' })
  const attendance = page.getByRole('group', { name: 'Obecność klienta' })
  const allPayments = payment.getByRole('button', { name: 'Wszystkie' })
  const allAttendance = attendance.getByRole('button', { name: 'Wszystkie' })

  await expect(allPayments).toHaveAttribute('aria-pressed', 'true')
  await payment.getByRole('button', { name: 'Nieopłacona' }).click()
  await expect(allPayments).toHaveAttribute('aria-pressed', 'false')
  await allPayments.click()
  await expect(allPayments).toHaveAttribute('aria-pressed', 'true')

  await expect(allAttendance).toHaveAttribute('aria-pressed', 'true')
  await attendance.getByRole('button', { name: 'Nieobecność' }).click()
  await expect(allAttendance).toHaveAttribute('aria-pressed', 'false')
  await allAttendance.click()
  await expect(allAttendance).toHaveAttribute('aria-pressed', 'true')
})

test('Payments exposes an all-status control to reverse ledger-only filtering', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Finanse' }).click()
  const allStatuses = page.getByRole('button', { name: 'Wszystkie płatności' })
  const unpaid = page.getByRole('button', { name: 'Pozostałe do zapłaty' })

  await expect(allStatuses).toHaveAttribute('aria-pressed', 'true')
  await unpaid.click()
  await expect(unpaid).toHaveAttribute('aria-pressed', 'true')
  await allStatuses.click()
  await expect(allStatuses).toHaveAttribute('aria-pressed', 'true')
  await expect(unpaid).toHaveAttribute('aria-pressed', 'false')
})

test('payments table paginates a month with more than 25 settlements', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Finanse' }).click()
  await page.getByRole('button', { name: 'Poprzedni miesiąc' }).click()
  const pager = page.getByRole('navigation', { name: 'Stronicowanie' })
  await expect(pager).toBeVisible()
  expect(await page.locator('tbody tr').count()).toBeLessThanOrEqual(25)
  const firstRowBefore = await page.locator('tbody tr').first().innerText()
  await pager.getByRole('button', { name: 'Następna strona' }).click()
  await expect(pager).toContainText(/Strona 2 z \d+/)
  expect(await page.locator('tbody tr').first().innerText()).not.toBe(firstRowBefore)
})

test('calendar opens the therapist agenda and exposes exact partial payment editing', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /Tryb demonstracyjny.*Anna Maria Janowska/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Justyna Jarosz-Jarszewska/ }).click()
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
  const agenda = page.getByRole('region', { name: /Plan dnia/ })
  await expect(agenda).toBeVisible()
  const partialPayments = agenda.getByRole('button', { name: /Częściowo/ })
  await expect(partialPayments).not.toHaveCount(0)
  const partialPayment = partialPayments.first()
  await partialPayment.scrollIntoViewIfNeeded()
  await partialPayment.click()
  await page.getByRole('menuitemradio', { name: 'Częściowo opłacona' }).click()
  await page.getByRole('menuitem', { name: 'Edytuj kwotę' }).click()
  await expect(page.getByRole('dialog', { name: 'Edycja sesji' }).getByLabel('Wpłacono (zł)')).toBeFocused()
})

test('calendar combines payment and attendance filters after role scope', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: /^Filtry/ }).click()
  const filters = page.getByRole('region', { name: 'Filtry kalendarza' })
  await filters.getByRole('button', { name: 'Nieopłacona', exact: true }).click()
  await filters.getByRole('button', { name: 'Nieobecność', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Filtry · 2' })).toBeVisible()
  const agenda = page.getByRole('region', { name: /Plan dnia/ })
  const rows = agenda.locator('.agenda__row')
  await expect(rows).not.toHaveCount(0)
  await expect(
    rows.locator(':scope:not([data-payment="unpaid"][data-attendance="noshow"])')
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Wyczyść filtry' }).click()
  // clearing brings the settled sessions straight back into the same list
  await expect(agenda.locator('[data-terminal="true"]').first()).toBeVisible()
  expect(await agenda.locator('.agenda__row').count()).toBeGreaterThan(4)
})

test('calendar day strip scrolls with the page instead of covering the agenda', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('region', { name: /Plan dnia/ })).toBeVisible()
  const strip = page.locator('.day-strip')
  const before = await strip.evaluate((el) => el.getBoundingClientRect().top)
  const scrolled = await page.locator('main.content').evaluate((el) => {
    el.scrollTo(0, 300)
    return el.scrollTop
  })
  const after = await strip.evaluate((el) => el.getBoundingClientRect().top)
  expect(scrolled).toBeGreaterThan(50)
  expect(before - after).toBeGreaterThanOrEqual(scrolled - 2)
})

test('selecting a day keeps the visible calendar in place', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' }).click()
  const strip = page.locator('.day-strip')
  await expect(strip).toBeVisible()
  // today's pill: its panel is already on screen, so selecting must not scroll
  await strip.locator('.day-strip__day.is-today').click()
  await page.waitForTimeout(600)
  expect(await page.locator('main.content').evaluate((el) => el.scrollTop)).toBe(0)
  expect(await strip.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(0)
})

test('month view shows sessions across the whole month by default', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' }).click()
  await page.getByRole('radio', { name: 'Miesiąc' }).click()
  expect(await page.locator('.cal__day:has(.cal__item)').count()).toBeGreaterThan(1)
})

test('therapist agenda excludes other therapists and payment updates stay coherent', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /Tryb demonstracyjny/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Justyna Jarosz-Jarszewska/ }).click()
  await page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: /Plan dnia/ }).locator('[data-psych-id="p1"]')).toHaveCount(0)
})

test('owner attention opens matching all-period unpaid payments', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('group', { name: 'Podsumowanie dnia' }).getByRole('button', { name: /Zaległe/ }).click()
  await expect(page.getByRole('region', { name: 'Zakres finansów' })).toContainText('Wszystkie okresy')
  await expect(page.getByRole('region', { name: 'Filtry listy rozliczeń' })).toContainText('Pozostałe do zapłaty')
  await expect(page.locator('.figures__item--amber .figures__value')).toBeVisible()
  const issuedTip = page.locator('.figures__item').filter({ hasText: 'Należne za rozliczone sesje' }).getByRole('button', { name: 'Wyjaśnienie' })
  await issuedTip.focus()
  const issuedTipId = await issuedTip.getAttribute('aria-describedby')
  await expect(page.locator(`[id="${issuedTipId}"]`)).toHaveText('Suma kwot za sesje rozliczane we wszystkich okresach — odbyte i nieobecności. Sesje odwołane nie są fakturowane.')
})

test.describe('Task 3 daily-care redesign', () => {
  test('Today exposes hero precedence, one day summary, and the whole day in time order', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)

    const hero = page.locator('.today-hero')
    await expect(hero.getByText('Trwa teraz', { exact: true })).toBeVisible()
    await expect(hero.locator('.today-hero__time')).toHaveText('10:00')

    const summary = page.getByRole('group', { name: 'Podsumowanie dnia' })
    await expect(summary).toContainText('Odbyte')
    await expect(summary).toContainText('3/7')
    await expect(summary).toContainText('Nieobecności')
    await expect(summary).toContainText('Zaległe')
    await expect(page.locator('.sidebar .today-card__line')).toContainText('7 sesji')

    await page.getByRole('button', { name: /Panel dnia: Trwa/ }).click()
    const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
    await expect(cockpit.locator('.cockpit__next')).toContainText('10:00')
    await expect(cockpit.locator('.cockpit__next')).toContainText('Liliana Romanowska')
    await expect(cockpit).toContainText('3 z 7 sesji za Tobą')
    await cockpit.getByRole('button', { name: 'Zamknij panel dnia' }).click()

    const plan = page.getByRole('region', { name: 'Plan dnia' })
    const visibleRows = plan.locator('.today-session')
    // the whole day is present at once — completed sessions sit in place
    await expect(visibleRows).toHaveCount(7)
    await expect(plan.locator('.today-session[data-status="completed"]')).toHaveCount(3)

    const times = await visibleRows.locator('.spine__time').allTextContents()
    expect(times).toEqual([...times].sort())

    // only rows whose state isn't obvious from the clock carry a status word
    await expect(plan.locator('.today-session.is-live .today-session__status')).toHaveText('trwa')
    await expect(
      plan.locator('.today-session[data-status="completed"] .today-session__status').first()
    ).toHaveText('odbyta')
    await expect(
      plan.locator('.today-session[data-status="noshow"] .today-session__status').first()
    ).toHaveText('nieobecność')
    await expect(plan.locator('.spine__now')).toHaveCount(0)
  })

  test('Today shows the next-session branch before the first visit', async ({ page }) => {
    await freezeTime(page, '2026-07-14T09:00:00')
    await login(page)

    const hero = page.locator('.today-hero')
    await expect(hero.getByText('Następna sesja', { exact: true })).toBeVisible()
    await expect(hero.locator('.today-hero__time')).toHaveText('10:00')
  })

  test('Today keeps every row of a growing day visible', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)

    await page.locator('.today-hero').getByRole('button', { name: 'Nowa sesja' }).click()
    const dialog = page.getByRole('dialog', { name: 'Nowa sesja' })
    await dialog.getByLabel('Klient').selectOption('c1')
    await dialog.getByLabel('Data').fill('2026-07-14')
    await dialog.getByLabel('Godzina').fill('16:00')
    await dialog.getByRole('button', { name: 'Dodaj sesję' }).click()
    await expect(dialog).toBeHidden()

    const visibleRows = page.getByRole('region', { name: 'Plan dnia' }).locator('.today-session')
    await expect(visibleRows).toHaveCount(8)
    for (let index = 0; index < 8; index += 1) {
      await expect(visibleRows.nth(index)).toBeVisible()
    }
    const times = await visibleRows.locator('.spine__time').allTextContents()
    expect(times).toEqual([...times].sort())
    expect(times).toContain('16:00')
  })

  test('Today asks for status after the last scheduled session ends', async ({ page }) => {
    await freezeTime(page, '2026-07-14T20:00:00')
    await login(page)

    await expect(page.getByRole('heading', { level: 2, name: '2 sesji wymaga statusu' })).toBeVisible()
    await expect(page.locator('.today-hero')).toContainText(/Zaktualizuj.*status/i)
    const plan = page.getByRole('region', { name: 'Plan dnia' })
    const visibleRows = plan.locator('.today-session')
    // the day stays in time order; the two unresolved rows say so in place
    const times = await visibleRows.locator('.spine__time').allTextContents()
    expect(times).toEqual([...times].sort())
    await expect(plan.getByText('wymaga statusu')).toHaveCount(2)

    await page.getByRole('button', { name: /Panel dnia: Po sesjach/ }).click()
    const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
    await expect(cockpit.locator('.cockpit__next')).toContainText('najbliższa sesja')
    await cockpit.getByRole('button', { name: 'Zamknij panel dnia' }).click()
  })

  test('Today shows the completed-day branch after scheduled rows receive statuses', async ({ page }) => {
    await freezeTime(page, '2026-07-14T20:00:00')
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Kalendarz' }).click()

    await setAgendaStatus(page, 'Status: Zaplanowana — Liliana Romanowska, 10:00', 'Odbyta')
    await setAgendaStatus(page, 'Status: Zaplanowana — Julian Bąk, 14:00', 'Odbyta')
    await navigation.getByRole('link', { name: 'Dziś' }).click()

    await expect(page.getByRole('heading', { level: 2, name: 'Dzień zakończony' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Podsumowanie dnia' })).toContainText(/Pozostałe\s*0/)
  })

  test('Today shows the free-day branch when the scoped schedule is cancelled', async ({ page }) => {
    await freezeTime(page, '2026-07-14T20:00:00')
    await login(page)
    await switchToTherapist(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Kalendarz' }).click()

    await setAgendaStatus(page, 'Status: Zaplanowana — Liliana Romanowska, 10:00', 'Odwołana')
    await page.getByRole('region', { name: 'Plan dnia' })
      .getByRole('button', { name: 'Edytuj sesję — Tymon Wielgosz, 15:00' })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Edycja sesji' })
    const cancelled = dialog.getByRole('radio', { name: 'Odwołana', exact: true })
    await expect(cancelled).toBeVisible()
    await cancelled.click()
    await dialog.getByRole('button', { name: 'Zapisz zmiany' }).click()
    await expect(dialog).toBeHidden()
    await navigation.getByRole('link', { name: 'Dziś' }).click()

    await expect(page.getByRole('heading', { level: 2, name: 'Wolny dzień' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Plan dnia' })).toHaveCount(0)
  })

  test('Calendar shows the whole day in one list and uses a roving seven-day week', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    await page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' }).click()

    const agenda = page.getByRole('region', { name: 'Plan dnia' })
    await expect(agenda.locator('[data-attendance="scheduled"], [data-attendance="noshow"]')).toHaveCount(4)
    await expect(agenda.getByRole('button', { name: /Jeszcze|więcej/ })).toHaveCount(0)

    // settled sessions sit in the same chronological list, no disclosure
    await expect(agenda.getByRole('button', { name: /Zakończone i odwołane/ })).toHaveCount(0)
    await expect(agenda.locator('[data-terminal="true"]')).toHaveCount(4)
    await expect(agenda.locator('.agenda__row')).toHaveCount(8)
    const times = await agenda.locator('.agenda__time').allTextContents()
    expect(times).toEqual([...times].sort())
    await expect(agenda.getByRole('button', { name: /Status: .+ — .+, \d{2}:\d{2}/ }).first()).toBeVisible()
    await expect(agenda.getByRole('button', { name: /Płatność: .+ — .+, \d{2}:\d{2}/ }).first()).toBeVisible()
    await expect(agenda.getByRole('button', { name: /Edytuj sesję — .+, \d{2}:\d{2}/ }).first()).toBeVisible()

    const week = page.getByRole('group', { name: 'Tydzień' })
    await expect(week.getByRole('button')).toHaveCount(7)
    await expect(week.locator('button[tabindex="0"]')).toHaveCount(1)
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-14')
    // the toolbar reads the week the strip is showing
    await expect(page.locator('.month-nav__label')).toHaveText('13 – 19 lipca')

    await week.locator('button[tabindex="0"]').focus()
    await page.keyboard.press('ArrowLeft')
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-13')
    await page.keyboard.press('PageUp')
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-06')
    await page.getByRole('button', { name: 'Następny tydzień' }).click()
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-13')
    await page.getByRole('button', { name: 'Poprzedni tydzień' }).click()
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-06')
    await expect(page.locator('.month-nav__label')).toHaveText('6 – 12 lipca')

    await openCalendarDay(page, '2026-07-14')
    await week.locator('button[tabindex="0"]').focus()
    await page.keyboard.press('ArrowRight')
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-15')
    await expect(week.locator('button[tabindex="0"]')).toBeFocused()
    await page.keyboard.press('PageDown')
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-22')
    await page.keyboard.press('Home')
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-20')
    await page.keyboard.press('End')
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-26')
  })

  test('Calendar keeps every row of a day visible and exposes only canonical filter labels', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    await page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' }).click()
    await openCalendarDay(page, '2026-07-17')

    const agenda = page.getByRole('region', { name: 'Plan dnia' })
    const rows = agenda.locator('.agenda__row')
    await expect(rows).toHaveCount(4)
    for (let index = 0; index < 4; index += 1) {
      await expect(rows.nth(index)).toBeVisible()
    }
    await expect(agenda.getByRole('button', { name: /Jeszcze|więcej/ })).toHaveCount(0)

    await page.getByRole('button', { name: /^Filtry/ }).click()
    const filters = page.getByRole('region', { name: 'Filtry kalendarza' })
    await expect(filters.getByRole('group', { name: 'Obecność klienta' }).getByRole('button')).toHaveText([
      'Wszystkie',
      'Nieobecność',
      'Odbyta',
      'Odwołana',
      'Zaplanowana',
    ])
    await expect(filters.getByRole('group', { name: 'Płatność' }).getByRole('button')).toHaveText([
      'Wszystkie',
      'Częściowo opłacona',
      'Nieopłacona',
      'Opłacona',
    ])
  })

  test('Calendar focuses the first of multiple highlighted rows', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await page.goto('./#/calendar?date=2026-07-17&highlightSessionIds=s182%2Cs55')
    await page.getByLabel('Hasło').fill('demo')
    await page.getByRole('button', { name: 'Zaloguj się' }).click()

    const agenda = page.getByRole('region', { name: 'Plan dnia' })
    const highlighted = agenda.locator('.agenda__row.is-highlighted')
    await expect(highlighted).toHaveCount(2)
    await expect(highlighted.first()).toHaveAccessibleName(/Alicja Piątek, 08:00/)
    await expect(highlighted.first()).toBeFocused()
    // highlighting marks rows, it never filters the day down to them
    await expect(agenda.locator('.agenda__row')).toHaveCount(4)
  })

  test('Calendar focuses a highlighted terminal row in place', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await page.goto('./#/calendar?date=2026-07-14&highlightSessionIds=demo-owner-completed')
    await page.getByLabel('Hasło').fill('demo')
    await page.getByRole('button', { name: 'Zaloguj się' }).click()

    const agenda = page.getByRole('region', { name: 'Plan dnia' })
    const highlighted = agenda.locator('.agenda__row.is-highlighted[data-terminal="true"]')
    await expect(highlighted).toHaveAccessibleName(/Zofia Mazur, 08:00/)
    await expect(highlighted).toBeFocused()
  })

  test('a client appointment deep-link highlights and focuses its calendar row', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
    await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()

    const upcoming = page.getByRole('region', { name: 'Najbliższe spotkania' })
    await upcoming.getByRole('link', { name: /Pokaż w kalendarzu — 16 lipca, 13:00/ }).click()

    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-07-16')
    const agenda = page.getByRole('region', { name: 'Plan dnia' })
    const highlighted = agenda.locator('.agenda__row.is-highlighted')
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toBeFocused()
    await expect(highlighted).toHaveAccessibleName(/Wyróżniona sesja.*Zofia Mazur.*13:00/)
    await expect(agenda.locator('.agenda__row')).toHaveCount(1)
  })

  test('Calendar restores its date, month, mode and filters', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Kalendarz' }).click()

    await openCalendarDay(page, '2026-06-30')
    await page.getByRole('button', { name: /^Filtry/ }).click()
    await page.getByRole('region', { name: 'Filtry kalendarza' })
      .getByRole('button', { name: 'Opłacona', exact: true })
      .click()
    await page.getByRole('radio', { name: 'Miesiąc' }).click()

    await navigation.getByRole('link', { name: 'Klienci' }).click()
    await navigation.getByRole('link', { name: 'Kalendarz' }).click()

    await expect(page.getByRole('radio', { name: 'Miesiąc' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('.month-nav__label')).toContainText('Czerwiec 2026')
    await expect(page.getByRole('button', { name: 'Filtry · 1' })).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('radio', { name: 'Plan dnia' }).click()
    await expect(selectedDay(page)).toHaveAttribute('data-iso', '2026-06-30')
    await expect(page.getByRole('region', { name: 'Plan dnia' }).locator('[data-terminal="true"]')).toHaveCount(1)
  })

  test('Calendar week keeps adjacent-month session metadata', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    await page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' }).click()

    await openCalendarDay(page, '2026-07-01')

    const adjacentDay = page.getByRole('group', { name: 'Tydzień' })
      .locator('[data-iso="2026-06-30"]')
    await expect(adjacentDay).toHaveAccessibleName('30 czerwca — 1 sesja')
    await expect(adjacentDay.locator('.day-strip__dots .dot')).toHaveCount(1)
  })

  test('Clients supports phone search, responsive labelled filters, and one clear action', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    await openPhoneDestination(page, 'Klienci')

    const search = page.getByPlaceholder('Imię, e-mail lub telefon')
    await search.fill('512384664')
    await expect(page.getByRole('row', { name: /Renata Gawrys/ })).toBeVisible()
    await expect(page.getByRole('row', { name: /Ignacy Borkowski/ })).toBeVisible()
    await expect(page.getByRole('status')).toContainText('2')

    await expect(page.getByRole('group', { name: 'Specjalistka' })).toHaveCount(0)
    const filtersButton = page.getByRole('button', { name: /^Filtry/ })
    await filtersButton.click()
    const filters = page.getByRole('region', { name: 'Filtry klientów' })
    await expect(filters.getByRole('group', { name: 'Płatności' })).toBeVisible()
    await expect(filters.getByRole('group', { name: 'Specjalistka' })).toBeVisible()
    await expect(filters.getByRole('group', { name: 'Status klienta' })).toBeVisible()
    await filters.getByRole('group', { name: 'Specjalistka' }).getByRole('button', { name: 'Katarzyna' }).click()
    await expect(page.getByRole('button', { name: 'Filtry · 1' })).toBeVisible()
    await expect(filters).toContainText('Specjalistka: Katarzyna')
    await expect(filters.getByRole('button', { name: 'Wyczyść filtry' })).toHaveCount(1)

    await page.setViewportSize({ width: 320, height: 800 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })

  test('Clients keeps view context and uses a semantic entity link while role filters stay isolated', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Klienci' }).click()

    await page.getByPlaceholder('Imię, e-mail lub telefon').fill('Madej')
    await page.getByRole('group', { name: 'Specjalistka' }).getByRole('button', { name: 'Justyna' }).click()
    await page.getByRole('group', { name: 'Status klienta' }).getByRole('button', { name: 'Aktywni' }).click()
    const link = page.getByRole('link', { name: 'Otwórz kartę — Gabriel Madej' })
    await expect(link).toHaveAttribute('href', /#\/client\?id=c8$/)
    await expect(link.locator('xpath=ancestor::tr')).not.toHaveAttribute('tabindex')
    await link.click()

    await navigation.getByRole('link', { name: 'Klienci' }).click()
    await expect(page.getByPlaceholder('Imię, e-mail lub telefon')).toHaveValue('Madej')
    await expect(page.getByRole('group', { name: 'Specjalistka' }).getByRole('button', { name: 'Justyna' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('group', { name: 'Status klienta' }).getByRole('button', { name: 'Aktywni' })).toHaveAttribute('aria-pressed', 'true')

    await switchToTherapist(page)
    await expect(page.getByRole('group', { name: 'Specjalistka' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Otwórz kartę — Gabriel Madej' })).toBeVisible()
  })

  test('Clients persists debt, paused status, specialist, query, and scroll context', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 })
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Klienci' }).click()

    await page.getByRole('group', { name: 'Status klienta' }).getByRole('button', { name: 'Wstrzymani' }).click()
    await expect(page.getByRole('row', { name: /Liliana Romanowska/ })).toBeVisible()
    await expect(page.getByRole('row', { name: /Staś Przybylski/ })).toBeVisible()

    await page.getByRole('group', { name: 'Płatności' }).getByRole('button', { name: 'Z zaległościami' }).click()
    await expect(page.getByRole('row', { name: /Liliana Romanowska/ })).toHaveCount(0)
    await expect(page.getByRole('row', { name: /Staś Przybylski/ })).toBeVisible()

    await page.getByRole('group', { name: 'Specjalistka' }).getByRole('button', { name: 'Katarzyna' }).click()
    await page.getByPlaceholder('Imię, e-mail lub telefon').fill('Stas')

    const content = page.locator('main.content')
    const savedScroll = await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      return element.scrollTop
    })
    expect(savedScroll).toBeGreaterThan(0)

    await navigation.getByRole('link', { name: 'Kalendarz' }).click()
    await navigation.getByRole('link', { name: 'Klienci' }).click()
    await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(savedScroll)

    await expect(page.getByPlaceholder('Imię, e-mail lub telefon')).toHaveValue('Stas')
    await expect(page.getByRole('group', { name: 'Specjalistka' }).getByRole('button', { name: 'Katarzyna' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('group', { name: 'Płatności' }).getByRole('button', { name: 'Z zaległościami' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('group', { name: 'Status klienta' }).getByRole('button', { name: 'Wstrzymani' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('region', { name: 'Filtry klientów' })).toContainText('Aktywne filtry · 3')

    await page.getByRole('group', { name: 'Status klienta' }).getByRole('button', { name: 'Wszyscy' }).click()
    await expect(page.getByRole('region', { name: 'Filtry klientów' })).toContainText('Aktywne filtry · 2')
    await page.getByRole('region', { name: 'Filtry klientów' }).getByRole('button', { name: 'Wyczyść filtry' }).click()
    await expect(page.getByRole('group', { name: 'Specjalistka' }).getByRole('button', { name: 'Cały zespół' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('group', { name: 'Płatności' }).getByRole('button', { name: 'Wszystkie' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('group', { name: 'Status klienta' }).getByRole('button', { name: 'Wszyscy' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('region', { name: 'Filtry klientów' }).getByRole('button', { name: 'Wyczyść filtry' })).toHaveCount(0)
    await expect(page.getByPlaceholder('Imię, e-mail lub telefon')).toHaveValue('Stas')
  })

  test('Clients persists page two, keeps it on data mutation, and resets it on query or filter changes', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Klienci' }).click()

    for (let index = 1; index <= 5; index += 1) {
      await addClient(page, `Testowa Osoba ${index}`)
    }

    const pager = page.getByRole('navigation', { name: 'Stronicowanie' })
    await pager.getByRole('button', { name: 'Następna strona' }).click()
    await expectTextStableAcrossFrames(pager, 'Strona 2 z 2')

    await navigation.getByRole('link', { name: 'Kalendarz' }).click()
    await navigation.getByRole('link', { name: 'Klienci' }).click()
    await expectTextStableAcrossFrames(page.getByRole('navigation', { name: 'Stronicowanie' }), 'Strona 2 z 2')

    await addClient(page, 'Testowa Osoba 6')
    await expectTextStableAcrossFrames(page.getByRole('navigation', { name: 'Stronicowanie' }), 'Strona 2 z 2')

    const search = page.getByPlaceholder('Imię, e-mail lub telefon')
    await search.fill('Testowa Osoba')
    await expect(page.getByRole('navigation', { name: 'Stronicowanie' })).toHaveCount(0)
    await search.fill('')
    await expectTextStableAcrossFrames(page.getByRole('navigation', { name: 'Stronicowanie' }), 'Strona 1 z 2')

    await page.getByRole('navigation', { name: 'Stronicowanie' }).getByRole('button', { name: 'Następna strona' }).click()
    await page.getByRole('group', { name: 'Status klienta' }).getByRole('button', { name: 'Wstrzymani' }).click()
    await expect(page.getByRole('navigation', { name: 'Stronicowanie' })).toHaveCount(0)
    await page.getByRole('group', { name: 'Status klienta' }).getByRole('button', { name: 'Wszyscy' }).click()
    await expectTextStableAcrossFrames(page.getByRole('navigation', { name: 'Stronicowanie' }), 'Strona 1 z 2')
  })

  test('Dziś, Kalendarz, and Klienci avoid page overflow at 320 and 390 pixels', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 })
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      for (const label of ['Dziś', 'Kalendarz', 'Klienci']) {
        await openPhoneDestination(page, label)
        await expectNoHorizontalPageOverflow(page)
      }
    }
  })

  test('entity-link hrefs hydrate client and highlighted calendar routes after login', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()

    const clientHref = await page.getByRole('link', { name: 'Otwórz kartę — Gabriel Madej' }).getAttribute('href')
    await page.goto(new URL(clientHref, page.url()).href)
    await page.reload()
    await page.getByLabel('Hasło').fill('demo')
    await page.getByRole('button', { name: 'Zaloguj się' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Gabriel Madej' })).toBeVisible()

    const calendarHref = await page.getByRole('link', { name: /Pokaż w kalendarzu/ }).first().getAttribute('href')
    const calendarUrl = new URL(calendarHref, page.url())
    const expectedDate = new URLSearchParams(calendarUrl.hash.split('?')[1]).get('date')
    await page.goto(calendarUrl.href)
    await page.reload()
    await page.getByLabel('Hasło').fill('demo')
    await page.getByRole('button', { name: 'Zaloguj się' }).click()

    await expect(selectedDay(page)).toHaveAttribute('data-iso', expectedDate)
    await expect(page.getByRole('region', { name: 'Plan dnia' }).locator('.agenda__row.is-highlighted')).toHaveCount(1)
  })

  test('hydrated client routes cannot cross a persisted therapist scope', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    await switchToTherapist(page)
    await page.getByRole('button', { name: 'Wyloguj się' }).click()

    await page.evaluate(() => { window.location.hash = '#/client?id=c1' })
    await page.getByLabel('Hasło').fill('demo')
    await page.getByRole('button', { name: 'Zaloguj się' }).click()

    await expect(page.getByText('Nie znaleziono klienta')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Zofia Mazur' })).toHaveCount(0)
    await expect(page.getByText('+48 521 172 603')).toHaveCount(0)
  })
})

test.describe('Task 4 administrative redesign', () => {
  test('Finanse keeps page figures stable across ledger filters and restores every scope control', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Finanse' }).click()

    const scope = page.getByRole('region', { name: 'Zakres finansów' })
    await expect(scope).toContainText('Zakres: Lipiec 2026 · Cały zespół')
    await expect(page.locator('.finance-figure-label')).toHaveText([
      'Należne za rozliczone sesje',
      'Wpłacono',
      'Pozostało do zapłaty',
    ])

    const figures = page.locator('.figures__value')
    const figuresBefore = await figures.allTextContents()
    const ledgerFilters = page.getByRole('region', { name: 'Filtry listy rozliczeń' })
    await expect(ledgerFilters).toContainText('Dotyczy tylko: Lista rozliczeń')
    await ledgerFilters.getByRole('button', { name: 'Pozostałe do zapłaty' }).click()
    await expect(figures).toHaveText(figuresBefore)
    await expect(page.getByRole('table', { name: 'Lista rozliczeń' }).locator('tbody tr')).not.toHaveCount(0)
    expect(await page.getByRole('table', { name: 'Lista rozliczeń' }).locator('tbody tr').evaluateAll(
      (rows) => rows.every((row) => Number(row.dataset.outstanding) > 0)
    )).toBe(true)

    const specialistButtons = scope.getByRole('group', { name: 'Specjalistka' }).getByRole('button')
    await expect(specialistButtons).toHaveText(['Cały zespół', 'Anna', 'Justyna', 'Katarzyna', 'Natasza'])
    await scope.getByRole('button', { name: 'Natasza Korneluk' }).click()
    await expect(scope).toContainText('Natasza Korneluk')
    const comparison = page.getByRole('region', { name: 'Porównanie specjalistek' })
    await expect(comparison.locator('.finance-comparison__row')).toHaveCount(1)
    await expect(comparison).toContainText('Natasza')
    await expect(comparison).not.toContainText('Justyna')

    await navigation.getByRole('link', { name: 'Kalendarz' }).click()
    await navigation.getByRole('link', { name: 'Finanse' }).click()
    await expect(scope.getByRole('button', { name: 'Natasza Korneluk' })).toHaveAttribute('aria-pressed', 'true')
    await expect(ledgerFilters.getByRole('button', { name: 'Pozostałe do zapłaty' })).toHaveAttribute('aria-pressed', 'true')

    await scope.getByRole('button', { name: 'Cały zespół' }).click()
    await ledgerFilters.getByRole('button', { name: 'Wszystkie płatności' }).click()
    await page.getByRole('button', { name: 'Poprzedni miesiąc' }).click()
    const savedMonth = await page.locator('.month-nav__label').textContent()
    const pager = page.getByRole('navigation', { name: 'Stronicowanie' })
    await expect(pager).toBeVisible()
    await pager.getByRole('button', { name: 'Następna strona' }).click()
    await expect(pager).toContainText('Strona 2')

    await navigation.getByRole('link', { name: 'Kalendarz' }).click()
    await navigation.getByRole('link', { name: 'Finanse' }).click()
    await expect(page.locator('.month-nav__label')).toHaveText(savedMonth)
    await expect(page.getByRole('navigation', { name: 'Stronicowanie' })).toContainText('Strona 2')
  })

  test('Finanse validates additive payments and Undo restores all four snapshot fields', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Finanse' }).click()

    const row = page.locator('tr[data-session-id="demo-unpaid"]')
    await expect(row).toHaveAttribute('data-payment', 'unpaid')
    await expect(row).toHaveAttribute('data-paid-amount', '0')
    await expect(row).toHaveAttribute('data-method', '')
    await expect(row).toHaveAttribute('data-paid-date', '')
    await expect(row.getByTitle('Zmień płatność')).toHaveCount(0)

    const bookButton = row.getByRole('button', { name: /Zaksięguj wpłatę.*Antoni Krawczyk.*14 lipca 2026/ })
    await bookButton.click()
    let dialog = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
    await expect(dialog).toContainText('Antoni Krawczyk')
    await expect(dialog).toContainText('14 lipca 2026')
    const amount = dialog.getByLabel('Kwota wpłaty')
    const method = dialog.getByLabel('Forma płatności')
    await expect(amount).toHaveValue('180')
    await dialog.getByRole('button', { name: 'Anuluj' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(bookButton).toBeFocused()
    await bookButton.click()
    dialog = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })

    await amount.fill('181')
    await dialog.getByRole('button', { name: 'Zapisz wpłatę' }).click()
    await expect(dialog.getByText('Kwota nie może przekraczać pozostałej kwoty')).toBeVisible()
    await expect(dialog.getByText('Wybierz formę płatności')).toBeVisible()
    await expect(amount).toHaveValue('181')
    await expect(amount).toBeFocused()

    await amount.fill('100')
    await method.selectOption('cash')
    await dialog.getByRole('button', { name: 'Zapisz wpłatę' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(row).toHaveAttribute('data-payment', 'partial')
    await expect(row).toHaveAttribute('data-paid-amount', '100')
    await expect(row).toHaveAttribute('data-method', 'cash')
    await expect(row).toHaveAttribute('data-paid-date', '2026-07-14')
    await expect(row.getByRole('button', { name: /Zaksięguj wpłatę/ })).toBeFocused()
    const partialToast = page.locator('.toast').filter({ hasText: 'Zaksięgowano wpłatę' })
    await expect(partialToast.getByRole('button', { name: 'Cofnij' })).toBeVisible()
    await expect(partialToast.getByRole('button', { name: /Zamknij:/ })).toBeVisible()
    await partialToast.evaluate((element) => {
      const buttons = [...element.querySelectorAll('button')]
      const dismiss = buttons.find((button) => button.getAttribute('aria-label')?.startsWith('Zamknij:'))
      const undo = buttons.find((button) => button.textContent.trim() === 'Cofnij')
      dismiss.click()
      undo.click()
    })
    await expect(partialToast).toHaveCount(0)
    await expect(row).toHaveAttribute('data-payment', 'partial')
    await expect(row).toHaveAttribute('data-paid-amount', '100')

    await row.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
    dialog = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
    await expect(dialog.getByLabel('Kwota wpłaty')).toHaveValue('80')
    await dialog.getByLabel('Forma płatności').selectOption('transfer')
    await dialog.getByRole('button', { name: 'Zapisz wpłatę' }).click()
    await expect(row).toHaveAttribute('data-payment', 'paid')
    await expect(row).toHaveAttribute('data-paid-amount', '180')
    await expect(row).toHaveAttribute('data-method', 'transfer')
    await expect(row).toHaveAttribute('data-paid-date', '2026-07-14')
    await expect(page.getByRole('heading', { name: 'Lista rozliczeń' })).toBeFocused()

    const fullToast = page.locator('.toast').filter({ hasText: 'Zaksięgowano wpłatę' })
    await page.waitForTimeout(3200)
    await expect(fullToast).toBeVisible()
    await fullToast.getByRole('button', { name: 'Cofnij' }).click()
    await expect(fullToast).toHaveCount(0)
    await expect(row).toHaveAttribute('data-payment', 'partial')
    await expect(row).toHaveAttribute('data-paid-amount', '100')
    await expect(row).toHaveAttribute('data-method', 'cash')
    await expect(row).toHaveAttribute('data-paid-date', '2026-07-14')
  })

  test('Finanse and Raporty present fractional payments to the exact cent', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Finanse' }).click()
    const row = page.locator('tr[data-session-id="demo-unpaid"]')

    await row.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
    let dialog = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
    await expect(dialog).toContainText('pozostało 180 zł')
    await dialog.getByLabel('Kwota wpłaty').fill('8.21')
    await dialog.getByLabel('Forma płatności').selectOption('cash')
    await dialog.getByRole('button', { name: 'Zapisz wpłatę' }).click()

    await expect(row.locator('td').nth(4)).toHaveText(/8,21\s*zł/)
    await expect(page.locator('.toast').filter({ hasText: 'Zaksięgowano wpłatę' })).toContainText(/8,21\s*zł/)
    await expect(page.locator('.figures__item').filter({ hasText: 'Wpłacono' }).first()).toContainText(/,21\s*zł/)

    await row.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
    dialog = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
    await expect(dialog.getByLabel('Kwota wpłaty')).toHaveValue('171.79')
    await expect(dialog).toContainText(/pozostało 171,79\s*zł/)
    await dialog.getByRole('button', { name: 'Anuluj' }).click()

    await navigation.getByRole('link', { name: 'Raporty' }).click()
    await expect(page.locator('.stat').filter({ hasText: 'Wpłacono' }).first()).toContainText(/,21\s*zł/)
  })

  test('actionable finance toasts clear on logout and role boundaries', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Finanse' }).click()
    const row = page.locator('tr[data-session-id="demo-unpaid"]')

    await row.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
    let dialog = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
    await dialog.getByLabel('Kwota wpłaty').fill('100')
    await dialog.getByLabel('Forma płatności').selectOption('cash')
    await dialog.getByRole('button', { name: 'Zapisz wpłatę' }).click()
    let paymentToast = page.locator('.toast').filter({ hasText: 'Antoni Krawczyk' })
    await expect(paymentToast).toBeVisible()

    await page.getByRole('button', { name: 'Wyloguj się' }).click()
    await expect(page.getByRole('button', { name: 'Zaloguj się' })).toBeVisible()
    await expect(paymentToast).toHaveCount(0, { timeout: 750 })

    await page.getByLabel('Hasło').fill('demo')
    await page.getByRole('button', { name: 'Zaloguj się' }).click()
    await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Finanse' }).click()
    await row.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
    dialog = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
    await dialog.getByLabel('Forma płatności').selectOption('transfer')
    await dialog.getByRole('button', { name: 'Zapisz wpłatę' }).click()
    paymentToast = page.locator('.toast').filter({ hasText: 'Antoni Krawczyk' })
    await expect(paymentToast).toBeVisible()

    await page.getByRole('button', { name: /Tryb demonstracyjny.*Anna Maria Janowska/ }).click()
    await page.getByRole('button', { name: /Specjalistka.*Justyna Jarosz-Jarszewska/ }).click()
    await expect(paymentToast).toHaveCount(0, { timeout: 750 })
    await expect(page.getByRole('navigation', { name: 'Nawigacja główna' })).not.toContainText('Finanse')
  })

  test('only the newest payment Undo remains actionable for one session', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Finanse' }).click()
    const row = page.locator('tr[data-session-id="demo-unpaid"]')
    const book = async (amount, method) => {
      await row.getByRole('button', { name: /Zaksięguj wpłatę/ }).click()
      const dialog = page.getByRole('dialog', { name: 'Zaksięguj wpłatę' })
      await dialog.getByLabel('Kwota wpłaty').fill(amount)
      await dialog.getByLabel('Forma płatności').selectOption(method)
      await dialog.getByRole('button', { name: 'Zapisz wpłatę' }).click()
    }

    await book('50', 'cash')
    await book('25', 'card')
    await expect(row).toHaveAttribute('data-paid-amount', '75')
    const paymentToasts = page.locator('.toast').filter({ hasText: 'Zaksięgowano wpłatę' })
    await expect(paymentToasts).toHaveCount(1)
    await paymentToasts.getByRole('button', { name: 'Cofnij' }).click()
    await expect(row).toHaveAttribute('data-paid-amount', '50')
    await expect(row).toHaveAttribute('data-method', 'cash')
  })

  test('Raporty scopes its narrative, figures, rows, chart, and mobile summaries together', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Raporty' }).click()

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Raport miesięczny — lipiec 2026')
    await expect(page.getByText('Zakres: cały zespół.', { exact: true })).toBeVisible()
    await expect(page.locator('.stat__label')).toContainText([
      'Należne',
      'Wpłacono',
      'Pozostało do zapłaty',
    ])
    // the month reads as squares and bars now, not as a written paragraph
    await expect(page.getByText(/W lipcu zespół przeprowadził/)).toHaveCount(0)

    const comparison = page.getByRole('group', { name: 'Porównanie specjalistek' })
    const groupClasses = page.getByRole('region', { name: 'Zajęcia grupowe TUS' })
    const allGroups = await groupClasses.locator('[data-group-id]').count()
    const allSpecialists = await comparison.locator('[data-specialist-id]').count()
    expect(allGroups).toBeGreaterThan(1)
    expect(allSpecialists).toBeGreaterThan(1)

    // resolved from the chips rather than hard-coded, so renaming the demo
    // roster never turns a scoping regression into a name-lookup failure
    const chips = page.getByRole('group', { name: 'Specjalistka raportu' })
    const scoped = chips.getByRole('button').nth(1)
    const scopedName = await scoped.getAttribute('aria-label')
    const otherName = await chips.getByRole('button').nth(2).getAttribute('aria-label')
    await scoped.click()

    const body = page.getByRole('region', { name: 'Treść raportu' })
    await expect(page.getByText(`Zakres: ${scopedName}.`, { exact: true })).toBeVisible()
    await expect(body).toContainText(scopedName)
    await expect(body).not.toContainText(otherName)
    await expect(comparison.locator('[data-specialist-id]')).toHaveCount(1)
    await expect(page.getByRole('table', { name: `Struktura należności — ${scopedName}` }).locator('tbody tr')).toHaveCount(1)
    // the group-class block narrows to the groups this specialist actually leads
    const scopedGroups = await groupClasses.locator('[data-group-id]').count()
    expect(scopedGroups).toBeGreaterThan(0)
    expect(scopedGroups).toBeLessThan(allGroups)

    await page.getByRole('button', { name: 'Poprzedni miesiąc' }).click()
    const savedHeading = await page.getByRole('heading', { level: 1 }).textContent()
    await navigation.getByRole('link', { name: 'Finanse' }).click()
    await navigation.getByRole('link', { name: 'Raporty' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(savedHeading)
    await expect(chips.getByRole('button', { name: scopedName })).toHaveAttribute('aria-pressed', 'true')

    // one set of specialist rows serves every width — no table/card duplication
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(comparison.locator('[data-specialist-id]')).toHaveCount(1)
    await expect(comparison).toContainText(scopedName)
    await expectNoHorizontalPageOverflow(page)
  })

  test('Ustawienia limits the coordinator to personal calendar and integration preferences', async ({ page }) => {
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Ustawienia' }).click()
    await page.getByRole('navigation', { name: 'Sekcje ustawień' })
      .getByRole('button', { name: 'Zespół i stawki' }).click()

    await switchToCoordinator(page)

    const main = page.getByRole('main')
    const sections = main.getByRole('navigation', { name: 'Sekcje ustawień' })
    await expect(main.getByRole('heading', { level: 1, name: 'Ustawienia osobiste' })).toBeVisible()
    await expect(main).toContainText('Kalendarz, integracje i preferencje dla: Julia Wolanin · Koordynatorka.')
    await expect(sections.getByRole('button')).toHaveText(['Kalendarz i integracje'])
    await expect(sections.getByRole('button', { name: 'Kalendarz i integracje' })).toHaveAttribute('aria-current', 'true')
    await expect(main.getByRole('heading', { name: 'Kalendarz i integracje', exact: true })).toBeVisible()
    await expect(main.getByRole('switch', { name: 'Weekendy w kalendarzu' })).toBeVisible()
    await expect(main.getByRole('form', { name: 'Twoje konto' })).toHaveCount(0)
    await expect(main.getByRole('form', { name: 'Dane centrum' })).toHaveCount(0)
    await expect(main.getByRole('form', { name: 'Zespół i stawki' })).toHaveCount(0)
    await expect(main.getByRole('button', { name: /Edytuj profil/ })).toHaveCount(0)
    await expect(main.getByRole('button', { name: 'Dodaj specjalistkę' })).toHaveCount(0)
  })

  test('Ustawienia limits the therapist to personal calendar and integration preferences', async ({ page }) => {
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Ustawienia' }).click()
    await page.getByRole('navigation', { name: 'Sekcje ustawień' })
      .getByRole('button', { name: 'Centrum' }).click()

    await switchToTherapist(page)

    const main = page.getByRole('main')
    const sections = main.getByRole('navigation', { name: 'Sekcje ustawień' })
    await expect(main.getByRole('heading', { level: 1, name: 'Ustawienia osobiste' })).toBeVisible()
    await expect(main).toContainText('Kalendarz, integracje i preferencje dla: Justyna Jarosz-Jarszewska · Specjalistka.')
    await expect(sections.getByRole('button')).toHaveText(['Kalendarz i integracje'])
    await expect(sections.getByRole('button', { name: 'Kalendarz i integracje' })).toHaveAttribute('aria-current', 'true')
    await expect(main.getByRole('heading', { name: 'Kalendarz i integracje', exact: true })).toBeVisible()
    await expect(main.getByRole('switch', { name: 'Weekendy w kalendarzu' })).toBeVisible()
    await expect(main.getByRole('form', { name: 'Twoje konto' })).toHaveCount(0)
    await expect(main.getByRole('form', { name: 'Dane centrum' })).toHaveCount(0)
    await expect(main.getByRole('form', { name: 'Zespół i stawki' })).toHaveCount(0)
    await expect(main.getByRole('button', { name: /Edytuj profil/ })).toHaveCount(0)
    await expect(main.getByRole('button', { name: 'Dodaj specjalistkę' })).toHaveCount(0)
  })

  test('Ustawienia keeps ordered local section navigation on desktop and mobile', async ({ page }) => {
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Ustawienia' }).click()

    const localNavigation = page.getByRole('navigation', { name: 'Sekcje ustawień' })
    await expect(localNavigation.getByRole('button')).toHaveText([
      'Konto',
      'Centrum',
      'Kalendarz i integracje',
      'Zespół i stawki',
    ])
    expect((await localNavigation.getByRole('button', { name: 'Konto' }).boundingBox()).height).toBeGreaterThanOrEqual(44)
    await localNavigation.getByRole('button', { name: 'Zespół i stawki' }).click()
    await expect(page.getByRole('heading', { name: 'Zespół i stawki', exact: true })).toBeFocused()

    await navigation.getByRole('link', { name: 'Finanse' }).click()
    await navigation.getByRole('link', { name: 'Ustawienia' }).click()
    await expect(localNavigation.getByRole('button', { name: 'Zespół i stawki' })).toHaveAttribute('aria-current', 'true')

    await page.setViewportSize({ width: 390, height: 844 })
    const select = page.getByLabel('Sekcja ustawień')
    await expect(select.locator('option')).toHaveText([
      'Konto',
      'Centrum',
      'Kalendarz i integracje',
      'Zespół i stawki',
    ])
    await select.selectOption('calendar')
    await expect(page.getByRole('heading', { name: 'Kalendarz i integracje', exact: true })).toBeFocused()
    await expectNoHorizontalPageOverflow(page)
  })

  test('Ustawienia validates local drafts and saves the whole team explicitly', async ({ page }) => {
    await login(page)
    await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Ustawienia' }).click()

    const account = page.getByRole('form', { name: 'Twoje konto' })
    const saveAccount = account.getByRole('button', { name: 'Zapisz konto' })
    const accountEmail = account.getByLabel('Adres e-mail')
    await expect(saveAccount).toBeDisabled()
    await accountEmail.fill('niepoprawny')
    await expect(account.getByText('Podaj poprawny adres e-mail')).toBeVisible()
    await expect(accountEmail).toHaveValue('niepoprawny')
    await expect(saveAccount).toBeDisabled()
    await accountEmail.fill('anna+task4@bearwithme.pl')
    await expect(account.getByRole('status')).toHaveText('Niezapisane zmiany')
    await expect(saveAccount).toBeEnabled()
    await saveAccount.click()
    await expect(account.getByRole('status')).toHaveText('Zapisywanie…')
    await expect(accountEmail).toBeDisabled()
    await expect(account.getByRole('status')).toHaveText('Zapisano')
    await expect(accountEmail).toBeEnabled()
    await expect(saveAccount).toBeDisabled()

    const center = page.getByRole('form', { name: 'Dane centrum' })
    const saveCenter = center.getByRole('button', { name: 'Zapisz dane centrum' })
    await expect(saveCenter).toBeDisabled()
    await center.getByLabel('E-mail').fill('centrum@')
    await expect(center.getByText('Podaj poprawny adres e-mail')).toBeVisible()
    await expect(center.getByLabel('E-mail')).toHaveValue('centrum@')
    await expect(saveCenter).toBeDisabled()
    await center.getByLabel('E-mail').fill('biuro@bearwithme.pl')
    await expect(center.getByRole('status')).toHaveText('Niezapisane zmiany')

    await page.getByRole('navigation', { name: 'Sekcje ustawień' }).getByRole('button', { name: 'Zespół i stawki' }).click()
    const team = page.getByRole('form', { name: 'Zespół i stawki' })
    const saveTeam = team.getByRole('button', { name: 'Zapisz zespół' })
    await expect(saveTeam).toBeDisabled()
    const juliaRate = team.getByLabel('Stawka — Anna Maria Janowska')
    const martaCapacity = team.getByLabel('Limit tygodniowy — Justyna Jarosz-Jarszewska')
    await juliaRate.fill('0')
    await expect(team.getByText('Stawka musi być większa od zera')).toBeVisible()
    await expect(juliaRate).toHaveValue('0')
    await martaCapacity.fill('12.5')
    await expect(team.getByText('Limit musi być dodatnią liczbą całkowitą')).toBeVisible()
    await expect(martaCapacity).toHaveValue('12.5')
    await expect(saveTeam).toBeDisabled()

    await juliaRate.fill('230')
    await martaCapacity.fill('21')
    await expect(team.getByRole('status')).toHaveText('Niezapisane zmiany')
    await expect(saveTeam).toBeEnabled()
    await saveTeam.click()
    await expect(team.getByRole('status')).toHaveText('Zapisywanie…')
    await expect(juliaRate).toBeDisabled()
    await expect(martaCapacity).toBeDisabled()
    await expect(team.getByRole('status')).toHaveText('Zapisano')
    await expect(juliaRate).toBeEnabled()
    await expect(martaCapacity).toBeEnabled()
    await expect(saveTeam).toBeDisabled()
    await expect(juliaRate).toHaveValue('230')
    await expect(martaCapacity).toHaveValue('21')
  })

  test('team drafts rebase pristine fields while preserving dirty fields after profile edits', async ({ page }) => {
    await login(page)
    await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Ustawienia' }).click()
    await page.getByRole('navigation', { name: 'Sekcje ustawień' }).getByRole('button', { name: 'Zespół i stawki' }).click()
    const team = page.getByRole('form', { name: 'Zespół i stawki' })
    const juliaRate = team.getByLabel('Stawka — Anna Maria Janowska')
    const juliaCapacity = team.getByLabel('Limit tygodniowy — Anna Maria Janowska')
    await juliaCapacity.fill('21')

    await team.getByRole('button', { name: 'Edytuj profil — Anna Maria Janowska' }).click()
    const drawer = page.getByRole('dialog', { name: 'Edycja profilu specjalistki' })
    await drawer.getByLabel('Stawka (zł / sesja)').fill('230')
    await drawer.getByRole('button', { name: 'Zapisz zmiany' }).click()
    await expect(drawer).toHaveCount(0)

    await expect(juliaRate).toHaveValue('230')
    await expect(juliaCapacity).toHaveValue('21')
    await expect(team.getByRole('status')).toHaveText('Niezapisane zmiany')
    await team.getByRole('button', { name: 'Zapisz zespół' }).click()
    await expect(team.getByRole('status')).toHaveText('Zapisano')
    await expect(juliaRate).toHaveValue('230')
    await expect(juliaCapacity).toHaveValue('21')
  })

  test('preference rows are full-size switches whose five-second Undo restores the prior value', async ({ page }) => {
    await login(page)
    await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('link', { name: 'Ustawienia' }).click()
    await page.getByRole('navigation', { name: 'Sekcje ustawień' }).getByRole('button', { name: 'Kalendarz i integracje' }).click()

    const weekends = page.getByRole('switch', { name: 'Weekendy w kalendarzu' })
    await expect(weekends).toHaveAttribute('aria-checked', 'true')
    const hitBox = await weekends.boundingBox()
    expect(hitBox.height).toBeGreaterThanOrEqual(44)
    expect(hitBox.width).toBeGreaterThanOrEqual(44)
    await weekends.click()
    await expect(weekends).toHaveAttribute('aria-checked', 'false')

    const toast = page.locator('.toast').filter({ hasText: 'Weekendy w kalendarzu' })
    const undo = toast.getByRole('button', { name: 'Cofnij' })
    const dismiss = toast.getByRole('button', { name: /Zamknij:/ })
    await expect(undo).toBeVisible()
    await expect(dismiss).toBeVisible()
    expect((await undo.boundingBox()).height).toBeGreaterThanOrEqual(44)
    expect((await dismiss.boundingBox()).height).toBeGreaterThanOrEqual(44)
    await undo.click()
    await expect(toast).toHaveCount(0)
    await expect(weekends).toHaveAttribute('aria-checked', 'true')

    await weekends.click()
    const expiringToast = page.locator('.toast').filter({ hasText: 'Weekendy w kalendarzu' })
    const expiringUndo = expiringToast.getByRole('button', { name: 'Cofnij' })
    await expect(expiringUndo).toBeEnabled()
    await page.waitForTimeout(5050)
    await expect(expiringUndo).toBeDisabled()
    await expect(weekends).toHaveAttribute('aria-checked', 'false')
    await expect(expiringToast).toHaveCount(0)
    await expect(weekends).toHaveAttribute('aria-checked', 'false')
  })

  test('Finanse, Raporty, and Ustawienia avoid page overflow at 320 and 390 pixels', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await page.setViewportSize({ width: 320, height: 844 })
    await login(page)

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await openPhoneDestination(page, 'Finanse')
      await expectNoHorizontalPageOverflow(page)

      await openPhoneDestination(page, 'Raporty')
      await expectNoHorizontalPageOverflow(page)

      await openPhoneDestination(page, 'Ustawienia')
      await expectNoHorizontalPageOverflow(page)
    }
  })
})

test.describe('Task 5 team redesign', () => {
  test('weekly capacity cards are alphabetical, filterable, persisted, and semantically linked', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })

    await navigation.getByRole('link', { name: 'Ustawienia' }).click()
    await page.getByRole('navigation', { name: 'Sekcje ustawień' }).getByRole('button', { name: 'Zespół i stawki' }).click()
    const settingsTeam = page.getByRole('form', { name: 'Zespół i stawki' })
    await settingsTeam.getByLabel('Limit tygodniowy — Anna Maria Janowska').fill('8')
    await settingsTeam.getByRole('button', { name: 'Zapisz zespół' }).click()
    await expect(settingsTeam.getByRole('status')).toHaveText('Zapisano')

    await navigation.getByRole('link', { name: 'Zespół' }).click()
    await expect(page.locator('.view-head__sub')).toContainText('13 lipca – 19 lipca')
    await expect(page.getByRole('link', { name: /^Otwórz profil —/ })).toHaveText([
      /Anna Maria Janowska/,
      /Justyna Jarosz-Jarszewska/,
      /Katarzyna Szelinger/,
      /Natasza Korneluk/,
    ])
    const namedLeadCard = page.getByRole('article', { name: 'mgr Anna Maria Janowska', exact: true })
    await expect(namedLeadCard.getByRole('heading', { level: 2, name: 'mgr Anna Maria Janowska', exact: true })).toBeVisible()
    const teamCardLabels = await page.locator('.team-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-labelledby')))
    expect(teamCardLabels.every(Boolean)).toBe(true)
    expect(new Set(teamCardLabels).size).toBe(teamCardLabels.length)
    const leadCard = page.locator('.team-card').filter({ has: page.getByRole('link', { name: 'Otwórz profil — Anna Maria Janowska' }) })
    await expect(leadCard).toContainText('8 / 8 sesji w tym tygodniu')
    await expect(leadCard.getByRole('progressbar')).toHaveAttribute('max', '8')
    await expect(leadCard).toContainText('Pełne obłożenie')
    await expect(leadCard.getByRole('alert').getByRole('link')).toHaveAttribute(
      'href',
      /#\/calendar\?date=2026-07-14&highlightSessionIds=demo-overlap%2Cdemo-unpaid/
    )
    for (const name of ['Natasza Korneluk', 'Katarzyna Szelinger', 'Justyna Jarosz-Jarszewska']) {
      const card = page.locator('.team-card').filter({ has: page.getByRole('link', { name: `Otwórz profil — ${name}` }) })
      await expect(card.getByRole('alert')).toHaveCount(0)
    }
    const tusTrainerCard = page.locator('.team-card').filter({ has: page.getByRole('link', { name: 'Otwórz profil — Katarzyna Szelinger' }) })
    await expect(tusTrainerCard.locator('.team-card__today')).not.toContainText('12:00')

    const filters = page.getByRole('group', { name: 'Obłożenie' })
    await expect(filters.getByRole('button')).toHaveText(['Cały zespół', 'Dostępne miejsca', 'Pełne obłożenie'])
    await filters.getByRole('button', { name: 'Pełne obłożenie' }).click()
    await expect(page.getByRole('status', { name: 'Liczba specjalistek' })).toHaveText('1 specjalistka')
    await expect(page.getByRole('link', { name: 'Otwórz profil — Anna Maria Janowska' })).toBeVisible()

    await filters.getByRole('button', { name: 'Dostępne miejsca' }).click()
    await expect(page.getByRole('status', { name: 'Liczba specjalistek' })).toHaveText('3 specjalistki')
    await page.locator('main.content').evaluate((element) => element.scrollTo(0, 240))
    await navigation.getByRole('link', { name: 'Raporty' }).click()
    await navigation.getByRole('link', { name: 'Zespół' }).click()
    await expect(filters.getByRole('button', { name: 'Dostępne miejsca' })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.locator('main.content').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  })

  test('team card actions scope clients and conflicts deep-link both sessions into Calendar', async ({ page }) => {
    await freezeTime(page, '2026-07-14T10:30:00')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Zespół' }).click()

    const therapistCard = page.locator('.team-card').filter({ has: page.getByRole('link', { name: 'Otwórz profil — Justyna Jarosz-Jarszewska' }) })
    await therapistCard.getByRole('link', { name: 'Klienci — Justyna Jarosz-Jarszewska' }).click()
    await expect(page.getByRole('region', { name: 'Filtry klientów' })).toContainText('Specjalistka: Justyna')

    await navigation.getByRole('link', { name: 'Zespół' }).click()
    await page.locator('.team-card')
      .filter({ has: page.getByRole('link', { name: 'Otwórz profil — Justyna Jarosz-Jarszewska' }) })
      .getByRole('link', { name: 'Kalendarz — Justyna Jarosz-Jarszewska' })
      .click()
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
    expect(await page.locator('.agenda__row.is-highlighted').count()).toBeGreaterThanOrEqual(1)

    await navigation.getByRole('link', { name: 'Zespół' }).click()
    const leadCard = page.locator('.team-card').filter({ has: page.getByRole('link', { name: 'Otwórz profil — Anna Maria Janowska' }) })
    const alert = leadCard.getByRole('alert')
    await expect(alert).toContainText('Konflikt')
    const conflictLink = alert.getByRole('link', {
      name: 'Otwórz konflikt — Anna Maria Janowska, 14 lipca, 14:00 (demo-overlap) i 14:00 (demo-unpaid)',
      exact: true,
    })
    await expect(conflictLink).toBeVisible()
    await conflictLink.click()
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.agenda__row.is-highlighted')).toHaveCount(2)
    await expect(page.locator('.agenda__row.is-highlighted').first()).toBeFocused()
  })

  test('client specialist route params cannot escape therapist role scope', async ({ page }) => {
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Zespół' }).click()
    const leadCard = page.locator('.team-card').filter({ has: page.getByRole('link', { name: 'Otwórz profil — Anna Maria Janowska' }) })
    await leadCard.getByRole('link', { name: 'Klienci — Anna Maria Janowska' }).click()
    await expect(page.getByRole('region', { name: 'Filtry klientów' })).toContainText('Specjalistka: Anna')

    await switchToTherapist(page)
    await expect(page.getByRole('heading', { level: 1, name: 'Moi klienci' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Filtry klientów' })).not.toContainText('Specjalistka')
    await expect(page.getByRole('link', { name: 'Otwórz kartę — Gabriel Madej' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Wyloguj się' }).click()
    await expect(page.getByRole('button', { name: 'Zaloguj się' })).toBeVisible()
    await page.evaluate(() => window.history.replaceState(window.history.state, '', '#/clients?specialist=p1'))
    await page.getByLabel('Hasło').fill('demo')
    await page.getByRole('button', { name: 'Zaloguj się' }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Moi klienci' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Filtry klientów' })).not.toContainText('Specjalistka')
    expect(await page.getByRole('main').getByRole('link', { name: /^Otwórz kartę —/ }).evaluateAll(
      (links) => links.map((link) => link.getAttribute('aria-label'))
    )).toEqual([
      'Otwórz kartę — Liliana Romanowska',
      'Otwórz kartę — Tymon Wielgosz',
      'Otwórz kartę — Gabriel Madej',
      'Otwórz kartę — Zuzanna Duda',
    ])
    await expect(page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' })).toHaveCount(0)
  })

  test('specialist creation is canonical on Team and Settings only links back to team management', async ({ page }) => {
    await login(page)
    const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
    await navigation.getByRole('link', { name: 'Zespół' }).click()
    await expect(page.getByRole('button', { name: 'Dodaj specjalistkę' })).toBeVisible()

    await navigation.getByRole('link', { name: 'Ustawienia' }).click()
    await page.getByRole('navigation', { name: 'Sekcje ustawień' }).getByRole('button', { name: 'Zespół i stawki' }).click()
    const teamSettings = page.getByRole('form', { name: 'Zespół i stawki' })
    await expect(teamSettings.getByRole('button', { name: 'Dodaj specjalistkę' })).toHaveCount(0)
    await teamSettings.getByRole('link', { name: 'Zarządzaj zespołem' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Zespół centrum' })).toBeVisible()
  })

  test('TUS and Team fit narrow screens and keep assignment, filters, and card actions touchable', async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      hasTouch: true,
      viewport: { width: 320, height: 844 },
    })
    const page = await context.newPage()

    try {
      await freezeTime(page, '2026-07-14T10:30:00')
      await login(page)
      const bottomNavigation = page.getByRole('navigation', { name: 'Nawigacja dolna' })

      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 })
        await bottomNavigation.getByRole('link', { name: 'TUS', exact: true }).click()
        await expectNoHorizontalPageOverflow(page)
        const search = page.getByPlaceholder('Dziecko, rodzic lub grupa…')
        await search.fill('Borys Cygan')
        await expectNoHorizontalPageOverflow(page)
        const assignment = page.getByRole('button', { name: 'Przypisz dziecko — Borys Cygan' })
        const assignmentBox = await assignment.boundingBox()
        expect(assignmentBox.height).toBeGreaterThanOrEqual(44)
        await assignment.click()
        await expectNoHorizontalPageOverflow(page)
        await page.getByRole('dialog', { name: 'Przypisz do grupy — Borys Cygan' }).getByRole('button', { name: 'Zamknij' }).click()

        await openPhoneDestination(page, 'Zespół')
        await page.getByRole('button', { name: /^Filtry/ }).click()
        await expectNoHorizontalPageOverflow(page)
        const filter = page.getByRole('group', { name: 'Obłożenie' }).getByRole('button', { name: 'Cały zespół' })
        const clients = page.getByRole('link', { name: /^Klienci —/ }).first()
        const filterHit = await filter.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const ownsPoint = (y) => {
            const hit = document.elementFromPoint(rect.left + rect.width / 2, y)
            return hit === element || element.contains(hit)
          }
          return {
            hitHeight: parseFloat(getComputedStyle(element, '::after').height),
            top: ownsPoint(rect.top - 4.5),
            bottom: ownsPoint(rect.bottom + 4.5),
          }
        })
        expect(filterHit.hitHeight).toBeGreaterThanOrEqual(44)
        expect(filterHit.top).toBe(true)
        expect(filterHit.bottom).toBe(true)
        expect((await clients.boundingBox()).height).toBeGreaterThanOrEqual(44)
      }
    } finally {
      await context.close()
    }
  })
})

test('browser back/forward walk views and hash edits navigate', async ({ page }) => {
  await login(page)
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  const clientsHeading = page.getByRole('heading', { level: 1, name: /Klienci/ })
  const calendarHeading = page.getByRole('heading', { level: 1, name: /Kalendarz/ })

  await navigation.getByRole('link', { name: 'Klienci' }).click()
  await expect(clientsHeading).toBeVisible()
  await navigation.getByRole('link', { name: 'Kalendarz' }).click()
  await expect(calendarHeading).toBeVisible()

  await page.goBack()
  await expect(clientsHeading).toBeVisible()
  await expect(page).toHaveURL(/#\/clients/)

  await page.goForward()
  await expect(calendarHeading).toBeVisible()
  await expect(page).toHaveURL(/#\/calendar/)

  // manual hash edit while the app is open navigates as well
  await page.evaluate(() => { window.location.hash = '#/clients' })
  await expect(clientsHeading).toBeVisible()
})

test('payments scope syncs to the URL and restores from history', async ({ page }) => {
  await login(page)
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await navigation.getByRole('link', { name: 'Finanse' }).click()
  await expect(page).toHaveURL(/#\/payments\?.*ym=\d{4}-\d{2}/)

  const anna = page.getByRole('group', { name: 'Specjalistka' }).getByRole('button', { name: 'Anna' })
  await anna.click()
  await expect(page).toHaveURL(/specialist=p\d/)
  await expect(anna).toHaveAttribute('aria-pressed', 'true')

  await navigation.getByRole('link', { name: 'Dziś' }).click()
  await expect(page).toHaveURL(/#\/dashboard/)

  await page.goBack()
  await expect(page).toHaveURL(/#\/payments\?.*specialist=p\d/)
  await expect(page.getByRole('heading', { level: 1, name: /Finanse/ })).toBeVisible()
  await expect(
    page.getByRole('group', { name: 'Specjalistka' }).getByRole('button', { name: 'Anna' })
  ).toHaveAttribute('aria-pressed', 'true')
})

test('dirty forms confirm before discarding — drawer and settings drafts', async ({ page }) => {
  await login(page)
  const newSession = page.getByRole('button', { name: 'Nowa sesja' }).first()

  // a clean drawer closes without asking
  await newSession.click()
  const drawer = page.getByRole('dialog', { name: 'Nowa sesja' })
  await drawer.getByRole('button', { name: 'Anuluj' }).click()
  await expect(drawer).toBeHidden()

  // a dirty drawer warns first; "Wróć" keeps editing, "Odrzuć" discards
  await newSession.click()
  await drawer.getByLabel('Godzina').fill('13:30')
  await drawer.getByRole('button', { name: 'Anuluj' }).click()
  await expect(drawer.getByRole('alert')).toContainText('Masz niezapisane zmiany')
  await drawer.getByRole('button', { name: 'Wróć' }).click()
  await expect(drawer).toBeVisible()
  await drawer.getByRole('button', { name: 'Anuluj' }).click()
  await drawer.getByRole('button', { name: 'Odrzuć' }).click()
  await expect(drawer).toBeHidden()

  // a dirty settings draft blocks navigation until confirmed
  const navigation = page.getByRole('navigation', { name: 'Nawigacja główna' })
  await navigation.getByRole('link', { name: 'Ustawienia' }).click()
  await page.getByLabel('Imię i nazwisko').fill('Anna Maria Janowska-Kowalska')
  await navigation.getByRole('link', { name: 'Kalendarz' }).click()
  const leaveDialog = page.getByRole('alertdialog')
  await expect(leaveDialog).toContainText('Niezapisane zmiany')
  await leaveDialog.getByRole('button', { name: 'Kontynuuj edycję' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /Ustawienia/ })).toBeVisible()
  await navigation.getByRole('link', { name: 'Kalendarz' }).click()
  await leaveDialog.getByRole('button', { name: 'Odrzuć i wyjdź' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /Kalendarz/ })).toBeVisible()
})
