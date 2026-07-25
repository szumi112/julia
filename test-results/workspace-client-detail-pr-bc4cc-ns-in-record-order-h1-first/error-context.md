# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace.spec.js >> client detail presents care sections in record order, h1 first
- Location: tests/e2e/workspace.spec.js:801:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
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
          - text: Karta klienta
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
        - generic [ref=e100]:
          - link "Wróć do listy klientów" [ref=e101] [cursor=pointer]:
            - /url: "#/clients"
            - img [ref=e102]
            - text: Wróć do listy klientów
          - generic [ref=e104]:
            - region "Przegląd opieki" [ref=e105]:
              - heading "Przegląd opieki" [level=2] [ref=e106]
              - generic [ref=e107]:
                - generic [ref=e108]: ZM
                - generic [ref=e109]:
                  - paragraph [ref=e110]: Karta klienta
                  - heading "Zofia Mazur" [level=1] [ref=e111]
                  - generic [ref=e112]:
                    - generic [ref=e113]:
                      - img [ref=e114]
                      - link "+48 521 172 603" [ref=e116] [cursor=pointer]:
                        - /url: tel:+48521172603
                    - generic [ref=e117]:
                      - img [ref=e118]
                      - link "zofia.mazur@gmail.com" [ref=e121] [cursor=pointer]:
                        - /url: mailto:zofia.mazur@gmail.com
                    - generic [ref=e122]: klient od 25 kwietnia 2026
                    - generic [ref=e123]: 13 sesji odbytych
                  - generic [ref=e125]: Aktywny
                - generic [ref=e127]:
                  - button "Edytuj" [ref=e128] [cursor=pointer]:
                    - img [ref=e129]
                    - generic [ref=e132]: Edytuj
                  - button "Umów spotkanie" [ref=e133] [cursor=pointer]:
                    - img [ref=e134]
                    - generic [ref=e136]: Umów spotkanie
              - generic "Podsumowanie opieki" [ref=e137]:
                - generic [ref=e138]:
                  - generic [ref=e139]: Specjalistka prowadząca
                  - link "dr Julia Wolanin" [ref=e140] [cursor=pointer]:
                    - /url: "#/psych?id=p1"
                - generic [ref=e141]:
                  - generic [ref=e142]: Następne spotkanie
                  - generic [ref=e143]: Czwartek, 23 lipca · 13:00
                - generic [ref=e144]:
                  - generic [ref=e145]: Saldo klienta
                  - generic [ref=e146]: Do rozliczenia 660 zł
                - generic [ref=e147]:
                  - generic [ref=e148]: Rodzina
                  - generic [ref=e149]: —
            - region "Najbliższe spotkania 4 sesje" [ref=e150]:
              - generic [ref=e151]:
                - heading "Najbliższe spotkania 4 sesje" [level=2] [ref=e152]:
                  - text: Najbliższe spotkania
                  - generic [ref=e153]: 4 sesje
                - generic [ref=e154]:
                  - generic [ref=e156]:
                    - generic [ref=e157]: 13:00
                    - generic [ref=e158]:
                      - link "Pokaż w kalendarzu — 23 lipca, 13:00" [ref=e159] [cursor=pointer]:
                        - /url: "#/calendar?date=2026-07-23&highlightSessionIds=s14"
                        - text: Czwartek, 23 lipca
                      - generic [ref=e160]: 50 min · 220 zł
                      - generic [ref=e161]:
                        - 'button "Status: Zaplanowana — 23 lipca, 13:00" [ref=e163] [cursor=pointer]':
                          - text: Zaplanowana
                          - img [ref=e165]
                        - 'button "Płatność: Nieopłacona — 23 lipca, 13:00" [ref=e168] [cursor=pointer]':
                          - text: Nieopłacona
                          - img [ref=e170]
                    - button "Edytuj sesję — 23 lipca, 13:00" [ref=e172] [cursor=pointer]:
                      - img [ref=e173]
                  - generic [ref=e176]:
                    - generic [ref=e177]: 13:00
                    - generic [ref=e178]:
                      - link "Pokaż w kalendarzu — 30 lipca, 13:00" [ref=e179] [cursor=pointer]:
                        - /url: "#/calendar?date=2026-07-30&highlightSessionIds=s15"
                        - text: Czwartek, 30 lipca
                      - generic [ref=e180]: 50 min · 220 zł
                      - generic [ref=e181]:
                        - 'button "Status: Zaplanowana — 30 lipca, 13:00" [ref=e183] [cursor=pointer]':
                          - text: Zaplanowana
                          - img [ref=e185]
                        - 'button "Płatność: Nieopłacona — 30 lipca, 13:00" [ref=e188] [cursor=pointer]':
                          - text: Nieopłacona
                          - img [ref=e190]
                    - button "Edytuj sesję — 30 lipca, 13:00" [ref=e192] [cursor=pointer]:
                      - img [ref=e193]
                  - generic [ref=e196]:
                    - generic [ref=e197]: 13:00
                    - generic [ref=e198]:
                      - link "Pokaż w kalendarzu — 6 sierpnia, 13:00" [ref=e199] [cursor=pointer]:
                        - /url: "#/calendar?date=2026-08-06&highlightSessionIds=s16"
                        - text: Czwartek, 6 sierpnia
                      - generic [ref=e200]: 50 min · 220 zł
                      - generic [ref=e201]:
                        - 'button "Status: Zaplanowana — 6 sierpnia, 13:00" [ref=e203] [cursor=pointer]':
                          - text: Zaplanowana
                          - img [ref=e205]
                        - 'button "Płatność: Nieopłacona — 6 sierpnia, 13:00" [ref=e208] [cursor=pointer]':
                          - text: Nieopłacona
                          - img [ref=e210]
                    - button "Edytuj sesję — 6 sierpnia, 13:00" [ref=e212] [cursor=pointer]:
                      - img [ref=e213]
                  - generic [ref=e216]:
                    - generic [ref=e217]: 13:00
                    - generic [ref=e218]:
                      - link "Pokaż w kalendarzu — 13 sierpnia, 13:00" [ref=e219] [cursor=pointer]:
                        - /url: "#/calendar?date=2026-08-13&highlightSessionIds=s17"
                        - text: Czwartek, 13 sierpnia
                      - generic [ref=e220]: 50 min · 220 zł
                      - generic [ref=e221]:
                        - 'button "Status: Zaplanowana — 13 sierpnia, 13:00" [ref=e223] [cursor=pointer]':
                          - text: Zaplanowana
                          - img [ref=e225]
                        - 'button "Płatność: Nieopłacona — 13 sierpnia, 13:00" [ref=e228] [cursor=pointer]':
                          - text: Nieopłacona
                          - img [ref=e230]
                    - button "Edytuj sesję — 13 sierpnia, 13:00" [ref=e232] [cursor=pointer]:
                      - img [ref=e233]
            - region "Historia frekwencji 14 sesji" [ref=e236]:
              - generic [ref=e237]:
                - heading "Historia frekwencji 14 sesji" [level=2] [ref=e238]:
                  - text: Historia frekwencji
                  - generic [ref=e239]: 14 sesji
                - table [ref=e241]:
                  - rowgroup [ref=e242]:
                    - row "Data Godzina Status Kwota Płatność" [ref=e243]:
                      - columnheader "Data" [ref=e244]
                      - columnheader "Godzina" [ref=e245]
                      - columnheader "Status" [ref=e246]
                      - columnheader "Kwota" [ref=e247]
                      - columnheader "Płatność" [ref=e248]
                      - columnheader [ref=e249]
                  - rowgroup [ref=e250]:
                    - 'row "23 lip 08:00 Status: Odbyta — 23 lipca, 08:00 220 zł Płatność: Opłacona — 23 lipca, 08:00 Edytuj sesję — 23 lipca, 08:00" [ref=e251]':
                      - cell "23 lip" [ref=e252]
                      - cell "08:00" [ref=e253]
                      - 'cell "Status: Odbyta — 23 lipca, 08:00" [ref=e254]':
                        - 'button "Status: Odbyta — 23 lipca, 08:00" [ref=e256] [cursor=pointer]':
                          - text: Odbyta
                          - img [ref=e258]
                      - cell "220 zł" [ref=e260]
                      - 'cell "Płatność: Opłacona — 23 lipca, 08:00" [ref=e261]':
                        - 'button "Płatność: Opłacona — 23 lipca, 08:00" [ref=e263] [cursor=pointer]':
                          - text: Opłacona
                          - img [ref=e265]
                      - cell "Edytuj sesję — 23 lipca, 08:00" [ref=e267]:
                        - button "Edytuj sesję — 23 lipca, 08:00" [ref=e268] [cursor=pointer]:
                          - img [ref=e269]
                    - 'row "16 lip 13:00 Status: Odbyta — 16 lipca, 13:00 220 zł Płatność: Opłacona — 16 lipca, 13:00 Edytuj sesję — 16 lipca, 13:00" [ref=e272]':
                      - cell "16 lip" [ref=e273]
                      - cell "13:00" [ref=e274]
                      - 'cell "Status: Odbyta — 16 lipca, 13:00" [ref=e275]':
                        - 'button "Status: Odbyta — 16 lipca, 13:00" [ref=e277] [cursor=pointer]':
                          - text: Odbyta
                          - img [ref=e279]
                      - cell "220 zł" [ref=e281]
                      - 'cell "Płatność: Opłacona — 16 lipca, 13:00" [ref=e282]':
                        - 'button "Płatność: Opłacona — 16 lipca, 13:00" [ref=e284] [cursor=pointer]':
                          - text: Opłacona
                          - img [ref=e286]
                      - cell "Edytuj sesję — 16 lipca, 13:00" [ref=e288]:
                        - button "Edytuj sesję — 16 lipca, 13:00" [ref=e289] [cursor=pointer]:
                          - img [ref=e290]
                    - 'row "9 lip 13:00 Status: Odbyta — 9 lipca, 13:00 220 zł Płatność: Opłacona — 9 lipca, 13:00 Edytuj sesję — 9 lipca, 13:00" [ref=e293]':
                      - cell "9 lip" [ref=e294]
                      - cell "13:00" [ref=e295]
                      - 'cell "Status: Odbyta — 9 lipca, 13:00" [ref=e296]':
                        - 'button "Status: Odbyta — 9 lipca, 13:00" [ref=e298] [cursor=pointer]':
                          - text: Odbyta
                          - img [ref=e300]
                      - cell "220 zł" [ref=e302]
                      - 'cell "Płatność: Opłacona — 9 lipca, 13:00" [ref=e303]':
                        - 'button "Płatność: Opłacona — 9 lipca, 13:00" [ref=e305] [cursor=pointer]':
                          - text: Opłacona
                          - img [ref=e307]
                      - cell "Edytuj sesję — 9 lipca, 13:00" [ref=e309]:
                        - button "Edytuj sesję — 9 lipca, 13:00" [ref=e310] [cursor=pointer]:
                          - img [ref=e311]
                    - 'row "2 lip 13:00 Status: Odbyta — 2 lipca, 13:00 220 zł Płatność: Częściowo opłacona — 2 lipca, 13:00 Edytuj sesję — 2 lipca, 13:00" [ref=e314]':
                      - cell "2 lip" [ref=e315]
                      - cell "13:00" [ref=e316]
                      - 'cell "Status: Odbyta — 2 lipca, 13:00" [ref=e317]':
                        - 'button "Status: Odbyta — 2 lipca, 13:00" [ref=e319] [cursor=pointer]':
                          - text: Odbyta
                          - img [ref=e321]
                      - cell "220 zł" [ref=e323]
                      - 'cell "Płatność: Częściowo opłacona — 2 lipca, 13:00" [ref=e324]':
                        - 'button "Płatność: Częściowo opłacona — 2 lipca, 13:00" [ref=e326] [cursor=pointer]':
                          - text: Częściowo opłacona · 110 zł
                          - img [ref=e328]
                      - cell "Edytuj sesję — 2 lipca, 13:00" [ref=e330]:
                        - button "Edytuj sesję — 2 lipca, 13:00" [ref=e331] [cursor=pointer]:
                          - img [ref=e332]
                    - 'row "18 cze 13:00 Status: Odbyta — 18 czerwca, 13:00 220 zł Płatność: Częściowo opłacona — 18 czerwca, 13:00 Edytuj sesję — 18 czerwca, 13:00" [ref=e335]':
                      - cell "18 cze" [ref=e336]
                      - cell "13:00" [ref=e337]
                      - 'cell "Status: Odbyta — 18 czerwca, 13:00" [ref=e338]':
                        - 'button "Status: Odbyta — 18 czerwca, 13:00" [ref=e340] [cursor=pointer]':
                          - text: Odbyta
                          - img [ref=e342]
                      - cell "220 zł" [ref=e344]
                      - 'cell "Płatność: Częściowo opłacona — 18 czerwca, 13:00" [ref=e345]':
                        - 'button "Płatność: Częściowo opłacona — 18 czerwca, 13:00" [ref=e347] [cursor=pointer]':
                          - text: Częściowo opłacona · 110 zł
                          - img [ref=e349]
                      - cell "Edytuj sesję — 18 czerwca, 13:00" [ref=e351]:
                        - button "Edytuj sesję — 18 czerwca, 13:00" [ref=e352] [cursor=pointer]:
                          - img [ref=e353]
                    - 'row "11 cze 13:00 Status: Odbyta — 11 czerwca, 13:00 220 zł Płatność: Nieopłacona — 11 czerwca, 13:00 Edytuj sesję — 11 czerwca, 13:00" [ref=e356]':
                      - cell "11 cze" [ref=e357]
                      - cell "13:00" [ref=e358]
                      - 'cell "Status: Odbyta — 11 czerwca, 13:00" [ref=e359]':
                        - 'button "Status: Odbyta — 11 czerwca, 13:00" [ref=e361] [cursor=pointer]':
                          - text: Odbyta
                          - img [ref=e363]
                      - cell "220 zł" [ref=e365]
                      - 'cell "Płatność: Nieopłacona — 11 czerwca, 13:00" [ref=e366]':
                        - 'button "Płatność: Nieopłacona — 11 czerwca, 13:00" [ref=e368] [cursor=pointer]':
                          - text: Nieopłacona
                          - img [ref=e370]
                      - cell "Edytuj sesję — 11 czerwca, 13:00" [ref=e372]:
                        - button "Edytuj sesję — 11 czerwca, 13:00" [ref=e373] [cursor=pointer]:
                          - img [ref=e374]
                    - 'row "4 cze 13:00 Status: Odbyta — 4 czerwca, 13:00 220 zł Płatność: Częściowo opłacona — 4 czerwca, 13:00 Edytuj sesję — 4 czerwca, 13:00" [ref=e377]':
                      - cell "4 cze" [ref=e378]
                      - cell "13:00" [ref=e379]
                      - 'cell "Status: Odbyta — 4 czerwca, 13:00" [ref=e380]':
                        - 'button "Status: Odbyta — 4 czerwca, 13:00" [ref=e382] [cursor=pointer]':
                          - text: Odbyta
                          - img [ref=e384]
                      - cell "220 zł" [ref=e386]
                      - 'cell "Płatność: Częściowo opłacona — 4 czerwca, 13:00" [ref=e387]':
                        - 'button "Płatność: Częściowo opłacona — 4 czerwca, 13:00" [ref=e389] [cursor=pointer]':
                          - text: Częściowo opłacona · 110 zł
                          - img [ref=e391]
                      - cell "Edytuj sesję — 4 czerwca, 13:00" [ref=e393]:
                        - button "Edytuj sesję — 4 czerwca, 13:00" [ref=e394] [cursor=pointer]:
                          - img [ref=e395]
                    - 'row "28 maj 13:00 Status: Odbyta — 28 maja, 13:00 220 zł Płatność: Opłacona — 28 maja, 13:00 Edytuj sesję — 28 maja, 13:00" [ref=e398]':
                      - cell "28 maj" [ref=e399]
                      - cell "13:00" [ref=e400]
                      - 'cell "Status: Odbyta — 28 maja, 13:00" [ref=e401]':
                        - 'button "Status: Odbyta — 28 maja, 13:00" [ref=e403] [cursor=pointer]':
                          - text: Odbyta
                          - img [ref=e405]
                      - cell "220 zł" [ref=e407]
                      - 'cell "Płatność: Opłacona — 28 maja, 13:00" [ref=e408]':
                        - 'button "Płatność: Opłacona — 28 maja, 13:00" [ref=e410] [cursor=pointer]':
                          - text: Opłacona
                          - img [ref=e412]
                      - cell "Edytuj sesję — 28 maja, 13:00" [ref=e414]:
                        - button "Edytuj sesję — 28 maja, 13:00" [ref=e415] [cursor=pointer]:
                          - img [ref=e416]
                    - 'row "21 maj 13:00 Status: Odwołana — 21 maja, 13:00 220 zł Płatność: Nieopłacona — 21 maja, 13:00 Edytuj sesję — 21 maja, 13:00" [ref=e419]':
                      - cell "21 maj" [ref=e420]
                      - cell "13:00" [ref=e421]
                      - 'cell "Status: Odwołana — 21 maja, 13:00" [ref=e422]':
                        - 'button "Status: Odwołana — 21 maja, 13:00" [ref=e424] [cursor=pointer]':
                          - text: Odwołana
                          - img [ref=e426]
                      - cell "220 zł" [ref=e428]
                      - 'cell "Płatność: Nieopłacona — 21 maja, 13:00" [ref=e429]':
                        - 'button "Płatność: Nieopłacona — 21 maja, 13:00" [ref=e431] [cursor=pointer]':
                          - text: Nieopłacona
                          - img [ref=e433]
                      - cell "Edytuj sesję — 21 maja, 13:00" [ref=e435]:
                        - button "Edytuj sesję — 21 maja, 13:00" [ref=e436] [cursor=pointer]:
                          - img [ref=e437]
                    - 'row "14 maj 13:00 Status: Odbyta — 14 maja, 13:00 220 zł Płatność: Opłacona — 14 maja, 13:00 Edytuj sesję — 14 maja, 13:00" [ref=e440]':
                      - cell "14 maj" [ref=e441]
                      - cell "13:00" [ref=e442]
                      - 'cell "Status: Odbyta — 14 maja, 13:00" [ref=e443]':
                        - 'button "Status: Odbyta — 14 maja, 13:00" [ref=e445] [cursor=pointer]':
                          - text: Odbyta
                          - img [ref=e447]
                      - cell "220 zł" [ref=e449]
                      - 'cell "Płatność: Opłacona — 14 maja, 13:00" [ref=e450]':
                        - 'button "Płatność: Opłacona — 14 maja, 13:00" [ref=e452] [cursor=pointer]':
                          - text: Opłacona
                          - img [ref=e454]
                      - cell "Edytuj sesję — 14 maja, 13:00" [ref=e456]:
                        - button "Edytuj sesję — 14 maja, 13:00" [ref=e457] [cursor=pointer]:
                          - img [ref=e458]
                - navigation "Stronicowanie" [ref=e461]:
                  - button "Poprzednia strona" [disabled]:
                    - img
                  - generic [ref=e462]: Strona 1 z 2
                  - button "Następna strona" [ref=e463] [cursor=pointer]:
                    - img [ref=e464]
            - region "Notatki kliniczne" [ref=e466]:
              - generic [ref=e467]:
                - heading "Notatki kliniczne" [level=2] [ref=e468]
                - paragraph [ref=e469]: Notatki są dostępne w widoku specjalistki.
  - generic [ref=e470]: Karta klienta
```

# Test source

```ts
  722 |   await page.keyboard.press('Control+K')
  723 |   await expect(page.getByRole('dialog', { name: 'Szukaj w Aurelii' })).toBeVisible()
  724 |   await expect(group).toHaveCount(0)
  725 | })
  726 | 
  727 | test('therapist mode guards dashboard destinations and filters command palette', async ({ page }) => {
  728 |   await login(page)
  729 |   await switchToTherapist(page)
  730 |   await expect(page.getByRole('region', { name: 'Skróty' }).getByRole('link', { name: 'Zespół' })).toHaveCount(0)
  731 |   await expect(page.getByRole('navigation').getByRole('link', { name: 'Dziś' })).toHaveAttribute('aria-current', 'page')
  732 | 
  733 |   await page.keyboard.press('Control+K')
  734 |   const palette = page.getByRole('dialog', { name: 'Szukaj w Aurelii' })
  735 |   const search = palette.getByRole('combobox', { name: 'Szukaj w Aurelii' })
  736 |   await search.fill('raport')
  737 |   await expect(palette).not.toContainText('Raport miesięczny')
  738 |   await search.fill('julia')
  739 |   await expect(palette).not.toContainText('dr Julia Wolanin')
  740 | })
  741 | 
  742 | test('therapist search only exposes their client context and hides note prose from other roles', async ({ page }) => {
  743 |   await login(page)
  744 |   await switchToTherapist(page)
  745 |   await page.getByRole('button', { name: /Szukaj/ }).click()
  746 |   await page.getByRole('combobox', { name: /Szukaj w Aurelii/ }).fill('Joanna')
  747 |   await page.getByRole('option', { name: /Joanna Madej/ }).click()
  748 |   await expect(page.getByRole('heading', { name: /Joanna Madej/ })).toBeVisible()
  749 |   await expect(page.getByText(/Notatki kliniczne/)).toBeVisible()
  750 |   await expect(page.getByLabel('Nowa notatka')).toBeVisible()
  751 | })
  752 | 
  753 | test('centre roles receive a neutral clinical-notes state', async ({ page }) => {
  754 |   await login(page)
  755 |   await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  756 |   await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  757 |   await expect(page.getByText('Notatki są dostępne w widoku specjalistki.')).toBeVisible()
  758 |   await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
  759 | })
  760 | 
  761 | test('coordinator receives the neutral clinical-notes state', async ({ page }) => {
  762 |   await login(page)
  763 |   await switchToCoordinator(page)
  764 |   await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  765 |   await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  766 |   await expect(page.getByText('Notatki są dostępne w widoku specjalistki.')).toBeVisible()
  767 |   await expect(page.locator('.note__text')).toHaveCount(0)
  768 |   await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
  769 | })
  770 | 
  771 | test('non-owning therapist is remapped away from an unauthorized client detail', async ({ page }) => {
  772 |   await login(page)
  773 |   await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  774 |   await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  775 |   await switchToTherapist(page)
  776 |   await expect(page.locator('.topbar__title b')).toHaveText('Klienci')
  777 |   await expect(page.getByRole('heading', { name: /Moi klienci/ })).toBeVisible()
  778 |   await expect(page.getByRole('row', { name: /Zofia Mazur/ })).toHaveCount(0)
  779 |   await expect(page.getByRole('heading', { name: 'Zofia Mazur' })).toHaveCount(0)
  780 |   await expect(page.locator('.note__text')).toHaveCount(0)
  781 |   await expect(page.getByLabel('Nowa notatka')).toHaveCount(0)
  782 |   await expect(page.locator('.id-band__actions').getByRole('button')).toHaveCount(0)
  783 |   await expect(page.getByRole('button', { name: /Edytuj sesję/ })).toHaveCount(0)
  784 |   await expect(page.getByTitle('Zmień status sesji')).toHaveCount(0)
  785 |   await expect(page.getByTitle('Zmień płatność')).toHaveCount(0)
  786 | })
  787 | 
  788 | test('client detail adapts its primary CTA to the active role', async ({ page }) => {
  789 |   await login(page)
  790 |   await page.getByRole('navigation').getByRole('link', { name: 'Klienci' }).click()
  791 |   await page.getByRole('link', { name: 'Otwórz kartę — Zofia Mazur' }).click()
  792 |   await expect(page.getByRole('button', { name: 'Umów spotkanie' })).toBeVisible()
  793 |   await expect(page.getByRole('button', { name: 'Przygotuj sesję' })).toHaveCount(0)
  794 | 
  795 |   await switchToTherapist(page)
  796 |   await page.getByRole('link', { name: 'Otwórz kartę — Joanna Madej' }).click()
  797 |   await expect(page.getByRole('button', { name: 'Przygotuj sesję' })).toBeVisible()
  798 |   await expect(page.getByRole('button', { name: 'Umów spotkanie' })).toHaveCount(0)
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
> 822 |   expect(h1Precedes).toBe(true)
      |                      ^ Error: expect(received).toBe(expected) // Object.is equality
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
  899 |   expect(contentOverflows).toBe(false)
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
```