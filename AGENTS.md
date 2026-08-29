# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

**Bear with me — panel centrum** (package name `bearwithme-panel`, repo `julia`) is a
management panel for **Bear with me — Centrum Psychologiczno-Edukacyjne**, a real
children's and teens' psychology centre in Jelenia Góra (bearwithme.pl): clients,
sessions, calendar, finances, monthly reports, and TUS (group social-skills classes).
It replaces the spreadsheet the centre keeps its sessions in.

The repo ships one React UI in **two runtime modes**, selected by the Vite `mode`
(`src/app-mode.js`):

- **Public demo** — `npm run dev` / `npm run build:demo`, served under `/julia/` for
  GitHub Pages. A **clickable prototype with no backend**: all data lives in React
  memory (`src/data.js`), login is fake (any non-empty e-mail/password works), and
  there is intentionally **zero `localStorage`** (original task requirement). A page
  refresh resets the state. **This contract is permanent for the demo** — never wire
  demo code to the Worker API.
- **Protected app** — `npm run dev:app` / `npm run build:app` (plus `build:staging` /
  `build:production`), served same-origin at `/`. The real panel: a Cloudflare Worker
  (Hono) under `worker/` serves both the static app bundle (via the `ASSETS` binding)
  and a JSON API backed by D1 + R2, behind a Cloudflare Access authentication
  boundary, with envelope-encrypted data at rest. See "Backend architecture" and
  "Security considerations" below.

**Phase 1 status:** the app mode is fictional-data only — `DATA_MODE` is code-locked
to the literal `'fictional'` in `worker/config.js` (any other value fails config
validation at startup) — and production has not been deployed yet. Real client/
patient data is forbidden until the separate launch gates in
`docs/superpowers/plans/2026-07-29-phase-1-platform-foundation.md` are evidenced and
signed off (legal/DPA review, DPIA, Access hardening, key-recovery drills, etc.).

The centre name, team, service catalogue (`src/services.js`) and TUS offer mirror the
public site; every client, child and session in both modes is fictional. Keep it that
way.

Key facts:

- Single-page app: React 18 + Vite 6, plain JSX (no TypeScript); the same UI code
  serves both modes, switching data source through `src/workspace-repository.js` /
  `src/api.js` / `src/auth.jsx`.
- The entire UI, and all user-facing strings, are in **Polish** (`<html lang="pl">`).
- Demo login is fake: any non-empty e-mail and password works. App-mode
  authentication goes through Cloudflare Access — see Security considerations.
- Demo data is deterministic — seeded PRNG generates ~190 sessions, 21 clients,
  4 specialists and 3 TUS groups relative to "today", so the demo always looks live.
- GSAP, three.js and the app's webfonts are bundled locally (`src/runtime-vendors.js`,
  `gsap`/`three`/`@fontsource*` npm packages) and exposed as `window.gsap` /
  `window.THREE` for `anim.js` / `three-scene.jsx`. Neither mode loads them from a
  CDN at runtime any more — the deploy scripts run `scripts/assert-repository-
  safety.mjs --dist` after the build, which fails if a `cdn.jsdelivr.net`/Google
  Fonts reference reappears in the built app bundle.

## Build and test commands

```bash
npm install

# Public demo — gh-pages, /julia/, fictional in-memory data, fake login
npm run dev             # Vite dev server, demo mode, port 5173 — /julia/
npm run build            # = npm run build:demo → dist/demo/
npm run preview          # serve dist/demo
npm run deploy            # = npm run deploy:demo → gh-pages -d dist/demo

# Protected app — Worker + D1 + R2, served at /, Cloudflare Access
npm run dev:app           # Vite dev server, app mode, port 5174 — /
npm run build:app         # dist/app/, local/dev bindings
npm run build:staging     # CLOUDFLARE_ENV=staging build → dist/app/
npm run build:production  # CLOUDFLARE_ENV=production build → dist/app/
npm run deploy:staging     # check:repo + build:staging + safety guard + wrangler deploy
npm run deploy:production  # check:repo + build:production + safety guard + wrangler deploy

# Tests
npm test               # unit: node --test tests/unit/**/*.test.js
npm run test:worker     # Worker/D1 integration: vitest + @cloudflare/vitest-pool-workers
npm run test:scripts    # scripts/ behaviour: node --test (sequential) tests/scripts/*.test.js
npm run test:e2e         # Playwright e2e against the demo (auto-starts npm run dev)
npm run test:e2e:app     # Playwright e2e against the app mode (playwright.app.config.js)

# Operational scripts
npm run check:repo             # scripts/assert-repository-safety.mjs — tracked-file secrets,
                               # exact dependency pins, migration config, no-CDN guard
npm run configure:cloudflare    # scripts/configure-cloudflare-env.mjs — writes env.staging and
                               # env.production into wrangler.json from a provider-results JSON
npm run seed:local              # scripts/seed-local.mjs — writes fictional seed data into local D1
npm run migrate:core:stage-a    # scripts/apply-core-migration-stage.js stage-a --local
npm run migrate:core:stage-b    # scripts/apply-core-migration-stage.js stage-b --local
npm run migrate:core:stage-a:staging      # stage-a --remote --env staging
npm run migrate:core:stage-a:production   # stage-a --remote --env production
npm run migrate:core:stage-b:staging      # stage-b --remote --env staging
npm run migrate:core:stage-b:production   # stage-b --remote --env production
npm run upgrade:core-directory  # scripts/upgrade-core-directory.js — local core-directory backfill
npm run upgrade:core-directory:staging     # core-directory backfill --remote --env staging
npm run upgrade:core-directory:production  # core-directory backfill --remote --env production
```

Notes:

- Vite `base` is `/julia/` in demo mode and `/` in app/staging/production mode
  (`basePathFor` in `src/app-mode.js`); each mode builds to its own `dist/demo/` or
  `dist/app/` directory (`vite.config.js`), so the two never collide.
- `build:staging` and `build:production` differ from `build:app` by `CLOUDFLARE_ENV`,
  which selects the wrangler environment (`env.staging` / `env.production` in
  `wrangler.json`) that the `@cloudflare/vite-plugin` bakes into the deploy artifact
  — this is the mechanism behind `deploy:staging` / `deploy:production`. The Vite
  output directory and bundling are otherwise the same as `build:app`.
- Unit tests use Node's built-in runner (`node --test`) with `node:assert/strict` —
  no Jest/Vitest for `tests/unit/`. Node ≥ 21 is needed for the `**` glob; Node 24 is
  in use. `test:worker` runs under Vitest with `@cloudflare/vitest-pool-workers`
  (real Workers runtime + D1 via Miniflare, config in `vitest.worker.config.js`);
  `test:scripts` runs under `node --test` with `--test-concurrency=1` because those
  suites spawn `wrangler`/child processes and touch shared local filesystem/D1 state.
- Playwright demo config (`playwright.config.js`) starts `npm run dev -- --host
  127.0.0.1` itself and reuses an already-running server outside CI; baseURL is
  `http://127.0.0.1:5173/julia/`. The app-mode config (`playwright.app.config.js`)
  boots the app through `npm run dev:app:e2e` (`scripts/run-app-e2e.mjs`), never
  reuses a server, and runs role-scoped projects (owner/coordinator/specialist)
  against `http://127.0.0.1:5174/`.
- There is **no ESLint/Prettier config** — match the existing style by reading
  neighbouring code.

## Project structure

```
index.html            entry HTML: fonts + bundled GSAP/three.js via main.jsx, #root
vite.config.js         react + cloudflare() plugins (app modes only), per-mode base
                       and outDir, port 5173 (demo) / 5174 (app)
playwright.config.js   demo e2e config + dev-server bootstrap
playwright.app.config.js  app-mode e2e config (role projects, run-app-e2e harness)
vitest.worker.config.js   Worker/D1 test config (vitest-pool-workers, migrations)
wrangler.json           Worker bindings: ASSETS (SPA + /api/* passthrough), D1 `DB`
                       (migrations_dir .core-migrations/active), R2 `ARCHIVE` (EU),
                       cron triggers, DATA_MODE var, required-secrets list
src/
  main.jsx             React entry (StrictMode); imports runtime-vendors.js
  runtime-vendors.js    bundles GSAP/three.js/fonts, exposes window.gsap/window.THREE
  App.jsx              root: login ↔ shell gate, MotionSync, ToastHost
  app-mode.js           demo vs app mode/base-path/surface resolution from Vite MODE
  auth.jsx              app-mode auth context: Access session state, capabilities
  api.js                app-mode HTTP client for the Worker's /api/v1/* routes
  app-workspace.js       typed adapter binding api.js methods into the workspace store
  workspace-provider.js  authority/versioning for the loaded workspace window (either mode)
  workspace-repository.js  demo (in-memory) vs API-backed repository implementations
  workspace-view.js      shared read-model helpers over a loaded workspace window
  loaded-windows.js       pure state machine for "which window of data is loaded"
  core-records.js         canonical DTO/validation contract shared with worker/core
  core-audit-contract.js  audit-event schema shared with worker/audit
  store.jsx            AppProvider: useReducer with all app state + actions,
                       separate Toast context, derived-data selectors
  data.js              seeded mock-data generator + INITIAL_STATE (pure, demo only)
  format.js            Polish-locale formatting, dates, ages, billing rules (pure)
  services.js          the centre's service catalogue from the published cennik (pure)
  workspace.js         domain logic: role scoping, conflicts, payments, families (pure)
  tus.js               TUS (kids' group classes) domain logic (pure)
  routing.js           hash mini-router: routeHref / routeFromHash (pure)
  view-state.js        per-role, per-route view-state registry (pure)
  pagination.js        pure page math (hook + Pager live in ui.jsx)
  layout.jsx           Shell: sidebar, topbar, hash routing, role-based nav, drawers
  ui.jsx               shared primitives: Button, Avatar, Popover, Pill, Pager, …
  icons.jsx            hand-drawn SVG icon set (24px grid)
  charts.jsx           hand-rolled SVG charts, GSAP-animated, CSS-token colours
  anim.js              GSAP helpers + motionOK() reduced-motion gate
  three-scene.jsx      ambient three.js login background (shader blob)
  cockpit.jsx          persistent "today" panel opened from the topbar chip
  command-palette.jsx  global search, Ctrl/Cmd+K
  responsive.js        shared breakpoints (keep in sync with styles.css header)
  clock.js             useMinuteNow() — minute-aligned shared clock
  shell-ctx.js         ShellCtx / useShell (navigate, drawers, …)
  ux-patterns.jsx      EntityLink + useRouteParamsSync + cross-view UX primitives
  styles.css           single stylesheet (~3400 lines): design tokens + all styles
  views/               one module per view (Dashboard, Calendar, Clients, Team, Tus,
                       TusGroup, Payments, Reports, Settings, Login) + form drawers
                       (SessionForm, ClientForm, PsychForm, TusForms, TusMemberPicker)
                       + session-bits.jsx (inline status/payment pills)
worker/                Cloudflare Worker backend (Hono) — see "Backend architecture"
migrations/            tracked, numbered D1 SQL migrations (0001…0011, append-only)
scripts/               Node scripts run outside the Worker runtime — see
                       "Backend architecture" for the migration/deploy scripts
tests/
  unit/                node --test suites for the pure src/*.js modules and
                       app-mode/dual-runtime plumbing (api, auth-role, backup-format,
                       configure-cloudflare-env, core-records, repository-safety,
                       vite-config, wrangler-crons, workspace-provider/repository/
                       view, loaded-windows, …)
  worker/              vitest suites for worker/*, run against real D1 via Miniflare
  scripts/             node --test suites for scripts/* (migrations, seed, bootstrap)
  e2e/                 Playwright specs: demo (workspace.spec.js, tus.spec.js) and
                       app-mode (app-*.spec.js, role-scoped)
  fixtures/             shared JSON fixtures (e.g. backup-format-v1.json)
docs/superpowers/      committed design specs + implementation plans (dated files)
.superpowers/          local working notes (gitignored — not part of the project)
.core-migrations/      gitignored — staged migration SQL + local Wrangler D1 state
dist/                  build output (gitignored): dist/demo/, dist/app/
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
  - Session `service` is an id from `services.js` (the published cennik). Picking one
    in `SessionForm` restates `duration` and `amount`; the standard 50-minute
    `zajecia` bills at the specialist's own `rate`, every other position at its fixed
    catalogue price (`amountFor`). Dense lists badge only non-standard services
    (`serviceBadge`) so exceptional bookings stand out.
  - Billing rule (in `format.js`): completed **and** no-show sessions are billable,
    cancelled are not. `collectedOf` / `outstandingOf` / `billableSummary` derive
    money from that rule.
  - Clients are children and teenagers with an `age` (adults — parents attending
    consultations — carry `age: null`); contact details on a child's record belong to
    the parent/guardian. Clients can be linked into families (`familyId`, `familyRole`
    `'rodzic'|'dziecko'`); `dissolveLoneFamilies` clears links that would leave a
    one-member family.
  - TUS money (monthly group fees, `TUS_FEE` = 340 zł) is **intentionally separate**
    from session billing — nothing in `tus.js` feeds `isBillable`/`monthStats`.
    Groups list youngest-first via `sortTusGroups`, not alphabetically.
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
  that property when extending the generator. Demo-only — never a source for the app
  mode's D1 data.

## Backend architecture (Worker, D1, R2)

The protected app mode is a Hono app running on a Cloudflare Worker. Read
`worker/app.js` first — it wires every route, the auth gate, CSRF, and the D1 query
budget in one place.

- `worker/index.js` — the Worker entry: the `fetch` handler loads config and defers
  to the Hono app; the `scheduled` handler dispatches the operations cron
  (`*/5 * * * *`, health/backup upkeep) and the outbox-drain cron (`* * * * *`),
  rejecting any other cron expression.
- `worker/config.js` — zod-validated environment schema; `DATA_MODE` is
  `z.literal('fictional')` (nothing else parses), plus Access/D1/R2/KEK bindings and
  rejection of obvious placeholder secret values.
- `worker/routes/` — one HTTP handler module per resource: `workspace`, `clients`,
  `appointments`, `payments`, `staff`, `session`, `operations`.
- `worker/identity/` — Cloudflare Access JWT verification and principal resolution
  (`access-jwt.js`), the staff/specialist directory, canonical-email rules
  (`canonical-email.js`), and invitation/capability policy (`invitations.js`,
  `policy.js`).
- `worker/security/` — the data-at-rest crypto boundary: envelope encryption
  (`envelope.js`, DEKs wrapped by versioned KEKs), the keyring that resolves
  `BWM_DATA_KEK_V*` / `BWM_LOOKUP_HMAC_V*` / `BWM_BACKUP_KEK_V*` secrets
  (`keyring.js`), CSRF token issue/verify (`csrf.js`), and base64url encoding.
- `worker/db/` — D1 helpers: unit-of-work transactions (`unit-of-work.js`), a
  per-request query budget that caps D1 calls (`query-budget.js`), and typed D1
  error classification (`errors.js`).
- `worker/audit/` — security/audit event log entries (`events.js`) written
  alongside mutations, sharing the schema in `src/core-audit-contract.js`.
- `worker/jobs/` — background work processed through an outbox table: delivery
  (`outbox.js`, `handlers.js`) and Cloudflare Access reconciliation
  (`access-reconciliation.js`).
- `worker/operations/` — health snapshotting (`health.js`), the cron entry points
  (`scheduler.js`, `outbox-drain.js`), Warsaw-time helpers (`clock.js`), and backup
  format/creation (`backup-format.js`, `backups.js`).
- `worker/providers/` — external integrations: the Cloudflare Access management API
  (`cloudflare-access.js`) and Resend transactional email (`resend-email.js`).
- `worker/logging/` — `safe-log.js`, an allow-listed structured logger that refuses
  to log anything not on its field allowlist (no accidental PII/secret leakage).
- `worker/core/` — server-side domain logic mirroring `src/core-records.js`
  (`appointments.js`, `clients.js`, `payments.js`, `resources.js`, `versions.js`,
  `workspace.js`) plus field-level crypto helpers (`crypto.js`).
- `worker/http/` — shared HTTP error shaping (`errors.js`) and security-header/CSRF/
  body-size/CORS helpers (`security.js`) used by every route.

**Access boundary**: every route except `GET /api/v1/health/live` expects a *human*
Cloudflare Access identity (`principal.kind === 'human'`, verified JWT against
`worker/identity/access-jwt.js`, checked against the `ACCESS_TEAM_DOMAIN`/
`ACCESS_AUD` config); the health endpoint instead expects a *service* token
(`principal.kind === 'service'`, keyed off `ACCESS_HEALTH_SERVICE_TOKEN_ID`) so
uptime checks don't need a human Access session. `GET /api/v1/session` resolves the
current Access principal against the staff directory and issues a CSRF token that
mutation routes then verify. The one carve-out is a local-dev identity header
(`X-BWM-Local-Identity`, `worker/identity/access-jwt.js`) that `test:e2e:app` uses
instead of a real Access login; it only activates when `config.appEnv ===
'development'` (which also drives `config.localAuth`) and the request targets
`localhost`/`127.0.0.1` at the configured `appOrigin` with an `@example.test`
address — structurally unreachable once `APP_ENV` is `staging`/`production`.

**Migration model**: `migrations/` holds tracked, numbered, append-only D1 SQL files
(currently `0001`…`0011`). They are never applied directly by hand — the local
workflow stages a fixed subset into the gitignored `.core-migrations/active/`
directory (the `migrations_dir` `wrangler.json` points D1 at) via
`scripts/apply-core-migration-stage.js`, run as `npm run migrate:core:stage-a` /
`stage-b` (stage boundaries are defined in `scripts/core-migration-stages.js`). The
local mode refuses whenever `APP_ENV`/`CLOUDFLARE_ENV` is `'production'` or
`DATA_MODE` isn't `'fictional'`, and enforces private (`0700`)/non-symlinked
directories before touching anything. Both the stage script and
`scripts/upgrade-core-directory.js` (`npm run upgrade:core-directory`, the
core-directory backfill) also run against deployed environments through an explicit
`--remote --env <staging|production>` invocation (the `:staging`/`:production` npm
scripts above): `DATA_MODE=fictional` stays mandatory, and the production target is
additionally gated by the `BWM_CONFIRM_PRODUCTION_DATABASE` environment variable,
whose value must equal the `database_name` of the target env block's D1 binding in
`wrangler.json`. `scripts/seed-local.mjs` (`npm run seed:local`) is genuinely
local-only and keeps the fictional-only/local-only guard.
`scripts/configure-cloudflare-env.mjs` (`npm run configure:cloudflare`) validates a
provider-results JSON and writes the `env.staging`/`env.production` blocks those
remote modes target. `scripts/bootstrap-owner.mjs` is the separate,
real-D1-REST-API flow that creates the first owner account — a production-facing
tool, not part of the local staged migration path.

## Code style guidelines

- Language: code identifiers and comments in **English**; UI copy and user-facing
  strings in **Polish**. Follow Polish locale rules via `format.js` helpers
  (`plural` for 1/2–4/5+ forms, `searchNorm` for diacritic-insensitive search).
- Modules are plain ESM (`.js` / `.jsx`), function components, hooks, named exports.
  `worker/` and `scripts/` follow the same ESM/named-export convention.
- **Keep domain logic pure and JSX-free.** Any logic worth testing lives in a `.js`
  module with no React/DOM imports (`format.js`, `workspace.js`, `tus.js`,
  `services.js`, `routing.js`, `view-state.js`, `pagination.js`, `core-records.js`,
  `workspace-provider.js`, …) so `node --test` can import it — the Node runner
  cannot parse JSX. This is a deliberate, documented convention (see `tus.js`
  header and `docs/superpowers/specs/2026-07-11-list-pagination-design.md`).
- Styling: single `styles.css` with CSS custom-property design tokens carrying the
  bearwithme.pl brand on quiet editorial paper — `--coral*` (#ed5a39, the accent:
  links, focus, primary actions), `--pink*` (#e88aac), `--amber*` (#ed9936,
  attention), `--sky*` (#b2d9ea, TUS and group work), `--sage*` (paid/attended),
  `--error` (a crimson pushed off coral's hue), `--ink*` (indigo #351b69 family).
  Fonts: `--font-brand` Alata (wordmark), `--font-display` Fraunces (cover lines),
  `--font-ui` Heebo. **Never hardcode palette hex in CSS or JSX** — the one
  exception is `BearMark` in `icons.jsx`, a logotype that keeps its colours on any
  surface. `Pill` tone names match the token families (`coral`, `pink`, `amber`,
  `sky`, `sage`, `error`, `ink`).
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

- **Unit** (`npm test`): `tests/unit/*.test.js`, `node:test` + `node:assert/strict`,
  build tiny fixture objects inline. Covers the pure `src/*.js` domain modules
  (`format`, `workspace`, `tus`, `services`, `routing`, `view-state`, `pagination`)
  and the dual-runtime plumbing (`api`, `app-mode`, `auth-role`, `core-records`,
  `workspace-provider`, `workspace-repository`, `workspace-view`, `loaded-windows`,
  `backup-format`, `configure-cloudflare-env` for the wrangler env-block writer,
  `repository-safety`, `vite-config`, `wrangler-crons`). Currently 534 tests.
- **Worker** (`npm run test:worker`): `tests/worker/*.test.js` under Vitest with
  `@cloudflare/vitest-pool-workers` — runs against a real Workers runtime + D1
  (Miniflare), migrations applied per `vitest.worker.config.js`. Covers routes,
  identity/Access verification, envelope encryption, the outbox/jobs pipeline,
  bootstrap, backups, and operational health. Currently 71 test files / 2059 tests.
- **Scripts** (`npm run test:scripts`): `tests/scripts/*.test.js` under `node:test`
  with `--test-concurrency=1` (suites spawn `wrangler`/child processes and share
  local filesystem/D1 state). Covers the migration stage script, local seeding,
  the core-directory upgrade, the app e2e harness, and `bootstrap-owner.mjs`.
  Currently 198 tests.
- **E2E — demo** (`npm run test:e2e`): Playwright specs in `tests/e2e/` drive the
  real demo UI through role-based, Polish-language locators (`getByRole('button', {
  name: 'Zaloguj się' })`, `getByLabel('Hasło')`). Each spec logs in through the
  login screen first (any credentials). Prefer accessible role/name locators over
  CSS selectors; trace is retained on failure.
- **E2E — app** (`npm run test:e2e:app`): Playwright specs matching `app-*.spec.js`,
  run against the app mode via `playwright.app.config.js`; role-scoped projects
  (owner/coordinator/specialist) authenticate through the local dev harness
  (`scripts/run-app-e2e.mjs`, `X-BWM-Local-Identity` header) rather than a real
  Access login.
- Run the unit + worker + scripts suites (and both e2e suites when touching UI or
  routes) before considering a change done. Demo e2e needs internet access for
  webfonts; app-mode dev/e2e do not depend on any CDN.

## Security considerations

- **Public demo**: no real authentication, no backend, no persistence. Never treat
  the demo login screen as a security boundary, and do not add real secrets or
  credentials to the repo (`.env` is gitignored). This is a fixed property of the
  demo build, not something to "fix" — do not add real auth or persistence to
  `npm run dev` / `build:demo`.
- **Protected app**: authentication is a real Cloudflare Access boundary — every
  route except the service-token health check requires a verified human Access JWT
  (see "Backend architecture" for the human/service split and its one local-dev-only
  identity carve-out). Client data at rest is envelope-encrypted
  (`worker/security/envelope.js`) with versioned KEKs supplied only as Wrangler
  secrets, never committed. Even so, **Phase 1 uses fictional data only** —
  `DATA_MODE` is code-locked to `'fictional'` (`worker/config.js`); do not attempt to
  loosen that lock or seed real client/patient data until the launch gates in
  `docs/superpowers/plans/2026-07-29-phase-1-platform-foundation.md` are complete.
- Never commit secrets, provider tokens, or real e-mail addresses. `scripts/
  assert-repository-safety.mjs` (`npm run check:repo`, also run inside
  `deploy:staging`/`deploy:production`) checks tracked files for known secret names
  and forbidden bindings, and its `--dist` mode checks the built app bundle for
  leftover CDN hosts and source maps; with `--env <staging|production>` it also
  asserts the artifact was actually resolved for that environment (no local
  placeholder vars or database ids). Treat a failure as a hard stop, not something
  to work around.
- Deploys only go through the guarded npm scripts (`deploy:staging`,
  `deploy:production`): `check:repo` → mode build → `assert-repository-safety.mjs
  --dist --env <staging|production>` → `wrangler deploy`. Never run `wrangler
  deploy` directly against a real environment.
- `.core-migrations/` (staged migration SQL + local D1/Wrangler state) and
  `.artifacts/` (build/dry-run output) are gitignored and must stay untracked —
  don't force-add anything under them.
- All client/patient data in both modes is fictional, generated or hand-seeded mock
  data — keep it that way; do not add real personal data. The centre's own public
  details (address, phone, team, cennik) come from bearwithme.pl and are fine to
  keep accurate.
- `npm run deploy` (demo) publishes whatever is in `dist/demo/` to the public GitHub
  Pages site — check the content before deploying.

## Deployment

- **Demo**: `npm run deploy` (= `deploy:demo`) runs `gh-pages -d dist/demo` and
  pushes `dist/demo/` to the `gh-pages` branch of `github.com/szumi112/julia`; the
  site is served at `https://szumi112.github.io/julia/` (hence the `/julia/` base
  path in demo mode). Always `npm run build:demo` (and ideally run the tests) before
  deploying.
- **Staging/production app**: `npm run deploy:staging` / `npm run deploy:production`
  chain `check:repo` → the matching mode build → `assert-repository-safety.mjs
  --dist --env <staging|production>` → `wrangler deploy`; each guard must pass
  before Wrangler ever runs. As of
  this writing, production deployment has not been performed — Phase 1 stays on
  fictional data (see "Project overview" and "Security considerations").
- D1 schema changes ship as new files in `migrations/`; apply them locally with the
  staged `migrate:core:stage-a`/`stage-b` scripts (see "Backend architecture") before
  relying on them in `dev:app`, `test:worker`, or e2e runs.
