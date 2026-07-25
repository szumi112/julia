# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace.spec.js >> Today keeps the page itself fixed on a short desktop viewport
- Location: tests/e2e/workspace.spec.js:892:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: false
Received: true
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - link "Przejdź do treści" [ref=e3] [cursor=pointer]:
    - /url: "#main-content"
  - generic [ref=e4]:
    - complementary [ref=e5]:
      - generic [ref=e7]:
        - img [ref=e8]
        - generic [ref=e17]:
          - text: Aurelia
          - generic [ref=e18]: Centrum Psychoterapii
      - navigation "Nawigacja główna" [ref=e19]:
        - link "Dziś" [ref=e21] [cursor=pointer]:
          - /url: "#/dashboard"
          - img [ref=e22]
          - text: Dziś
        - link "Kalendarz" [ref=e27] [cursor=pointer]:
          - /url: "#/calendar"
          - img [ref=e28]
          - text: Kalendarz
        - link "Klienci" [ref=e32] [cursor=pointer]:
          - /url: "#/clients"
          - img [ref=e33]
          - text: Klienci
        - link "Zajęcia TUS" [ref=e38] [cursor=pointer]:
          - /url: "#/tus"
          - img [ref=e39]
          - text: Zajęcia TUS
        - link "Zespół" [ref=e46] [cursor=pointer]:
          - /url: "#/team"
          - img [ref=e47]
          - text: Zespół
        - link "Finanse" [ref=e52] [cursor=pointer]:
          - /url: "#/payments"
          - img [ref=e53]
          - text: Finanse
        - link "Raporty" [ref=e57] [cursor=pointer]:
          - /url: "#/reports"
          - img [ref=e58]
          - text: Raporty
        - link "Ustawienia" [ref=e61] [cursor=pointer]:
          - /url: "#/settings"
          - img [ref=e62]
          - text: Ustawienia
      - generic [ref=e67]:
        - generic [ref=e68]: Dziś · czwartek
        - generic [ref=e69]: 8 sesji w grafiku
        - generic [ref=e70]: Weź głęboki oddech 🌿
    - generic [ref=e71]:
      - banner [ref=e72]:
        - generic [ref=e73]:
          - generic [ref=e74]: Aurelia /
          - text: Dziś
        - generic [ref=e75]:
          - generic [ref=e76]:
            - button "Szukaj… ⌘ K" [ref=e77] [cursor=pointer]:
              - img [ref=e78]
              - generic [ref=e81]: Szukaj…
              - generic [ref=e82]: ⌘ K
            - button "Tryb demonstracyjny Julia Wolanin Właścicielka" [ref=e84] [cursor=pointer]:
              - generic [ref=e85]: JW
              - generic [ref=e86]:
                - generic [ref=e87]: Tryb demonstracyjny
                - text: Julia Wolanin
                - generic [ref=e88]: Właścicielka
            - button "Wyloguj się" [ref=e89] [cursor=pointer]:
              - img [ref=e90]
          - 'button "Panel dnia: za 6 h 29 min · 08:00" [ref=e93] [cursor=pointer]':
            - generic [ref=e95]: za 6 h 29 min · 08:00
            - img [ref=e96]
      - main [ref=e98]:
        - region "Pulpit dnia" [ref=e100]:
          - generic [ref=e101]:
            - paragraph [ref=e102]:
              - generic [ref=e103]: Aurelia
              - text: · Pulpit dnia · Tydzień 30
            - heading "czwartek" [level=1] [ref=e104]
            - paragraph [ref=e105]: 23 lipca 2026 · 3 z 8 sesji za Tobą
            - separator [ref=e106]
            - paragraph [ref=e107]: Następna sesja
            - paragraph [ref=e108]: 08:00
            - paragraph [ref=e109]: Oliwia Mróz
            - paragraph [ref=e110]: Gabinet 3 · Karolina Wójcik
            - generic [ref=e111]:
              - button "Otwórz sesję" [ref=e112] [cursor=pointer]:
                - generic [ref=e113]: Otwórz sesję
              - button "Nowa sesja" [ref=e114] [cursor=pointer]:
                - img [ref=e115]
                - generic [ref=e117]: Nowa sesja
              - button "Nowy klient" [ref=e118] [cursor=pointer]
          - region "Podsumowanie dnia" [ref=e119]:
            - heading "Podsumowanie dnia" [level=2] [ref=e120]
            - generic [ref=e121]: Odbyte 3
            - generic [ref=e122]: Nieobecności 1
            - generic [ref=e123]: Pozostałe 4
          - separator [ref=e124]
          - region "Plan dnia":
            - generic [ref=e126]:
              - button "08:00 Oliwia Mróz Zaplanowana · Następna sesja" [ref=e128] [cursor=pointer]:
                - generic [ref=e129]: 08:00
                - generic [ref=e130]: Oliwia Mróz
                - generic [ref=e131]: Zaplanowana · Następna sesja
              - generic [ref=e132]: Jeszcze dziś
              - button "10:00 Anna i Paweł Romanowscy Zaplanowana" [ref=e133] [cursor=pointer]:
                - generic [ref=e134]: 10:00
                - generic [ref=e135]: Anna i Paweł Romanowscy
                - generic [ref=e136]: Zaplanowana
              - button "13:00 Zofia Mazur Zaplanowana" [ref=e137] [cursor=pointer]:
                - generic [ref=e138]: 13:00
                - generic [ref=e139]: Zofia Mazur
                - generic [ref=e140]: Zaplanowana
              - button "14:00 Tomasz Bąk Zaplanowana" [ref=e141] [cursor=pointer]:
                - generic [ref=e142]: 14:00
                - generic [ref=e143]: Tomasz Bąk
                - generic [ref=e144]: Zaplanowana
              - generic [ref=e145]: Nieobecności
              - button "13:00 Natalia Górska Nieobecność" [ref=e146] [cursor=pointer]:
                - generic [ref=e147]: 13:00
                - generic [ref=e148]: Natalia Górska
                - generic [ref=e149]: Nieobecność
              - button "Odbyte (3)" [ref=e151] [cursor=pointer]
          - region "Wymaga uwagi" [ref=e152]:
            - link "Bartosz Sikora · zaległa płatność 270 zł" [ref=e153] [cursor=pointer]:
              - /url: "#/payments?allPeriods=true&unpaidOnly=true"
              - img [ref=e154]
              - generic [ref=e158]: Bartosz Sikora · zaległa płatność 270 zł
              - img [ref=e159]
            - link "Bartosz Sikora · zaległa płatność 270 zł" [ref=e161] [cursor=pointer]:
              - /url: "#/payments?allPeriods=true&unpaidOnly=true"
              - img [ref=e162]
              - generic [ref=e166]: Bartosz Sikora · zaległa płatność 270 zł
              - img [ref=e167]
          - separator [ref=e169]
          - region "Skróty" [ref=e170]:
            - link "Kalendarz" [ref=e171] [cursor=pointer]:
              - /url: "#/calendar"
            - link "Klienci" [ref=e172] [cursor=pointer]:
              - /url: "#/clients"
            - button "Tablica zespołu" [ref=e173] [cursor=pointer]
            - link "Zajęcia TUS" [ref=e174] [cursor=pointer]:
              - /url: "#/tus"
  - generic [ref=e175]: Dziś
```

# Test source

```ts
  799 | })
  800 | 
  801 | test('client detail presents care sections in record order, h1 first', async ({ page }) => {
  802 |   await login(page)
  803 |   await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  804 |   await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  805 |   // "Przegląd opieki" is the first section heading — the client name (h1)
  806 |   // must still precede every section heading in the outline
  807 |   await expect(page.locator('#care-overview-title')).toHaveText('Przegląd opieki')
  808 |   const headings = await page.locator('main h2').evaluateAll((elements) =>
  809 |     elements.map((element) => element.firstChild.textContent.trim())
  810 |   )
  811 |   expect(headings).toEqual([
  812 |     'Przegląd opieki',
  813 |     'Najbliższe spotkania',
  814 |     'Historia frekwencji',
  815 |     'Notatki kliniczne',
  816 |   ])
  817 |   const h1Precedes = await page.evaluate(() => {
  818 |     const h1 = document.querySelector('main h1')
  819 |     const firstH2 = document.querySelector('main h2')
  820 |     return Boolean(h1.compareDocumentPosition(firstH2) & Node.DOCUMENT_POSITION_FOLLOWING)
  821 |   })
  822 |   expect(h1Precedes).toBe(true)
  823 | })
  824 | 
  825 | test('client form validates a supplied email and keeps email optional', async ({ page }) => {
  826 |   await login(page)
  827 |   await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  828 |   await page.getByRole('button', { name: 'Dodaj klienta' }).click()
  829 |   const drawer = page.getByRole('dialog', { name: 'Nowy klient' })
  830 |   await drawer.getByLabel('Imię i nazwisko').fill('Testowa osoba')
  831 |   await drawer.getByLabel('Specjalistka prowadząca').selectOption('p1')
  832 |   await drawer.getByLabel('E-mail').fill('niepoprawny-adres')
  833 |   await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  834 |   await expect(drawer.getByText('Podaj poprawny adres e-mail')).toBeVisible()
  835 |   await drawer.getByLabel('E-mail').fill('')
  836 |   await drawer.getByRole('button', { name: 'Dodaj klienta' }).click()
  837 |   await expect(drawer).toHaveCount(0)
  838 | })
  839 | 
  840 | test('switching to therapist ignores a previous team client filter', async ({ page }) => {
  841 |   await login(page)
  842 |   await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  843 |   await page.getByRole('button', { name: 'Julia', exact: true }).click()
  844 |   await expect(page.getByRole('row', { name: /Zofia Mazur/ })).toBeVisible()
  845 |   await switchToTherapist(page)
  846 |   await expect(page.getByRole('row', { name: /Joanna Madej/ })).toBeVisible()
  847 | })
  848 | 
  849 | test('short lists render fully without a pager and history caps at ten rows', async ({ page }) => {
  850 |   await login(page)
  851 |   await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  852 |   // 19 demo clients < 25: full roster, no pager anywhere on the view
  853 |   await expect(page.locator('tbody tr').first()).toBeVisible()
  854 |   expect(await page.locator('tbody tr').count()).toBeGreaterThan(15)
  855 |   await expect(page.getByRole('navigation', { name: 'Stronicowanie' })).toHaveCount(0)
  856 |   await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  857 |   await expect(page.getByRole('heading', { name: 'Historia frekwencji' })).toBeVisible()
  858 |   const historyRows = await page.locator('.client-record__section:has(h2:text("Historia frekwencji")) tbody tr').count()
  859 |   expect(historyRows).toBeLessThanOrEqual(10)
  860 | })
  861 | 
  862 | test('Today keeps the essential daily regions together', async ({ page }) => {
  863 |   await login(page)
  864 |   await expect(
  865 |     page.getByRole('heading', { level: 1, name: /^(poniedziałek|wtorek|środa|czwartek|piątek|sobota|niedziela)$/ })
  866 |   ).toBeVisible()
  867 |   await expect(page.locator('.today-hero')).toContainText(
  868 |     /\d{1,2}:\d{2}|\d+ sesji wymaga statusu|Dzień zakończony|Wolny dzień/
  869 |   )
  870 |   await expect(page.getByRole('region', { name: /Wymaga uwagi/ })).toBeVisible()
  871 |   await expect(page.getByRole('region', { name: 'Skróty' })).toBeVisible()
  872 |   await expect(page.getByRole('region', { name: 'Plan dnia' })).toBeVisible()
  873 | })
  874 | 
  875 | test('Today is a compact viewport command centre without secondary reports', async ({ page }) => {
  876 |   await login(page)
  877 |   const dashboard = page.getByRole('region', { name: 'Pulpit dnia' })
  878 | 
  879 |   await expect(dashboard).toBeVisible()
  880 |   await expect(dashboard.getByRole('region', { name: 'Dzień w skrócie' })).toHaveCount(0)
  881 |   await expect(dashboard.getByRole('region', { name: 'Skróty' })).toBeVisible()
  882 |   await expect(dashboard).not.toContainText('Przychód miesięczny')
  883 |   await expect(dashboard).not.toContainText('Najbliższe sesje')
  884 |   await expect(dashboard).not.toContainText('Zespół dziś')
  885 | 
  886 |   const contentOverflows = await page.locator('main.content').evaluate(
  887 |     (element) => element.scrollHeight > element.clientHeight + 1
  888 |   )
  889 |   expect(contentOverflows).toBe(false)
  890 | })
  891 | 
  892 | test('Today keeps the page itself fixed on a short desktop viewport', async ({ page }) => {
  893 |   await page.setViewportSize({ width: 1280, height: 600 })
  894 |   await login(page)
  895 | 
  896 |   const contentOverflows = await page.locator('main.content').evaluate(
  897 |     (element) => element.scrollHeight > element.clientHeight + 1
  898 |   )
> 899 |   expect(contentOverflows).toBe(false)
      |                            ^ Error: expect(received).toBe(expected) // Object.is equality
  900 | })
  901 | 
  902 | test('Today keeps the hero legible without horizontal overflow on a narrow phone', async ({ page }) => {
  903 |   await page.setViewportSize({ width: 360, height: 800 })
  904 |   await login(page)
  905 | 
  906 |   await expect(page.locator('.today-hero').getByRole('heading', { level: 1 })).toBeVisible()
  907 |   const overflows = await page.evaluate(
  908 |     () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  909 |   )
  910 |   expect(overflows).toBe(false)
  911 | })
  912 | 
  913 | test('team board is a Shell overlay that yields to global overlays', async ({ page }) => {
  914 |   await login(page)
  915 |   await page.getByRole('region', { name: 'Skróty' }).getByRole('button', { name: 'Tablica zespołu' }).click()
  916 |   const board = page.getByRole('dialog', { name: 'Tablica zespołu' })
  917 |   await expect(board).toBeVisible()
  918 |   const composer = board.getByLabel('Nowy wpis na tablicy')
  919 |   await composer.fill('Pierwszy wpis testowy')
  920 |   await board.getByRole('button', { name: 'Opublikuj' }).click()
  921 |   await composer.fill('Drugi wpis testowy')
  922 |   await board.getByRole('button', { name: 'Opublikuj' }).click()
  923 |   await expect(page.getByRole('main')).toHaveAttribute('inert', '')
  924 | 
  925 |   await page.keyboard.press('Control+K')
  926 |   await expect(board).toHaveCount(0)
  927 |   const palette = page.getByRole('dialog', { name: 'Szukaj w Aurelii' })
  928 |   await expect(palette).toBeVisible()
  929 | 
  930 |   await page.keyboard.press('Escape')
  931 |   await expect(palette).toHaveCount(0)
  932 |   await page.getByRole('button', { name: /Panel dnia/ }).click()
  933 |   await expect(page.getByRole('dialog', { name: 'Panel dnia' })).toBeVisible()
  934 |   await expect(board).toHaveCount(0)
  935 | })
  936 | 
  937 | test('toasts dismiss with the keyboard', async ({ page }) => {
  938 |   await login(page)
  939 |   await page.getByRole('region', { name: 'Skróty' }).getByRole('button', { name: 'Tablica zespołu' }).click()
  940 |   const board = page.getByRole('dialog', { name: 'Tablica zespołu' })
  941 |   const composer = board.getByLabel('Nowy wpis na tablicy')
  942 |   await composer.fill('Wpis do testu powiadomienia')
  943 |   await board.getByRole('button', { name: 'Opublikuj' }).click()
  944 |   const toast = page.getByRole('button', { name: /Zamknij: Wpis dodany na tablicę/ })
  945 |   await expect(toast).toBeVisible()
  946 |   await toast.focus()
  947 |   await page.keyboard.press('Enter')
  948 |   await expect(toast).toHaveCount(0)
  949 | })
  950 | 
  951 | test('enabling reduced motion clears active GSAP tweens', async ({ page }) => {
  952 |   await login(page)
  953 |   await page.getByRole('navigation').getByRole('link', { name: 'Ustawienia' }).click()
  954 |   await page.evaluate(() => {
  955 |     window.__motionProbe = { value: 0 }
  956 |     window.gsap.to(window.__motionProbe, { value: 100, duration: 5 })
  957 |   })
  958 |   await page.getByRole('switch', { name: 'Ogranicz animacje' }).click()
  959 |   await expect.poll(() => page.evaluate(() => window.gsap.globalTimeline.getChildren().length)).toBe(0)
  960 | })
  961 | 
  962 | test('Today limits daily information to the active therapist', async ({ page }) => {
  963 |   await login(page)
  964 | 
  965 |   await switchToTherapist(page)
  966 |   const therapistEyebrow = page.locator('.today-hero .eyebrow')
  967 |   await expect(page.getByRole('region', { name: 'Plan dnia' })).not.toContainText('Julia Wolanin')
  968 |   await expect(therapistEyebrow).toContainText('Mój dzień')
  969 |   await expect(page.getByText('Stan praktyki')).toHaveCount(0)
  970 | })
  971 | 
  972 | test('therapist Today omits all-team board posts and controls', async ({ page }) => {
  973 |   await login(page)
  974 |   await switchToTherapist(page)
  975 | 
  976 |   await expect(page.getByText('Tablica zespołu', { exact: true })).toHaveCount(0)
  977 |   await expect(page.getByLabel('Nowy wpis na tablicy')).toHaveCount(0)
  978 |   await expect(page.getByRole('button', { name: 'Usuń wpis' })).toHaveCount(0)
  979 |   await expect(page.getByText(/Superwizja zespołowa/)).toHaveCount(0)
  980 | })
  981 | 
  982 | test('therapist cockpit excludes centre day and finance context', async ({ page }) => {
  983 |   await login(page)
  984 |   await switchToTherapist(page)
  985 |   await page.getByRole('button', { name: /Panel dnia/ }).click()
  986 |   const cockpit = page.getByRole('dialog', { name: 'Panel dnia' })
  987 |   await expect(cockpit).toBeVisible()
  988 |   await expect(cockpit).not.toContainText('Julia Wolanin')
  989 |   await expect(cockpit).not.toContainText('Zofia Mazur')
  990 |   await expect(cockpit).not.toContainText('Zaległe płatności')
  991 |   await expect(cockpit.locator('.cockpit__due')).toHaveCount(0)
  992 | })
  993 | 
  994 | test('therapist sidebar count is scoped to their daily sessions', async ({ page }) => {
  995 |   await login(page)
  996 |   const count = page.locator('.sidebar .today-card__line')
  997 |   await expect(count).toHaveText(/sesj[ei] w grafiku|Spokojny dzień/)
  998 |   const ownerCount = await count.textContent()
  999 |   expect(ownerCount).toMatch(/sesj[ei] w grafiku|Spokojny dzień/)
```