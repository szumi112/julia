# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

**Aurelia — Centrum Psychoterapii** (package name `aurelia-panel`, repo `julia`) is a
clickable UI prototype of a management panel for a small psychotherapy centre:
clients, sessions, calendar, finances, monthly reports, and TUS (group social-skills
classes for kids). It is a **demo with no backend** — all data lives in React memory
and a page refresh resets the state. There is intentionally **zero `localStorage`**
(original task requirement).

Key facts:

- Single-page app: React 18 + Vite 6, plain JSX (no TypeScript).
- The entire UI, and all user-facing strings, are in **Polish** (`<html lang="pl">`).
- Login is fake: any non-empty e-mail and password works.
- Demo data is deterministic — seeded PRNG generates ~190 sessions, 19+ clients,
  4 psychologists and TUS groups relative to "today", so the demo always looks live.
- GSAP and three.js are loaded from a CDN (jsdelivr, `<script defer>` in
  `index.html`) and used via `window.gsap` / `window.THREE`. **The app needs an
  internet connection to run as designed.**

## Build and test commands

```bash
npm install
npm run dev        # Vite dev server on port 5173 — open http://localhost:5173/julia/
npm run build      # production build to dist/
npm run preview    # serve the built dist/
npm test           # unit tests: node --test tests/unit/**/*.test.js
npm run test:e2e   # Playwright e2e (auto-starts the dev server)
npm run deploy     # gh-pages -d dist  → publishes dist/ to GitHub Pages
```

Notes:

- Vite `base` is `/julia/` (matches the GitHub repo name for Pages). The dev app is
  served under that path, not at `/`.
- Unit tests use Node's built-in runner (`node --test`) with `node:assert/strict` —
  no Jest/Vitest. Node ≥ 21 is needed for the `**` glob; Node 24 is in use.
- Playwright (`playwright.config.js`) starts `npm run dev -- --host 127.0.0.1`
  itself and reuses an already-running server outside CI. baseURL is
  `http://127.0.0.1:5173/julia/`.
- There is **no ESLint/Prettier config** — match the existing style by reading
  neighbouring code.

## Project structure

```
index.html            entry HTML: fonts, CDN scripts (GSAP, three.js), #root
vite.config.js        react plugin, base '/julia/', port 5173
playwright.config.js  e2e config + dev-server bootstrap
src/
  main.jsx            React entry (StrictMode)
  App.jsx             root: login ↔ shell gate, MotionSync, ToastHost
  store.jsx           AppProvider: useReducer with all app state + actions,
                      separate Toast context, derived-data selectors
  data.js             seeded mock-data generator + INITIAL_STATE (pure)
  format.js           Polish-locale formatting, dates, billing rules (pure)
  workspace.js        domain logic: role scoping, conflicts, payments, families (pure)
  tus.js              TUS (kids' group classes) domain logic (pure)
  routing.js          hash mini-router: routeHref / routeFromHash (pure)
  view-state.js       per-role, per-route view-state registry (pure)
  pagination.js       pure page math (hook + Pager live in ui.jsx)
  layout.jsx          Shell: sidebar, topbar, hash routing, role-based nav, drawers
  ui.jsx              shared primitives: Button, Avatar, Popover, Pill, Pager, …
  icons.jsx           hand-drawn SVG icon set (24px grid)
  charts.jsx          hand-rolled SVG charts, GSAP-animated, CSS-token colours
  anim.js             GSAP helpers + motionOK() reduced-motion gate
  three-scene.jsx     ambient three.js login background (shader blob)
  cockpit.jsx         persistent "today" panel opened from the topbar chip
  command-palette.jsx global search, Ctrl/Cmd+K
  responsive.js       shared breakpoints (keep in sync with styles.css header)
  clock.js            useMinuteNow() — minute-aligned shared clock
  shell-ctx.js        ShellCtx / useShell (navigate, drawers, …)
  ux-patterns.jsx     EntityLink + useRouteParamsSync + cross-view UX primitives
  styles.css          single stylesheet (~3400 lines): design tokens + all styles
  views/              one module per view (Dashboard, Calendar, Clients, Team, Tus,
                      TusGroup, Payments, Reports, Settings, Login) + form drawers
                      (SessionForm, ClientForm, PsychForm, TusForms, TusMemberPicker)
                      + session-bits.jsx (inline status/payment pills)
tests/
  unit/               node --test suites for the pure src/*.js modules
  e2e/                Playwright specs (workspace.spec.js, tus.spec.js)
docs/superpowers/     committed design specs + implementation plans (dated files)
.superpowers/         local working notes (gitignored — not part of the project)
dist/                 build output (gitignored)
```

## Architecture

- **State**: one `useReducer` store in `src/store.jsx` behind `AppProvider`
  (`useApp()` → `{ state, dispatch, toast }`). Toasts live in a **separate context**
  (`useToasts()`) so toast updates don't re-render every app consumer. State shape:
  `user, demoRoleId, center, psychologists, clients, sessions, posts, tusGroups,
tusKids, tusClasses, tusPayments, prefs`.
- **Routing**: custom hash router — `#/<route>?<params>`. `layout.jsx` maps route
  names to view components (`VIEWS`), restricts them per role (`ROLE_NAV`), and
  keeps per-role per-route UI state (month pickers, filters) via `view-state.js`.
  Add new typed query params to `ARRAY_PARAMS`/`BOOLEAN_PARAMS` in `routing.js`.
  The router is two-way: a `hashchange` listener drives back/forward and manual
  hash edits; in-app view changes `pushState`, while view-owned filter params
  write via `useRouteParamsSync` (ux-patterns.jsx) with `replaceState` (deferred
  one frame, so it never overwrites the previous route's history entry).
  Navigation elements are real `<a href="#/…">` links (`navLink` in layout.jsx,
  `EntityLink` elsewhere) — buttons are for actions, not destinations.
- **Unsaved changes**: dirty form drawers gate every close path through
  `useDiscardGuard` + `DiscardConfirm` (ui.jsx) wired into `useDrawerFX`'s
  fourth argument; programmatic closes after save/delete use `forceClose`.
  Views with drafts (Settings) register a Shell leave guard via
  `registerLeaveGuard` (useShell) that intercepts route commits with a confirm
  dialog.
- **Roles (demo)**: `owner` and `coordinator` see centre scope; `therapist` sees only
  her own clients/sessions (`sessionsForRole` / `clientsForRole` in `workspace.js`).
  Role switching clears toasts and scoped view state.
- **Domain model**:
  - Session `status`: `scheduled | completed | cancelled | noshow`;
    `payment`: `paid | unpaid | partial` (+ `paidAmount`, `method`).
  - Billing rule (in `format.js`): completed **and** no-show sessions are billable,
    cancelled are not. `collectedOf` / `outstandingOf` / `billableSummary` derive
    money from that rule.
  - Clients can be linked into families (`familyId`, `familyRole` `'rodzic'|'dziecko'`);
    `dissolveLoneFamilies` clears links that would leave a one-member family.
  - TUS money (monthly group fees) is **intentionally separate** from session
    billing — nothing in `tus.js` feeds `isBillable`/`monthStats`.
- **Dates and money**: dates are ISO strings (`YYYY-MM-DD`), month keys `YYYY-MM`;
  formatting goes through `Intl` with the `pl-PL` locale in `format.js`. Payment
  entry math uses integer cents to avoid float errors (`paymentEntryFor` in
  `workspace.js`).
- **Animation**: `anim.js` is the only GSAP entry point. Always gate effects with
  `motionOK()` — it returns false when GSAP is missing, the OS prefers reduced
  motion, or the in-app "reduce motion" pref is on. Every effect must degrade
  gracefully (elements simply stay in their final state).
- **Mock data**: `data.js` uses seeded mulberry32 PRNGs with **separate streams per
  data area** so adding new fields never shifts the existing generation. Preserve
  that property when extending the generator.

## Code style guidelines

- Language: code identifiers and comments in **English**; UI copy and user-facing
  strings in **Polish**. Follow Polish locale rules via `format.js` helpers
  (`plural` for 1/2–4/5+ forms, `searchNorm` for diacritic-insensitive search).
- Modules are plain ESM (`.js` / `.jsx`), function components, hooks, named exports.
- **Keep domain logic pure and JSX-free.** Any logic worth testing lives in a `.js`
  module with no React/DOM imports (`format.js`, `workspace.js`, `tus.js`,
  `routing.js`, `view-state.js`, `pagination.js`) so `node --test` can import it —
  the Node runner cannot parse JSX. This is a deliberate, documented convention
  (see `tus.js` header and `docs/superpowers/specs/2026-07-11-list-pagination-design.md`).
- Styling: single `styles.css` with CSS custom-property design tokens (quiet
  editorial palette — porcelain paper, plum-ink, a single berry accent, sage
  for data/success, brass for the logotype mark; Fraunces + Hanken Grotesk).
  The Dashboard opens with a "cover date" masthead (`.masthead__*`) — brand
  eyebrow + ISO week, weekday as a large italic Fraunces cover line; other
  views keep the classic `.view-head` until their refresh turn. Deep palette
  tones are chosen for ≥4.5:1 contrast — keep AA when adding colours. BEM-ish class names (`btn--primary`, `view-head__sub`).
- Breakpoints are canonical in two places that must stay in sync: the `styles.css`
  header comment and `src/responsive.js` — phone ≤ 640px, tablet ≤ 1024px (sidebar
  becomes a drawer), desktop > 1024px.
- Charts read colours from the same CSS tokens via `getComputedStyle` (`charts.jsx`)
  — don't hardcode palette hex values in JS.
- Git history uses conventional commit subjects in English (`feat:`, `fix:`,
  `test:`, `docs:`, `refactor:`). Larger features were developed spec-first —
  design docs and plans live in `docs/superpowers/{specs,plans}/` with dated
  filenames; follow that pattern for substantial work.

## Testing instructions

- **Unit** (`npm test`): `tests/unit/*.test.js`, one suite per pure module
  (`format`, `workspace`, `tus`, `routing`, `view-state`, `pagination`). Import the
  module under test from `../../src/…`, use `node:test` + `node:assert/strict`,
  build tiny fixture objects inline. Currently 79 tests.
- **E2E** (`npm run test:e2e`): Playwright specs in `tests/e2e/` drive the real UI
  through role-based, Polish-language locators (`getByRole('button', { name:
'Zaloguj się' })`, `getByLabel('Hasło')`). Each spec logs in through the login
  screen first (any credentials). Prefer accessible role/name locators over CSS
  selectors; trace is retained on failure.
- Run both suites before considering a change done. E2e needs internet access for
  the CDN scripts and webfonts.

## Security considerations

- This is a front-end-only demo: **no real authentication, no backend, no
  persistence**. Never treat the login screen as a security boundary, and do not
  add real secrets or credentials to the repo (`.env` is gitignored).
- GSAP and three.js come from a public CDN pinned by version
  (`gsap@3.12.5`, `three@0.152.2`) without SRI hashes — a deliberate trade-off for
  a prototype; be aware before reusing this pattern elsewhere.
- All client/patient data is fictional, generated mock data — keep it that way;
  do not add real personal data.
- `npm run deploy` publishes whatever is in `dist/` to the public GitHub Pages
  site — check the content before deploying.

## Deployment

- `npm run deploy` runs `gh-pages -d dist` and pushes `dist/` to the `gh-pages`
  branch of `github.com/szumi112/julia`; the site is served at
  `https://szumi112.github.io/julia/` (hence `base: '/julia/'` in `vite.config.js`).
- Always `npm run build` (and ideally run the tests) before deploying.
