# Minimal Hero Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the post-login Dashboard ("Pulpit") as a minimal, centered "hero stage": the nearest session in big type, the day timeline beneath it, a quiet overdue-payments line, and shortcuts as text links — no cards, no stats block, no double headings.

**Architecture:** Single-view restyle per `docs/superpowers/specs/2026-07-11-minimal-dashboard-design.md`. `src/views/Dashboard.jsx` keeps `TodayThread`, `BoardDrawer`, `TODAY_SHORTCUTS`, and all click handlers, but the page becomes one centered column. Dashboard-only CSS in `src/styles.css` is replaced; shared primitives (`.card`, `.btn`, `.eyebrow`, `.display`, `.link`, spine styles) are untouched. E2E assertions that describe the old layout are updated in the same task so the suite stays green at every commit.

**Tech Stack:** React 18 + Vite, GSAP reveal animations (existing `useReveal`), Playwright e2e (`npx playwright test`, dev server auto-starts via `playwright.config.js`).

## Global Constraints

- No new dependencies; no `localStorage`; state stays in React memory.
- Polish UI copy exactly as written in this plan (e.g. `Wszystko za Tobą`, `Wolny dzień`, `Kalendarz jest dziś pusty — czas na oddech.`, `zaległa płatność`).
- Preserved accessible region names: `Pulpit dnia`, `Plan dnia`, `Wymaga uwagi`, `Skróty`. Timeline rows, attention lines, and shortcuts stay real `<button>`s. The page must keep exactly one `<h1>`.
- E2E-enforced invariant: `main.content` must NOT scroll vertically on desktop, including 1280×600 (two existing tests check `scrollHeight > clientHeight + 1` — do not weaken them).
- Do not modify `src/workspace.js`, `src/ui.jsx`, `src/anim.js`, or any other view.
- Commits follow Conventional Commits; no AI/tool mentions, no `Co-Authored-By` trailers.
- Do not use the shortcuts section as a `<nav>` — tests resolve `getByRole('navigation')` to the app sidebar; a second nav landmark breaks them. Use `<section aria-label="…">`.

---

### Task 1: Hero dashboard — JSX, CSS, and e2e updates

**Files:**
- Modify: `src/views/Dashboard.jsx` (imports, `TodayThread`, `Dashboard`; `BoardPost`, `BoardComposer`, `BoardDrawer`, `TODAY_SHORTCUTS`, `relDay` stay untouched)
- Modify: `src/styles.css:2246-2468` (the `.content--dashboard` / `.today-*` / `.dash-hero__*` blocks and their entries in the 900/640/360px media queries; spine styles stay)
- Test: `tests/e2e/workspace.spec.js`

**Interfaces:**
- Consumes: `todayWorkspace(state, role, now)` → `{ current, next, schedule, attention }` (unchanged, from `src/workspace.js`); `useShell()` → `{ navigate, openSessionForm, openClientForm, openTeamBoard, role }`; `Button({ variant, icon, magnetic, onClick })`, `Icon({ name, size })`.
- Produces: DOM contract for tests — one `<h1>` inside `.today-hero`; `.today-hero .eyebrow` text differs per role (therapist prefix `Mój dzień · `); regions `Plan dnia` (only when today has sessions), `Wymaga uwagi` (only when arrears exist), `Skróty` (always).

- [ ] **Step 1: Baseline — run the e2e suite**

Run: `cd /Users/mateusz/dev/julia && npx playwright test`
Expected: all tests pass. If anything fails BEFORE touching code, stop and report — the working tree has unrelated in-flight changes and the baseline must be known.

- [ ] **Step 2: Update the five dashboard e2e tests to describe the hero layout**

In `tests/e2e/workspace.spec.js`:

(a) Replace the first test (`the mock-data workspace opens after login`, near line 21):

```js
test('the mock-data workspace opens after login', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('region', { name: 'Pulpit dnia' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
})
```

(b) Replace `Today keeps the essential daily regions together` (near line 194):

```js
test('Today keeps the essential daily regions together', async ({ page }) => {
  await login(page)
  await expect(
    page.getByRole('heading', { level: 1, name: /^\d{1,2}:\d{2}$|Wszystko za Tobą|Wolny dzień/ })
  ).toBeVisible()
  await expect(page.getByRole('region', { name: /Wymaga uwagi/ })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Skróty' })).toBeVisible()
})
```

(The `Plan dnia` region moved to the compact test below so this test stays valid even on a sessions-free day; `Wymaga uwagi` stays because seeded demo data always contains arrears.)

(c) In `Today is a compact viewport command centre without secondary reports` (near line 201), replace the two region expectations:

```js
  await expect(dashboard.getByRole('region', { name: 'Dzień w skrócie' })).toBeVisible()
  await expect(dashboard.getByRole('region', { name: 'Skróty' })).toBeVisible()
```

with:

```js
  await expect(dashboard.getByRole('region', { name: 'Dzień w skrócie' })).toHaveCount(0)
  await expect(dashboard.getByRole('region', { name: 'Skróty' })).toBeVisible()
```

Keep every other line of that test (including both `not.toContainText` checks and the overflow assertion) exactly as is.

(d) Replace `Today keeps the next-session time separate from the client name on a narrow phone` (near line 229):

```js
test('Today keeps the hero legible without horizontal overflow on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await login(page)

  await expect(page.locator('.today-hero').getByRole('heading', { level: 1 })).toBeVisible()
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  )
  expect(overflows).toBe(false)
})
```

(e) Replace `Today limits daily information to the active therapist` (near line 286):

```js
test('Today limits daily information to the active therapist', async ({ page }) => {
  await login(page)
  const ownerEyebrow = await page.locator('.today-hero .eyebrow').innerText()

  await switchToTherapist(page)
  const therapistEyebrow = page.locator('.today-hero .eyebrow')
  await expect(page.getByRole('region', { name: 'Plan dnia' })).not.toContainText('Julia Wolanin')
  await expect(therapistEyebrow).toContainText('Mój dzień')
  await expect(therapistEyebrow).not.toHaveText(ownerEyebrow)
  await expect(page.getByText('Stan praktyki')).toHaveCount(0)
})
```

Do not touch any other test — in particular the board tests (they click `Tablica zespołu` inside region `Skróty`), the attention tests (`getByRole('region', { name: 'Wymaga uwagi' }).getByRole('button').first()`), and both no-overflow tests.

- [ ] **Step 3: Run the updated tests to verify they fail**

Run: `npx playwright test tests/e2e/workspace.spec.js -g "mock-data workspace|essential daily regions|compact viewport|narrow phone|active therapist"`
Expected: FAIL — old markup has no `.today-hero`, still renders `Dzień w skrócie`, and has two `<h2>`s but a `Dziś`/`Mój dzień` `<h1>`.

- [ ] **Step 4: Rewrite the Dashboard component**

In `src/views/Dashboard.jsx`:

(a) Replace the import block (drops `Pill`, `EmptyState`; everything else stays):

```jsx
import { Fragment, useRef, useState } from 'react'
import { useApp } from '../store.jsx'
import { useShell } from '../shell-ctx.js'
import { useReveal, useDrawerFX } from '../anim.js'
import { Button, Avatar, IconBtn } from '../ui.jsx'
import { Icon } from '../icons.jsx'
import { todayWorkspace } from '../workspace.js'
import {
  fmtMoney, fmtWeekday, fmtDayMonth, fmtShortDate, toISODate, pad2,
  sessionsWord, cap, plural, timeToMin,
} from '../format.js'
```

(b) Replace `TodayThread` — its header row and empty state move out (the page eyebrow now carries the day progress, and the hero owns the free-day state; `Dashboard` only renders the thread when sessions exist):

```jsx
// today's sessions on the day thread — the hero's working half
function TodayThread({ sessions, nowMin, onOpen, onCalendar }) {
  const MAX = 4
  const shown = sessions.slice(0, MAX)
  const hidden = sessions.length - shown.length
  const running = sessions.find(
    (s) => s.status === 'scheduled' && timeToMin(s.time) <= nowMin && nowMin < timeToMin(s.time) + s.duration
  )
  const nextId = sessions.find((s) => s.status === 'scheduled' && timeToMin(s.time) > nowMin)?.id

  return (
    <div className="dash-hero__day" data-reveal>
      <div className="spine">
        <span className="spine__rule" data-spine aria-hidden="true" />
        {shown.map((s, i) => {
          const nowHere = !running &&
            timeToMin(s.time) > nowMin &&
            (i === 0 || timeToMin(shown[i - 1].time) <= nowMin)
          return (
            <Fragment key={s.id}>
              {nowHere && <div className="spine__now" aria-hidden="true">teraz</div>}
              <button
                className={`spine__row ${s.status === 'completed' ? 'is-done' : ''} ${s.id === nextId ? 'is-next' : ''}`}
                style={{ '--node-color': s.psych?.color }}
                onClick={() => onOpen(s)}
              >
                <span className="spine__time">{s.time}</span>
                <span className="spine__name">{s.client?.name}</span>
                <span className="spine__meta">{s.psych?.name.split(' ')[0]}</span>
                <Icon
                  name={s.status === 'completed' ? 'check' : running?.id === s.id ? 'wave' : 'clock'}
                  size={14}
                  className="faint"
                />
              </button>
            </Fragment>
          )
        })}
        {hidden > 0 && (
          <button className="bpost-more" onClick={onCalendar}>
            Jeszcze {hidden} {sessionsWord(hidden)} — otwórz kalendarz →
          </button>
        )}
      </div>
    </div>
  )
}
```

(c) Leave `TODAY_SHORTCUTS`, `relDay`, `BoardPost`, `BoardComposer`, and `BoardDrawer` exactly as they are.

(d) Replace the entire `Dashboard` function:

```jsx
export function Dashboard() {
  const { state } = useApp()
  const { navigate, openSessionForm, openClientForm, openTeamBoard, role } = useShell()
  const ref = useReveal()

  const now = new Date()
  const today = toISODate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const workspace = todayWorkspace(state, role, now)
  const heroSession = workspace.current || workspace.next

  const psychOf = (id) => state.psychologists.find((p) => p.id === id)
  const clientOf = (id) => state.clients.find((c) => c.id === id)

  const todays = workspace.schedule
    .map((s) => ({ ...s, psych: psychOf(s.psychId), client: clientOf(s.clientId) }))
  const doneCount = todays.filter((session) => session.status === 'completed').length
  const shortcuts = TODAY_SHORTCUTS.filter((shortcut) => !shortcut.roles || shortcut.roles.includes(role.id))
  const heroPsych = heroSession ? psychOf(heroSession.psychId) : null
  const heroClient = heroSession ? clientOf(heroSession.clientId) : null

  // the eyebrow is the whole page header: role, date, day progress
  const eyebrow = [
    role.id === 'therapist' && 'Mój dzień',
    `${cap(fmtWeekday(today))}, ${fmtDayMonth(today)}`,
    heroSession && `${doneCount} z ${todays.length} sesji za Tobą`,
    workspace.current && 'trwa teraz',
  ].filter(Boolean).join(' · ')

  return (
    <section className="today-page" role="region" aria-label="Pulpit dnia" ref={ref}>
      <header className="today-hero" data-reveal>
        <p className="eyebrow">{eyebrow}</p>
        {heroSession ? (
          <>
            <h1 className="display today-hero__time">{heroSession.time}</h1>
            <p className="display today-hero__name">{heroClient?.name}</p>
            <p className="today-hero__meta">
              {heroPsych?.room || 'Gabinet do potwierdzenia'} · {heroPsych?.name}
            </p>
          </>
        ) : (
          <>
            <h1 className="display today-hero__title">
              {todays.length > 0 ? 'Wszystko za Tobą' : 'Wolny dzień'}
            </h1>
            <p className="today-hero__meta">
              {todays.length > 0
                ? `${doneCount} z ${todays.length} sesji zakończonych`
                : 'Kalendarz jest dziś pusty — czas na oddech.'}
            </p>
          </>
        )}
        <div className="today-hero__actions">
          {heroSession && (
            <Button magnetic onClick={() => openSessionForm({ session: heroSession })}>Otwórz sesję</Button>
          )}
          <Button
            variant={heroSession ? 'ghost' : 'primary'}
            icon="plus"
            magnetic={!heroSession}
            onClick={() => openSessionForm()}
          >
            Nowa sesja
          </Button>
          <button className="link" onClick={() => openClientForm()}>Nowy klient</button>
        </div>
      </header>

      {todays.length > 0 && (
        <>
          <hr className="today-rule" aria-hidden="true" />
          <section className="today-plan" aria-label="Plan dnia">
            <TodayThread
              sessions={todays}
              nowMin={nowMin}
              onOpen={(s) => openSessionForm({ session: state.sessions.find((x) => x.id === s.id) })}
              onCalendar={() => navigate('calendar')}
            />
          </section>
        </>
      )}

      {workspace.attention.length > 0 && (
        <section className="today-attn" aria-label="Wymaga uwagi" data-reveal>
          {workspace.attention.slice(0, 2).map((item) => {
            const session = state.sessions.find((entry) => entry.id === item.sessionId)
            const client = session && clientOf(session.clientId)
            const canOpenPayments = role.id !== 'therapist'
            return (
              <button
                key={item.sessionId}
                className="today-attn__row"
                onClick={() => canOpenPayments
                  ? navigate('payments', { allPeriods: true, unpaidOnly: true })
                  : openSessionForm({ session })}
              >
                <Icon name="payments" size={15} />
                <span><b>{client?.name || 'Klient'}</b> · zaległa płatność {fmtMoney(item.amount)}</span>
                <Icon name="chevR" size={14} className="faint" />
              </button>
            )
          })}
        </section>
      )}

      <hr className="today-rule" aria-hidden="true" />
      <section className="today-links" aria-label="Skróty" data-reveal>
        {shortcuts.map((shortcut) => (
          <button
            key={shortcut.id}
            className="today-links__item"
            onClick={() => shortcut.id === 'board' ? openTeamBoard() : navigate(shortcut.id)}
          >
            {shortcut.label}
          </button>
        ))}
      </section>
    </section>
  )
}
```

- [ ] **Step 5: Replace the dashboard CSS**

In `src/styles.css`, replace everything from the comment `/* Today is a viewport-sized command centre on desktop. …` (line ~2246) through the `.today-shortcut:hover` rule (line ~2436) with:

```css
/* Today is a minimal, viewport-sized stage: the nearest session in the
   spotlight, the day plan beneath it, everything else a quiet footnote. */
.content--dashboard {
  display: flex;
  padding-top: 24px;
  padding-bottom: 24px;
}
.content--dashboard > .view {
  display: flex;
  width: 100%;
  min-height: 100%;
}
.today-page {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: clamp(14px, 2.8vh, 26px);
  text-align: center;
}
.today-hero { display: flex; flex-direction: column; align-items: center; min-width: 0; max-width: 100%; }
.today-hero__time {
  margin-top: clamp(8px, 2vh, 18px);
  font-size: clamp(42px, 8vh, 64px);
  font-weight: 520;
  line-height: 1;
  color: var(--rose-deep);
  font-variant-numeric: tabular-nums;
}
.today-hero__name { margin-top: 8px; font-size: clamp(19px, 3vh, 25px); font-weight: 500; }
.today-hero__title { margin-top: clamp(8px, 2vh, 18px); font-size: clamp(26px, 5vh, 36px); font-weight: 500; }
.today-hero__meta { margin-top: 5px; color: var(--ink-soft); font-size: 13px; }
.today-hero__actions {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-top: clamp(12px, 2.4vh, 20px);
}
.today-rule {
  width: min(320px, 58%);
  border: 0;
  border-top: 1px solid var(--line);
  margin: 0;
}
.today-plan { width: min(560px, 100%); text-align: left; }
.dash-hero__day { min-width: 0; }
.spine__row.is-next .spine__time { color: var(--rose-deep); font-size: 19px; }
.spine__row.is-next .spine__name { font-size: 15px; }
.today-attn { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.today-attn__row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  color: var(--gold-deep);
  font-size: 13px;
}
.today-attn__row b { color: var(--ink); }
button.today-attn__row:hover b { color: var(--rose-deep); }
.today-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 26px; }
.today-links__item { font-size: 13px; font-weight: 600; color: var(--ink-soft); transition: color var(--dur-fast); }
.today-links__item:hover { color: var(--rose-deep); }
```

Then update the three media-query blocks that immediately follow:

`@media (max-width: 900px)` — keep the `.content--dashboard`/`.view`/`.today-page` lines, delete the `.today-command` and `.today-primary` lines:

```css
@media (max-width: 900px) {
  .content--dashboard { display: block; padding-bottom: 72px; }
  .content--dashboard > .view { display: block; min-height: 0; }
  .today-page { min-height: 0; }
}
```

`@media (max-width: 640px)` — keep the `.content--dashboard` line, replace the `.today-head*`/`.today-focus*` lines:

```css
@media (max-width: 640px) {
  .content--dashboard { padding-top: 22px; padding-bottom: calc(96px + env(safe-area-inset-bottom)); }
  .today-hero__actions { width: 100%; }
  .today-hero__actions .btn { flex: 1 1 100%; justify-content: center; min-height: 42px; }
}
```

`@media (max-width: 360px)` block (with the "smallest supported phone" comment) — replace only the dashboard lines (`.today-head__actions`, `.today-focus*`, `.today-stats`, `.today-stat`, `.today-attention__row*`, `.today-shortcuts__grid`) with the single rule below; keep the `.agenda__row` line and everything after it unchanged:

```css
@media (max-width: 360px) {
  .today-attn__row { white-space: normal; overflow-wrap: anywhere; line-height: 1.3; text-align: left; }
```

Verify no dangling selectors remain: `grep -n "today-head\|today-command\|today-primary\|today-region\|today-focus\|today-side\|today-stats\|today-stat\b\|today-calm\|today-shortcut\|today-attention\|dash-hero__day-head" src/styles.css src/views/Dashboard.jsx` must return nothing.

- [ ] **Step 6: Run the five updated tests**

Run: `npx playwright test tests/e2e/workspace.spec.js -g "mock-data workspace|essential daily regions|compact viewport|narrow phone|active therapist"`
Expected: PASS (5 passed)

- [ ] **Step 7: Run the whole e2e suite**

Run: `npx playwright test`
Expected: everything passes, matching the Step 1 baseline count minus/plus nothing. Pay attention to the board tests, both attention tests, and `Today keeps the page itself fixed on a short desktop viewport` (no-scroll at 1280×600) — if that one fails, reduce the `clamp()` maxima in `.today-hero__time`/`.today-hero__title` and the `.today-page` gap until it fits; do NOT touch the test.

- [ ] **Step 8: Commit**

```bash
git add src/views/Dashboard.jsx src/styles.css tests/e2e/workspace.spec.js
git commit -m "feat: restyle dashboard into a minimal hero stage"
```

---

### Task 2: README update and final verification

**Files:**
- Modify: `README.md:22`

**Interfaces:**
- Consumes: the shipped dashboard from Task 1.
- Produces: nothing downstream — this closes out the feature.

- [ ] **Step 1: Rewrite the "Pulpit" bullet**

In `README.md`, replace the line:

```markdown
- **Pulpit** — karty statystyk z licznikami (klienci, sesje, godziny, przychód, zaległości), wykres przychodu z 6 miesięcy, najbliższe sesje, podsumowanie zespołu.
```

with:

```markdown
- **Pulpit** — minimalistyczna „scena dnia": najbliższa sesja w dużej typografii, oś czasu dzisiejszych spotkań, dyskretna linia zaległości i skróty tekstowe.
```

- [ ] **Step 2: Run unit tests and the production build**

Run: `npm test && npm run build`
Expected: unit tests pass (they cover TUS logic, untouched), build succeeds with no unused-import warnings from `Dashboard.jsx`.

- [ ] **Step 3: Visual spot-check (screenshots)**

With the dev server running (`npm run dev -- --host 127.0.0.1`), save this as `shots.mjs` in the scratchpad directory (NOT the repo) and run `node shots.mjs`:

```js
import { chromium } from '/Users/mateusz/dev/julia/node_modules/@playwright/test/index.mjs'

const shots = [
  ['desktop', { width: 1440, height: 900 }],
  ['short', { width: 1280, height: 600 }],
  ['phone', { width: 360, height: 800 }],
]
const browser = await chromium.launch()
for (const [name, viewport] of shots) {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.goto('http://127.0.0.1:5173/julia/')
  await page.getByLabel('Hasło').fill('demo')
  await page.getByRole('button', { name: 'Zaloguj się' }).click()
  await page.getByRole('region', { name: 'Pulpit dnia' }).waitFor()
  await page.screenshot({ path: `dashboard-${name}.png` })
  await ctx.close()
}
await browser.close()
```

Read the three PNGs and confirm against the approved C1 mockup:
- `desktop` → hero centered, no card boxes, timeline beneath, quiet attention line, text-link shortcuts;
- `short` → everything visible without scrolling;
- `phone` → stacked hero, full-width action buttons, no horizontal overflow.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe the minimal hero dashboard in the readme"
```
