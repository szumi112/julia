# Kalendarz Streamline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declutter the Kalendarz page: remove the date-preset filter system, collapse payment/attendance filters behind one "Filtry" button, merge the chrome into a single toolbar, and delete dead code — per `docs/superpowers/specs/2026-07-11-kalendarz-streamline-design.md`.

**Architecture:** All UI work happens in `src/views/Calendar.jsx` (single view component) plus its CSS block in `src/styles.css`. The shared filter helper `sessionMatchesFilters` in `src/workspace.js` narrows to payment+attendance only. One new icon (`filter`) in `src/icons.jsx`. Tests: `tests/unit/workspace.test.js` (node test runner) and `tests/e2e/workspace.spec.js` (Playwright, auto-starts dev server).

**Tech Stack:** React 18 + Vite, plain CSS in `src/styles.css`, GSAP (CDN) for motion, Playwright e2e, `node --test` unit tests.

## Global Constraints

- All user-facing copy is Polish; match existing tone (e.g. "Wyczyść filtry", "Płatność", "Obecność").
- Do not touch: session form, store, other views, mobile layout structure.
- Reuse existing UI primitives from `src/ui.jsx` (`Button`, `Chip`, `IconBtn`, `Segmented`, `EmptyState`) — no new one-off components.
- Commit messages: Conventional Commits, no AI/tool mentions, no co-author trailers.
- Commands run from repo root `/Users/mateusz/dev/julia`.
- Unit tests: `npm test`. E2E: `npx playwright test` (starts its own dev server; make sure no stale `vite preview`/`npm run dev` is holding the port).

---

### Task 1: Narrow `sessionMatchesFilters` to payment + attendance

The calendar no longer date-filters, and it is the helper's only production consumer. Drop the date clauses (YAGNI).

**Files:**
- Modify: `src/workspace.js:24-30`
- Test: `tests/unit/workspace.test.js:70-80`

**Interfaces:**
- Produces: `sessionMatchesFilters(session, filters)` where `filters` is `{ payment: 'all'|'paid'|'partial'|'unpaid', attendance: 'all'|'completed'|'noshow'|'cancelled'|'scheduled' }`. Task 2's Calendar state relies on exactly this shape.

- [ ] **Step 1: Rewrite the unit test to the new contract**

Replace the test at `tests/unit/workspace.test.js:70-80` with:

```js
test('session filters combine payment and attendance constraints', () => {
  const filters = { payment: 'partial', attendance: 'completed' }
  assert.equal(sessionMatchesFilters(state.sessions[1], filters), true)
  assert.equal(sessionMatchesFilters({ ...state.sessions[1], payment: 'unpaid' }, filters), false)
  assert.equal(sessionMatchesFilters({ ...state.sessions[1], status: 'noshow' }, filters), false)
  assert.equal(sessionMatchesFilters(state.sessions[1], { payment: 'all', attendance: 'all' }), true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: the last assertion passes already, but the third (`status: 'noshow'`) passes too — the test as a whole PASSES against the old implementation (it is a superset). To pin the new contract, verify instead that no other test still exercises `dateFrom`/`dateTo`: `grep -n "dateFrom" tests/unit/workspace.test.js` → no matches after the edit.

- [ ] **Step 3: Narrow the implementation**

Replace `src/workspace.js:24-30` with:

```js
export const sessionMatchesFilters = (session, filters) => {
  const paymentMatches = filters.payment === 'all' || session.payment === filters.payment
  const attendanceMatches = filters.attendance === 'all' || session.status === filters.attendance
  return paymentMatches && attendanceMatches
}
```

- [ ] **Step 4: Run unit tests**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workspace.js tests/unit/workspace.test.js
git commit -m "refactor: narrow session filters to payment and attendance"
```

Note: `src/views/Calendar.jsx` still passes `dateFrom`/`dateTo` at this point; the extra keys are simply ignored by the new implementation, so the app keeps working until Task 2 removes them.

---

### Task 2: Collapse calendar filters behind a "Filtry" toggle and merge the toolbar

**Files:**
- Modify: `src/views/Calendar.jsx` (constants at 17-59, state at 137, JSX at 480-544, helpers at 330-343, `filterKey` at 317, `is-filtered-out` at 617)
- Modify: `src/icons.jsx` (add `filter` icon after `menu` at line 154)
- Modify: `src/styles.css:1475-1505` (replace `.cal-filter-rail` block), delete `.cal__day.is-filtered-out` rule at 1544
- Test: `tests/e2e/workspace.spec.js` (tests at lines 342, 393, 418)

**Interfaces:**
- Consumes: `sessionMatchesFilters(session, { payment, attendance })` from Task 1; `Chip`, `Button` from `src/ui.jsx` (`Chip` props: `on`, `onClick`; `Button` props: `variant`, `size`, `icon`).
- Produces: markup contract for e2e — a toolbar button whose accessible name starts with "Filtry" (with `aria-expanded`), groups `role="group"` named "Płatność" and "Obecność klienta" rendered only while expanded, and a "Wyczyść filtry" button while any filter is active.

- [ ] **Step 1: Update the three affected e2e tests first**

In `tests/e2e/workspace.spec.js`:

(a) Test `'calendar exposes explicit payment and attendance reset choices'` (line 342) — after the Kalendarz nav click, assert collapsed-by-default and expand:

```js
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
```

(b) Test `'calendar combines date, payment, and attendance filters after role scope'` (line 393) — rename and route through the toggle; assert the badge count:

```js
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
```

(c) Delete the whole test `'custom month range dims the selected out-of-range day and filters its sessions'` (lines 418-445) — the feature is removed.

(d) Add a new test (place it right after test (b)) asserting the month grid is no longer starved by a default date filter:

```js
test('month view shows sessions across the whole month by default', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Kalendarz' }).click()
  await page.getByRole('radio', { name: 'Miesiąc' }).click()
  expect(await page.locator('.cal__day:has(.cal__item)').count()).toBeGreaterThan(1)
})
```

- [ ] **Step 2: Run the updated e2e tests to verify they fail**

Run: `npx playwright test tests/e2e/workspace.spec.js -g "calendar|month view" 2>&1 | tail -20`
Expected: FAIL — `getByRole('group', { name: 'Płatność' })` resolves to 1 element where 0 expected (filters are not yet collapsed), and the "month view" test fails (only today's cell has items).

- [ ] **Step 3: Add the `filter` icon**

In `src/icons.jsx`, after the `menu` entry (line 154), add:

```jsx
  filter: <path d="M4 6h16M7.5 12h9M10.5 18h3" />,
```

- [ ] **Step 4: Rework Calendar.jsx state and constants**

In `src/views/Calendar.jsx`:

(a) Delete the `DATE_PRESETS` constant (lines 17-21) and the `dateBoundsFor` function (lines 36-52).

(b) Replace `defaultCalendarFilters` (lines 54-59) with:

```js
const defaultCalendarFilters = () => ({ payment: 'all', attendance: 'all' })
```

(c) In the component body, next to the existing `filters` state (line 137), add:

```js
const [filtersOpen, setFiltersOpen] = useState(false)
```

(d) Delete `selectDatePreset`, `setCustomDate` (lines 330-335) and `isOutsideDateRange` (lines 339-340). Replace `hasActiveFilters` (lines 341-342) and add a count:

```js
const activeFilterCount =
  (filters.payment !== 'all' ? 1 : 0) + (filters.attendance !== 'all' ? 1 : 0)
const hasActiveFilters = activeFilterCount > 0
```

(e) Update `filterKey` (line 317) to:

```js
const filterKey = `${ym}|${filters.payment}|${filters.attendance}`
```

(f) Remove `toISODate`-dependent leftovers only if unused — `toISODate` is still used elsewhere (`today`, drag logic), keep the import. Remove nothing else from imports in this task.

- [ ] **Step 5: Replace the filter rail + toolbar JSX**

Delete the entire `<section className="cal-filter-rail">…</section>` (lines 480-523) and the old toolbar `<div className="row row--between cal-toolbar">…</div>` (lines 525-544). In their place put a single toolbar followed by a conditionally rendered filter row (no `data-reveal` on the conditional section — it mounts after the view's reveal pass):

```jsx
      <div className="row row--between cal-toolbar" data-reveal>
        <div className="row" style={{ gap: 14 }}>
          <div className="month-nav">
            <IconBtn name="chevL" label="Poprzedni miesiąc" disabled={ym <= monthsRange[0]} onClick={() => changeMonth(-1)} />
            <span className="month-nav__label">{fmtMonthYear(ym)}</span>
            <IconBtn name="chevR" label="Następny miesiąc" disabled={ym >= monthsRange[monthsRange.length - 1]} onClick={() => changeMonth(1)} />
          </div>
          {ym !== curYm && (
            <Button variant="ghost" size="sm" onClick={() => { setYm(curYm); setSelected(today) }}>
              Dziś
            </Button>
          )}
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="faint" aria-live="polite" style={{ fontSize: 13.5 }}>
            {monthSessions.length} {sessionsWord(monthSessions.length)} w tym miesiącu
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon="filter"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filtry{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <section className="cal-filters" aria-label="Filtry kalendarza">
          <div className="cal-filters__group" role="group" aria-label="Płatność">
            <span className="cal-filters__label">Płatność</span>
            {PAYMENT_FILTERS.map((payment) => (
              <Chip key={payment.value} on={filters.payment === payment.value} onClick={() => toggleFilter('payment', payment.value)}>
                {payment.label}
              </Chip>
            ))}
          </div>
          <div className="cal-filters__group" role="group" aria-label="Obecność klienta">
            <span className="cal-filters__label">Obecność</span>
            {ATTENDANCE_FILTERS.map((attendance) => (
              <Chip key={attendance.value} on={filters.attendance === attendance.value} onClick={() => toggleFilter('attendance', attendance.value)}>
                {attendance.label}
              </Chip>
            ))}
          </div>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={() => setFilters(defaultCalendarFilters)}>
              Wyczyść filtry
            </Button>
          )}
        </section>
      )}
```

Then remove the now-orphaned pieces further down:
- In the month-grid day `className` array (line 617), delete the line `` isOutsideDateRange(cell.iso) ? 'is-filtered-out' : '', ``.
- The old toolbar's hint span (`cal-hint`) disappears with the deleted block — Task 3 removes its CSS.

- [ ] **Step 6: Replace the CSS**

In `src/styles.css`, replace the whole `.cal-filter-rail` block (lines 1475-1505, including the comment and the `@media (max-width: 640px)` block) with:

```css
/* Calendar filters stay collapsed behind the toolbar's "Filtry" toggle;
   the expanded row wraps instead of hiding any option on small views. */
.cal-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 18px;
  margin-bottom: 18px;
  padding: 12px 14px;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--paper) 92%, transparent);
}
.cal-filters__group { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.cal-filters__label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
```

Also delete the rule `.cal__day.is-filtered-out { opacity: 0.48; }` (line 1544).

- [ ] **Step 7: Run the e2e calendar tests**

Run: `npx playwright test tests/e2e/workspace.spec.js -g "calendar|month view" 2>&1 | tail -20`
Expected: PASS (all calendar-related tests, including the new month-view test).

- [ ] **Step 8: Commit**

```bash
git add src/views/Calendar.jsx src/icons.jsx src/styles.css tests/e2e/workspace.spec.js
git commit -m "feat: collapse calendar filters behind a single toolbar toggle"
```

---

### Task 3: Remove the dead list view, drag-hint noise, and sharpen empty states

**Files:**
- Modify: `src/views/Calendar.jsx` (list branch at former lines 693-754, `listDays` memo at 357-360, `listFlipRef` at 321, empty states at 566-572 / 675-682)
- Modify: `src/styles.css` (`.cal-hint` rules at 1625-1626)

**Interfaces:**
- Consumes: nothing new.
- Produces: `mode` is strictly `'agenda' | 'cal'`; the view render is a two-branch ternary.

- [ ] **Step 1: Delete the unreachable list view**

In `src/views/Calendar.jsx`:

(a) The final render ternary currently ends with an unreachable list branch (`) : (` … `<div className="stack" ref={listFlipRef} …>` … `)}`). Replace the three-branch ternary tail so the month grid is the plain `else`:

```jsx
      {mode === 'agenda' ? (
        <>…day strip + agenda card (unchanged)…</>
      ) : (
        <div className="grid-31" data-reveal>…month grid + day panel (unchanged)…</div>
      )}
```

i.e. change `) : mode === 'cal' ? (` to `) : (` and delete everything from the list branch's `) : (` through its closing `)}` (the `<div className="stack" ref={listFlipRef}…>` block with the per-day tables), keeping the final `)}`.

(b) Delete the `listDays` memo (lines 357-360) and the `listFlipRef` line (`const listFlipRef = useFlip(\`list|${filterKey}\`)`, line 321).

(c) Clean imports now orphaned by the removed table markup — after the deletion, verify each of these is still referenced before keeping it: `Fragment` (still used in `dayThread`), `sessionsInMonth` (still used for `monthSessions`), `StatusPicker`/`PaymentPicker` (still used in `dayRow`). Nothing else should become unused; confirm with `npx eslint src/views/Calendar.jsx` if eslint is configured, otherwise `grep` each import name within the file.

- [ ] **Step 2: Sharpen the empty-state copy**

Both `EmptyState` usages (agenda card and month-view day panel) currently read `hint="Dodaj sesję przyciskiem poniżej."`. Change both to:

```jsx
<EmptyState
  compact
  icon="calendar"
  title="Brak sesji tego dnia"
  hint="Dodaj pierwszą sesję przyciskiem poniżej."
/>
```

- [ ] **Step 3: Remove the drag-hint CSS**

In `src/styles.css`, delete lines 1625-1626:

```css
.cal-hint { color: var(--ink-faint); }
@media (max-width: 1024px) { .cal-hint { display: none; } }
```

Verify no `.cal-hint` reference remains: `grep -rn "cal-hint" src/` → no matches.

- [ ] **Step 4: Run the full test suite**

Run: `npm test && npx playwright test 2>&1 | tail -5`
Expected: unit tests PASS; e2e suite PASS (no test referenced the list view).

- [ ] **Step 5: Commit**

```bash
git add src/views/Calendar.jsx src/styles.css
git commit -m "refactor: drop the dead calendar list view and hint noise"
```

---

### Task 4: End-to-end verification and visual check

**Files:**
- No source changes expected; fixes only if verification finds regressions.

**Interfaces:** none.

- [ ] **Step 1: Full automated suite**

Run: `npm test && npx playwright test 2>&1 | tail -5`
Expected: all PASS.

- [ ] **Step 2: Build and screenshot both modes**

```bash
npm run build
npx vite preview &   # http://localhost:4173/julia/  (IPv6 localhost, not 127.0.0.1)
```

Drive with Playwright (import `/Users/mateusz/dev/julia/node_modules/@playwright/test/index.mjs`; login = any non-empty email+password; navigate by clicking the "Kalendarz" nav label; `reducedMotion: 'reduce'`). Capture:
1. Plan dnia default view — verify: no filter panel, single toolbar row, day strip directly under it.
2. Filtry expanded with one active filter — verify badge reads "Filtry · 1".
3. Miesiąc view — verify sessions visible on multiple days, no dimmed cells, no hint sentence.

Read the screenshots and check them against the spec's goals (clean opening, obvious actions). Kill the preview server afterwards.

- [ ] **Step 3: Fix anything found, re-run, commit if changes were made**

Any visual defect (spacing, wrap, misalignment) gets fixed in `src/styles.css` and committed:

```bash
git add -A src/
git commit -m "fix: polish calendar toolbar spacing"
```
