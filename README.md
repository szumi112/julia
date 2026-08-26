# Bear with me — panel centrum

Klikalna makieta (UI prototype) panelu do zarządzania **Bear with me — Centrum
Psychologiczno-Edukacyjnym dla dzieci i nastolatków** w Jeleniej Górze:
klienci, sesje, kalendarz, zajęcia TUS, finanse i raporty miesięczne. Zastępuje
arkusz kalkulacyjny, w którym centrum notuje spotkania z dziećmi.

**Wersja demonstracyjna** — brak backendu, wszystkie dane żyją w pamięci
(odświeżenie strony resetuje stan). Wszystkie dane osobowe w demo są fikcyjne;
nazwa centrum, zespół, cennik i oferta TUS odwzorowują [bearwithme.pl](https://bearwithme.pl/).

## Uruchomienie

```bash
npm install
npm run dev
```

Następnie otwórz adres podany przez Vite (domyślnie `http://localhost:5173/julia/`).
**Logowanie:** dowolny e-mail i hasło (pola nie mogą być puste).

## Dwa tryby uruchomienia

- `npm run dev` / `npm run build:demo` - publiczna demonstracja pod `/julia/`,
  wyłącznie z fikcyjnymi danymi.
- `npm run dev:app` / `npm run build:production` - chroniona aplikacja pod `/`,
  z API Workera. Do zakończenia migracji używa wyłącznie fikcyjnych danych.

Kroje pisma, GSAP i three.js są pakowane lokalnie. Aplikacja personelu nie pobiera
skryptów ani fontów z zewnętrznych CDN.

## Co jest w środku

- **Logowanie** — ambientowa scena three.js (organiczny blob w barwach marki), walidacja pól, animowane przejście do aplikacji.
- **Pulpit** — minimalistyczna „scena dnia": najbliższa sesja w dużej typografii, oś czasu dzisiejszych spotkań, dyskretna linia zaległości i skróty tekstowe.
- **Kalendarz** — plan dnia + widok miesiąca, filtry płatności i obecności, zmiana statusu i płatności bez wychodzenia z widoku.
- **Klienci** — wyszukiwarka, filtry (specjalistka / zaległości), karta z wiekiem dziecka, historią frekwencji i zaleceniami; rodzic i dziecko mogą być powiązani jako rodzina.
- **Zajęcia TUS** — grupy wiekowe (przedszkolaki, klasy 1–3, nastolatki), obecność na zajęciach, tematy spotkań i miesięczne opłaty 340 zł.
- **Zespół** — profile specjalistek z własną listą klientów i podsumowaniem miesiąca.
- **Finanse** — rozliczenia miesiąca, zebrane vs. zaległe, szybkie księgowanie płatności.
- **Raporty** — godziny i przychody per specjalistka i dla całego centrum, wykres udziałów, druk / eksport (stub).
- **Ustawienia** — profil, dane centrum, stawki zespołu, dodawanie specjalistek, preferencje (m.in. ograniczenie animacji).

## Cennik w aplikacji

Rodzaje spotkań (`src/services.js`) odwzorowują cennik ze strony centrum —
m.in. pierwsza konsultacja 250 zł / 90 min, zajęcia psychologiczne 180 zł /
50 min, terapia rodzinna 220 zł / 60 min, diagnoza ASRS 400 zł, test Conners 3
600 zł, obserwacja w placówce lub w domu 450 zł. Wybór rodzaju spotkania
w formularzu sesji podstawia czas trwania i kwotę.

Długości slotów dla pozycji, przy których cennik ich nie podaje (plany,
diagnozy, warsztaty), to założenia przyjęte na potrzeby kalendarza.

## Technologie i decyzje

- React 18 + Vite (SPA, własny mini-router z animowanymi przejściami).
- GSAP — choreografia wejść, liczniki, mikrointerakcje; respektuje `prefers-reduced-motion`.
- three.js — jedna lekka scena shaderowa (simplex noise), pauza przy ukrytej karcie.
- Typografia: Alata (logotyp) + Fraunces (nagłówki „okładkowe") + Heebo (interfejs) — Alata i Heebo to kroje ze strony centrum.
- Paleta marki: koral `#ED5A39`, róż `#E88AAC`, bursztyn `#ED9936`, błękit `#B2D9EA` i atramentowy granat `#351B69` na ciepłym papierze.
- Dane: deterministyczny generator (~190 sesji, 21 klientów, 4 specjalistki, 3 grupy TUS, ostatnie ~4 miesiące) liczony względem bieżącej daty — demo zawsze wygląda na „żywe".
- Zero `localStorage` — stan wyłącznie w pamięci React (wymóg zadania).
