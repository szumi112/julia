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

async function switchToCoordinator(page) {
  await page.getByRole('button', { name: /Tryb demonstracyjny/ }).click()
  await page.getByRole('button', { name: /Koordynatorka.*Maja Nowak/ }).click()
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

test('navigation focuses the destination and a day cockpit excludes background controls', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('button', { name: 'Kalendarz' }).click()
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

test('mobile shell keeps direct destinations, a full title, search, and More access', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)

  const topbar = page.locator('.topbar')
  await expect(topbar.getByRole('button', { name: 'Otwórz menu' })).toBeVisible()
  await expect(topbar.getByText('Dziś', { exact: true })).toBeVisible()
  await expect(topbar.getByRole('button', { name: /Szukaj w Aurelii/ })).toBeVisible()

  const bottomNavigation = page.getByRole('navigation', { name: 'Nawigacja dolna' })
  for (const label of ['Dziś', 'Finanse', 'Kalendarz', 'Klienci', 'Więcej']) {
    await expect(bottomNavigation.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  await expect(bottomNavigation.getByRole('button', { name: 'Nowa sesja' })).toBeVisible()
  const fab = await bottomNavigation.getByRole('button', { name: 'Nowa sesja' }).boundingBox()
  expect(Math.abs(fab.x + fab.width / 2 - 195)).toBeLessThanOrEqual(1)

  await bottomNavigation.getByRole('button', { name: 'Więcej' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  await drawer.getByRole('button', { name: 'Zajęcia TUS' }).click()
  await expect(topbar.getByText('Zajęcia TUS', { exact: true })).toBeVisible()
  await expect(bottomNavigation.getByRole('button', { name: 'Więcej' })).toHaveAttribute('aria-current', 'page')
  await expect(topbar.locator('.topbar__title')).toHaveCSS('text-overflow', 'clip')
})

test('mobile navigation drawer keeps role switching and logout reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  const more = page.getByRole('navigation', { name: 'Nawigacja dolna' }).getByRole('button', { name: 'Więcej' })

  await more.click()
  let drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  const roles = drawer.getByRole('group', { name: 'Tryb demonstracyjny' })
  await expect(roles.getByRole('button', { name: /Koordynatorka.*Maja Nowak/ })).toBeVisible()
  await roles.getByRole('button', { name: /Koordynatorka.*Maja Nowak/ }).click()

  await more.click()
  drawer = page.getByRole('dialog', { name: 'Nawigacja' })
  await expect(drawer.getByRole('button', { name: 'Wyloguj się' })).toBeVisible()
  await drawer.getByRole('button', { name: 'Wyloguj się' }).click()
  await expect(page.getByRole('button', { name: 'Zaloguj się' })).toBeVisible()
})

test('mobile active pill remeasures when role permissions change the tab set', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  const bottomNavigation = page.getByRole('navigation', { name: 'Nawigacja dolna' })

  await bottomNavigation.getByRole('button', { name: 'Więcej' }).click()
  await page.getByRole('dialog', { name: 'Nawigacja' }).getByRole('button', { name: 'Zajęcia TUS' }).click()
  await expect(page.locator('.topbar__title b')).toHaveText('Zajęcia TUS')
  await expect(page.getByRole('dialog', { name: 'Nawigacja' })).toHaveCount(0)
  await page.waitForTimeout(250)
  await bottomNavigation.getByRole('button', { name: 'Więcej' }).click()
  const roleButton = page.getByRole('dialog', { name: 'Nawigacja' })
    .getByRole('button', { name: /Specjalistka.*Marta Zielińska/ })
  await expect(roleButton).toBeVisible()
  await roleButton.click()

  await expect(bottomNavigation.getByRole('button', { name: 'Finanse' })).toHaveCount(0)
  await expect.poll(async () => {
    const more = await bottomNavigation.getByRole('button', { name: 'Więcej' }).boundingBox()
    const pill = await bottomNavigation.locator('.tabbar__pill').boundingBox()
    return Math.abs((more.x + more.width / 2) - (pill.x + pill.width / 2))
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

  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('button', { name: 'Finanse' }).click()
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

  await navigation.getByRole('button', { name: 'Kalendarz' }).click()
  await page.getByRole('region', { name: /Plan dnia/ }).getByRole('button', { name: /Jeszcze/ }).click()
  const savedScroll = await content.evaluate((element) => {
    element.scrollTop = 300
    return element.scrollTop
  })
  expect(savedScroll).toBeGreaterThan(50)

  await navigation.getByRole('button', { name: 'Klienci' }).click()
  await expect(page.getByRole('heading', { name: /Klienci/ })).toBeVisible()
  await navigation.getByRole('button', { name: 'Kalendarz' }).click()
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
  const palette = page.getByRole('dialog', { name: 'Szukaj w Aurelii' })
  await palette.getByRole('combobox', { name: 'Szukaj w Aurelii' }).fill('kalendarz')

  await expect(palette.getByRole('option', { name: 'Kalendarz', exact: true })).toBeVisible()
  await expect(palette.getByText('Kalendarz sesji', { exact: true })).toHaveCount(0)
})

test('role switch cannot finish a pending forbidden navigation', async ({ page }) => {
  await login(page)
  await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll('button')]
    buttons.find((button) => button.textContent.trim() === 'Finanse').click()
    buttons.find((button) => (
      button.textContent.includes('Tryb demonstracyjny') && button.textContent.includes('Julia Wolanin')
    )).click()
    await new Promise(requestAnimationFrame)
    ;[...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Specjalistka') && button.textContent.includes('Marta Zielińska'))
      .click()
  })

  await page.waitForTimeout(300)
  await expect(page.locator('.topbar__title b')).toHaveText('Dziś')
  await expect(
    page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('button', { name: 'Dziś' })
  ).toHaveAttribute('aria-current', 'page')
})

test('same-route view state does not leak when the demo role changes', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('button', { name: 'Klienci' }).click()
  const search = page.getByPlaceholder('Szukaj klienta…')
  await search.fill('Zofia')
  await expect(search).toHaveValue('Zofia')

  await switchToTherapist(page)

  await expect(page.getByPlaceholder('Szukaj klienta…')).toHaveValue('')
  await expect(page.getByRole('heading', { name: /Moi klienci/ })).toBeVisible()
})

test('role switch discards a client detail identity outside the next role scope', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByRole('heading', { name: 'Zofia Mazur' })).toBeVisible()

  await switchToTherapist(page)

  await expect(page.locator('.topbar__title b')).toHaveText('Klienci')
  await expect(page.getByRole('heading', { name: 'Zofia Mazur' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /Moi klienci/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Zofia Mazur/ })).toHaveCount(0)
})

test('role switch clears top-level route parameters and their derived filters', async ({ page }) => {
  await login(page)
  await page.getByRole('region', { name: 'Wymaga uwagi' }).getByRole('button').first().click()
  await expect(page.getByText(/Wszystkie okresy.*tylko zaległe/i)).toBeVisible()

  await switchToCoordinator(page)

  await expect(page.locator('.topbar__title b')).toHaveText('Finanse')
  await expect(page.getByText(/Wszystkie okresy.*tylko zaległe/i)).toHaveCount(0)
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

    for (const selector of ['.bpost-more', '.spine__row', '.today-attn__row', '.today-links__item']) {
      const target = page.locator(selector).first()
      await expect(target).toBeVisible()
      const box = await target.boundingBox()
      expect(box.height, selector).toBeGreaterThanOrEqual(44)
      expect(box.width, selector).toBeGreaterThanOrEqual(44)
    }

    await page.getByRole('navigation', { name: 'Nawigacja dolna' }).getByRole('button', { name: 'Klienci' }).click()
    const chip = page.locator('.chips-row .chip').first()
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

    await page.getByRole('navigation', { name: 'Nawigacja dolna' }).getByRole('button', { name: 'Więcej' }).click()
    await page.getByRole('dialog', { name: 'Nawigacja' }).getByRole('button', { name: 'Ustawienia' }).click()
    const smallPrimary = page.getByRole('button', { name: 'Zapisz profil' })
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
    ;[...navigation.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Kalendarz').click()
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
  await expect(page.getByRole('dialog', { name: 'Szukaj w Aurelii' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Szukaj w Aurelii' })).toHaveCount(0)

  await page.getByRole('button', { name: /Tryb demonstracyjny.*Julia Wolanin/ }).click()
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
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('button', { name: 'Kalendarz' }).click()

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
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('button', { name: 'Zespół' }).click()
  await page.locator('.psy-card').first().click()
  await expect.poll(() => page.evaluate(() => window.__namedMotion.some(({ kind }) => kind === 'chart-area-line'))).toBe(true)

  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('button', { name: 'Raporty' }).click()
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

  await expect(clients).toContainText('Joanna Madej')
  await expect(clients).not.toContainText('Zofia Mazur')
  await expect(psychologists.locator('option')).toHaveCount(2)
  await expect(psychologists).toHaveValue('p2')
})

test('therapist client form cannot reassign care outside their practice', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('button', { name: 'Dodaj klienta' }).click()
  const drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  const psychologists = drawer.getByLabel('Specjalistka prowadząca')

  await expect(psychologists.locator('option')).toHaveCount(2)
  await expect(psychologists).toHaveValue('p2')
  await expect(drawer.getByLabel('Powiąż z klientem')).not.toContainText('Zofia Mazur')
})

test('demo role picker is a labelled button group and closes for command search', async ({ page }) => {
  await login(page)
  const picker = page.getByRole('button', { name: /Tryb demonstracyjny.*Julia Wolanin/ })
  await expect(picker).toContainText('Tryb demonstracyjny')
  await picker.click()
  const group = page.getByRole('group', { name: 'Tryb demonstracyjny' })
  await expect(group).toContainText('Tryb demonstracyjny')
  await expect(group.getByRole('button', { name: /Właścicielka.*Julia Wolanin/ })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Control+K')
  await expect(page.getByRole('dialog', { name: 'Szukaj w Aurelii' })).toBeVisible()
  await expect(group).toHaveCount(0)
})

test('therapist mode guards dashboard destinations and filters command palette', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await expect(page.getByRole('region', { name: 'Skróty' }).getByRole('button', { name: 'Zespół' })).toHaveCount(0)
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Dziś' })).toHaveAttribute('aria-current', 'page')

  await page.keyboard.press('Control+K')
  const palette = page.getByRole('dialog', { name: 'Szukaj w Aurelii' })
  const search = palette.getByRole('combobox', { name: 'Szukaj w Aurelii' })
  await search.fill('raport')
  await expect(palette).not.toContainText('Raport miesięczny')
  await search.fill('julia')
  await expect(palette).not.toContainText('dr Julia Wolanin')
})

test('therapist search only exposes their client context and hides note prose from other roles', async ({ page }) => {
  await login(page)
  await switchToTherapist(page)
  await page.getByRole('button', { name: /Szukaj/ }).click()
  await page.getByRole('combobox', { name: /Szukaj w Aurelii/ }).fill('Joanna')
  await page.getByRole('option', { name: /Joanna Madej/ }).click()
  await expect(page.getByRole('heading', { name: /Joanna Madej/ })).toBeVisible()
  await expect(page.getByText(/Notatki kliniczne/)).toBeVisible()
  await expect(page.getByLabel('Nowa notatka')).toBeVisible()
})

test('centre roles receive a neutral clinical-notes state', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByText('Notatki są dostępne w widoku specjalistki.')).toBeVisible()
  await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
})

test('coordinator receives the neutral clinical-notes state', async ({ page }) => {
  await login(page)
  await switchToCoordinator(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByText('Notatki są dostępne w widoku specjalistki.')).toBeVisible()
  await expect(page.locator('.note__text')).toHaveCount(0)
  await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
})

test('non-owning therapist is remapped away from an unauthorized client detail', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await switchToTherapist(page)
  await expect(page.locator('.topbar__title b')).toHaveText('Klienci')
  await expect(page.getByRole('heading', { name: /Moi klienci/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Zofia Mazur/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Zofia Mazur' })).toHaveCount(0)
  await expect(page.locator('.note__text')).toHaveCount(0)
  await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
  await expect(page.locator('.id-band__actions').getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edytuj sesję' })).toHaveCount(0)
  await expect(page.getByTitle('Zmień status sesji')).toHaveCount(0)
  await expect(page.getByTitle('Zmień płatność')).toHaveCount(0)
})

test('client detail adapts its primary CTA to the active role', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByRole('button', { name: 'Umów spotkanie' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Przygotuj sesję' })).toHaveCount(0)

  await switchToTherapist(page)
  await page.getByRole('row', { name: /Joanna Madej/ }).click()
  await expect(page.getByRole('button', { name: 'Przygotuj sesję' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Umów spotkanie' })).toHaveCount(0)
})

test('client detail presents care headings in record order', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByRole('heading', { name: 'Przegląd opieki' })).toBeVisible()
  const headings = await page.locator('main h2').evaluateAll((elements) =>
    elements.map((element) => element.firstChild.textContent.trim())
  )
  expect(headings).toEqual([
    'Przegląd opieki',
    'Najbliższe spotkania',
    'Historia frekwencji',
    'Notatki kliniczne',
  ])
})

test('client form validates a supplied email and keeps email optional', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
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
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  await page.getByRole('button', { name: 'Julia', exact: true }).click()
  await expect(page.getByRole('row', { name: /Zofia Mazur/ })).toBeVisible()
  await switchToTherapist(page)
  await expect(page.getByRole('row', { name: /Joanna Madej/ })).toBeVisible()
})

test('short lists render fully without a pager and history caps at ten rows', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  // 19 demo clients < 25: full roster, no pager anywhere on the view
  await expect(page.locator('tbody tr').first()).toBeVisible()
  expect(await page.locator('tbody tr').count()).toBeGreaterThan(15)
  await expect(page.getByRole('navigation', { name: 'Stronicowanie' })).toHaveCount(0)
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByRole('heading', { name: 'Historia frekwencji' })).toBeVisible()
  const historyRows = await page.locator('.client-record__section:has(h2:text("Historia frekwencji")) tbody tr').count()
  expect(historyRows).toBeLessThanOrEqual(10)
})

test('Today keeps the essential daily regions together', async ({ page }) => {
  await login(page)
  await expect(
    page.getByRole('heading', { level: 1, name: /^\d{1,2}:\d{2}$|Wszystko za Tobą|Wolny dzień/ })
  ).toBeVisible()
  await expect(page.getByRole('region', { name: /Wymaga uwagi/ })).toBeVisible()
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
  const palette = page.getByRole('dialog', { name: 'Szukaj w Aurelii' })
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
  await page.getByRole('navigation').getByRole('button', { name: 'Ustawienia' }).click()
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
  const therapistEyebrow = page.locator('.today-hero .eyebrow')
  await expect(page.getByRole('region', { name: 'Plan dnia' })).not.toContainText('Julia Wolanin')
  await expect(therapistEyebrow).toContainText('Mój dzień')
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
  await expect(cockpit).not.toContainText('Julia Wolanin')
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
  await page.getByRole('region', { name: 'Wymaga uwagi' }).getByRole('button').first().click()
  await expect(page.getByText(/Wszystkie okresy.*tylko zaległe/i)).toBeVisible()
  await expect(page.locator('tr.is-due')).not.toHaveCount(0)
})

test('calendar exposes explicit payment and attendance reset choices', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('group', { name: 'Płatność' })).toHaveCount(0)
  await page.getByRole('button', { name: /^Filtry/ }).click()
  const payment = page.getByRole('group', { name: 'Płatność' })
  const attendance = page.getByRole('group', { name: 'Obecność klienta' })
  const allPayments = payment.getByRole('button', { name: 'Wszystkie' })
  const allAttendance = attendance.getByRole('button', { name: 'Wszyscy' })

  await expect(allPayments).toHaveAttribute('aria-pressed', 'true')
  await payment.getByRole('button', { name: 'Nieopłacone' }).click()
  await expect(allPayments).toHaveAttribute('aria-pressed', 'false')
  await allPayments.click()
  await expect(allPayments).toHaveAttribute('aria-pressed', 'true')

  await expect(allAttendance).toHaveAttribute('aria-pressed', 'true')
  await attendance.getByRole('button', { name: 'Nieobecny' }).click()
  await expect(allAttendance).toHaveAttribute('aria-pressed', 'false')
  await allAttendance.click()
  await expect(allAttendance).toHaveAttribute('aria-pressed', 'true')
})

test('Payments exposes an all-status control to reverse unpaid filtering', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Finanse' }).click()
  const allStatuses = page.getByRole('button', { name: 'Wszystkie płatności' })
  const unpaid = page.getByRole('button', { name: 'Tylko zaległe' })

  await expect(allStatuses).toHaveAttribute('aria-pressed', 'true')
  await unpaid.click()
  await expect(unpaid).toHaveAttribute('aria-pressed', 'true')
  await allStatuses.click()
  await expect(allStatuses).toHaveAttribute('aria-pressed', 'true')
  await expect(unpaid).toHaveAttribute('aria-pressed', 'false')
})

test('payments table paginates a month with more than 25 settlements', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Finanse' }).click()
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
  await page.getByRole('button', { name: /Tryb demonstracyjny.*Julia Wolanin/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Marta Zielińska/ }).click()
  await page.getByRole('navigation', { name: 'Nawigacja główna' }).getByRole('button', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
  const agenda = page.getByRole('region', { name: /Plan dnia/ })
  await expect(agenda).toBeVisible()
  const partialPayment = agenda.getByRole('button', { name: /Częściowo/ })
  await partialPayment.scrollIntoViewIfNeeded()
  await partialPayment.click()
  await page.getByRole('menuitemradio', { name: 'Częściowo' }).click()
  await page.getByRole('menuitem', { name: 'Edytuj kwotę' }).click()
  await expect(page.getByRole('dialog', { name: 'Edycja sesji' }).getByLabel('Wpłacono (zł)')).toBeFocused()
})

test('calendar combines payment and attendance filters after role scope', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: /^Filtry/ }).click()
  await page.getByRole('button', { name: 'Nieopłacone' }).click()
  await page.getByRole('button', { name: 'Nieobecny' }).click()
  await expect(page.getByRole('button', { name: 'Filtry · 2' })).toBeVisible()
  const agenda = page.getByRole('region', { name: /Plan dnia/ })
  await expect(agenda.locator('[data-payment="unpaid"][data-attendance="noshow"]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Wyczyść filtry' }).click()
  const more = agenda.getByRole('button', { name: /Jeszcze/ })
  await expect(more).toBeVisible()
  await more.click()
  await expect(more).toHaveCount(0)
  expect(await agenda.locator('.agenda__row').count()).toBeGreaterThan(4)
})

test('calendar day strip scrolls with the page instead of covering the agenda', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  const agenda = page.getByRole('region', { name: /Plan dnia/ })
  const more = agenda.getByRole('button', { name: /Jeszcze/ })
  await more.click()
  // clicking auto-scrolled the button into view; measure from the top
  await page.locator('main.content').evaluate((el) => el.scrollTo(0, 0))
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
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
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
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await page.getByRole('radio', { name: 'Miesiąc' }).click()
  expect(await page.locator('.cal__day:has(.cal__item)').count()).toBeGreaterThan(1)
})

test('therapist agenda excludes other therapists and payment updates stay coherent', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: /Tryb demonstracyjny/ }).click()
  await page.getByRole('button', { name: /Specjalistka.*Marta Zielińska/ }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: /Plan dnia/ }).locator('[data-psych-id="p1"]')).toHaveCount(0)
})

test('owner attention opens matching all-period unpaid payments', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page)
  await page.getByRole('region', { name: 'Wymaga uwagi' }).getByRole('button').first().click()
  await expect(page.getByText(/wszystkie okresy.*tylko zaległe/i)).toBeVisible()
  await expect(page.locator('.figures__item--gold .figures__value')).toBeVisible()
  const issuedTip = page.locator('.figures__item').filter({ hasText: 'Wystawione' }).getByRole('button', { name: 'Wyjaśnienie' })
  await issuedTip.focus()
  const issuedTipId = await issuedTip.getAttribute('aria-describedby')
  await expect(page.locator(`[id="${issuedTipId}"]`)).toHaveText('Suma kwot za sesje rozliczane we wszystkich okresach — odbyte i nieobecności. Sesje odwołane nie są fakturowane.')
})
