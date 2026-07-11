# Minimal Dashboard ("Pulpit") — Design

**Date:** 2026-07-11
**Scope:** `src/views/Dashboard.jsx`, dashboard-only styles in `src/styles.css`, affected e2e tests, README "Pulpit" bullet.

## Goal

Make the post-login Dashboard minimalistic: cut low-value content, remove visual
chrome (cards, shadows, double eyebrow+title headings), and center the page on
the single thing that matters — the nearest session. Direction chosen from
mockups: **"hero stage"** (big centered next-session hero) with the **"quiet
line"** footer treatment for overdue payments.

## What is cut / kept

**Cut**
- "Dzień w skrócie" stats block (sessions today / scheduled / completed) — the
  eyebrow line now carries `X z Y sesji za Tobą`.
- The boxed "Najbliższe działanie / Teraz lub następna sesja" card — replaced
  by the unboxed hero.
- The two-column layout, all card boxes/shadows on this page, and all
  eyebrow+title double headings.
- The "Wszystko pod kontrolą" calm placeholder — when nothing is overdue, the
  attention line simply does not render.

**Kept (restyled, same behavior)**
- Day timeline (`TodayThread` spine): max 4 rows, done rows struck through,
  "teraz" marker, next-session emphasis, `Jeszcze X … — otwórz kalendarz →`.
- Overdue-payment attention items (up to 2 quiet lines).
- Shortcuts (Kalendarz, Klienci, Tablica zespołu, Zajęcia TUS) with existing
  role filtering; "Tablica zespołu" still opens the `BoardDrawer` overlay.
- `BoardDrawer` itself — untouched.
- Reveal animations (`useReveal` / `data-reveal`), reduced-motion behavior.

## Layout (top to bottom, one centered column)

1. **Eyebrow** — small uppercase line: `Piątek, 11 lipca · 2 z 5 sesji za Tobą`.
   Therapist role prefixes `Mój dzień · …` (replaces the old `Mój dzień`/`Dziś`
   page title; the hero time is the de-facto page title). The `X z Y` part
   appears only while the day still has scheduled sessions — on a free day and
   in the all-done state the eyebrow is just the date (the hero carries the
   summary there).
2. **Hero** — centered: large Fraunces time, client name, `room · therapist`
   meta line, then actions: `Otwórz sesję` (primary), `+ Nowa sesja` (ghost),
   `Nowy klient` (quiet link-style button).
3. **Hairline** separator (thin `--line` rule, ~60% width, centered).
4. **Plan dnia** — the existing spine timeline in a narrower centered column,
   left-aligned rows.
5. **Attention (quiet line)** — up to 2 discreet text lines:
   `💳 {client} · zaległa płatność {amount} →` (payments icon, not literal emoji).
6. **Hairline**, then **shortcuts** — one row of quiet text links.

Hero typography uses `clamp()` so the page keeps the existing e2e-enforced
invariant: **no vertical overflow of `main.content`, including at 1280×600**.

## States

| State | Hero |
|---|---|
| Session running now | Running session; eyebrow gains `trwa teraz` |
| None running, upcoming exists | Next session (default mockup) |
| Day had sessions, all done | `Wszystko za Tobą` + `X z X sesji zakończonych`; `+ Nowa sesja` becomes primary; struck-through timeline stays |
| No sessions today | `Wolny dzień` + `Kalendarz jest dziś pusty — czas na oddech.`; no timeline, no hairline above it |

`Otwórz sesję` renders only when a hero session exists. Attention line click:
Payments with `{ allPeriods: true, unpaidOnly: true }` for owner/coordinator,
session form for therapist — unchanged. Data continues to come from
`todayWorkspace()`; no changes to `workspace.js`.

## Accessibility / test contract

Preserved region names: `Pulpit dnia` (page), `Plan dnia`, `Wymaga uwagi`
(renders only when attention items exist; seeded demo data has arrears, so
existing tests still find it), `Skróty`. Timeline rows, shortcut entries, and
attention lines stay real `<button>`s.

## Code impact

- `src/views/Dashboard.jsx` — replace header + `today-command` grid with the
  hero flow; delete stats section and boxed focus card; reuse `TodayThread`,
  `TODAY_SHORTCUTS`, `BoardDrawer`, and all existing handlers.
- `src/styles.css` — add `today-hero` styles; remove `.today-command`,
  `.today-side*`, `.today-stats`, `.today-stat`, `.today-calm`,
  `.today-shortcut*` (boxed variants), `.today-region--focus`, `.today-focus*`;
  keep spine styles. Shared primitives (`.card`, `.btn`, `.eyebrow`, spine) are
  not modified — no other page changes appearance.
- Responsive: single column already; phone sizes shrink hero type and stack
  action buttons full-width (mirroring current `today-head__actions` behavior).

## Tests & docs

`tests/e2e/workspace.spec.js` updates:
- "essential daily regions" — drop `Teraz lub następna sesja`, assert hero
  content instead; keep `Wymaga uwagi`, `Plan dnia`.
- "compact viewport command centre" — remove `Dzień w skrócie` expectation
  (assert it is gone), keep `Skróty` + both no-overflow assertions.
- "limits daily information to the active therapist" — compare owner vs
  therapist **eyebrow** text instead of the stats box.
- narrow-phone test — replace `.today-focus__time`/`__main` gap check with a
  stacked-hero assertion (time above name, both visible, no horizontal
  overflow).
- Board/attention/calendar tests — unchanged, rely on preserved names.

README: rewrite the "Pulpit" bullet to describe the minimal hero dashboard.

## Out of scope

Login screen, navigation shell, other views, `workspace.js`, shared UI
primitives, and any new dependencies. No new state or data model changes.
