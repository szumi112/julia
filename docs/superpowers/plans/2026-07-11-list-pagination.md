# List Pagination Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classic pagination as an invisible-until-needed fallback for the three unbounded lists (Finanse month table, Klienci roster, client-detail history) — per `docs/superpowers/specs/2026-07-11-list-pagination-design.md`.

**Architecture:** Pure page math in a new dependency-free `src/pagination.js` (node-testable); `usePagination` hook and `Pager` component join the shared primitives in `src/ui.jsx`; three views consume them. `Pager` renders `null` at ≤1 page, so today's demo volumes show no UI except where a list genuinely overflows.

**Tech Stack:** React 18 + Vite, plain CSS in `src/styles.css`, `node --test` unit tests, Playwright e2e (auto-starts dev server).

## Global Constraints

- All user-facing copy Polish: "Poprzednia strona", "Następna strona", "Strona X z Y", `nav aria-label="Stronicowanie"`.
- Page sizes: 25 (Finanse table, Klienci roster), 10 (client history).
- `resetKey` is the caller's filter signature, never the items array — data edits must not reset the page.
- Reuse existing primitives (`IconBtn`); no new one-off components beyond `Pager`.
- Commit messages: Conventional Commits, no AI/tool mentions, no co-author trailers.
- Commands run from repo root `/Users/mateusz/dev/julia`. Unit: `npm test`. E2E: `npx playwright test` (kill stale vite processes first: `pkill -f vite`; run suites in the foreground).
- Do not touch: calendar, dashboard, TUS views, store, session/client forms.

---

### Task 1: Pure page math + `usePagination` + `Pager` primitive

**Files:**
- Create: `src/pagination.js`
- Create: `tests/unit/pagination.test.js`
- Modify: `src/ui.jsx` (append hook + component; extend the react import)
- Modify: `src/styles.css` (append `.pager` rules after the `.month-nav` block, around line 1620)

**Interfaces:**
- Consumes: `IconBtn` already defined in `src/ui.jsx` (`{ name, label, size, className, ...rest }`, spreads `disabled`/`onClick`).
- Produces (used verbatim by Tasks 2-3):
  - `pageCount(total, pageSize)` → integer ≥ 1 (from `src/pagination.js`)
  - `pageSlice(items, page, pageSize)` → array (1-based `page`)
  - `usePagination(items, { pageSize, resetKey })` → `{ pageItems, page, pages, setPage }` (from `src/ui.jsx`)
  - `<Pager page={page} pages={pages} onPage={setPage} />` (from `src/ui.jsx`)

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/pagination.test.js`:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { pageCount, pageSlice } from '../../src/pagination.js'

test('an empty list still has one page', () => {
  assert.equal(pageCount(0, 25), 1)
})

test('page count rounds up partial pages', () => {
  assert.equal(pageCount(25, 25), 1)
  assert.equal(pageCount(26, 25), 2)
  assert.equal(pageCount(51, 25), 3)
})

test('pageSlice returns the requested 1-based page', () => {
  const items = Array.from({ length: 30 }, (_, i) => i)
  assert.deepEqual(pageSlice(items, 1, 25), items.slice(0, 25))
  assert.deepEqual(pageSlice(items, 2, 25), items.slice(25))
})

test('pageSlice beyond the last page is empty', () => {
  assert.deepEqual(pageSlice([1, 2], 5, 25), [])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '../../src/pagination.js'` (test runner exits non-zero).

- [ ] **Step 3: Implement the pure helpers**

Create `src/pagination.js`:

```js
// Pure page math for the shared pagination fallback (see ui.jsx: usePagination/Pager).
export const pageCount = (total, pageSize) => Math.max(1, Math.ceil(total / pageSize))
export const pageSlice = (items, page, pageSize) => items.slice((page - 1) * pageSize, page * pageSize)
```

- [ ] **Step 4: Run unit tests**

Run: `npm test 2>&1 | tail -5`
Expected: PASS (all tests, including the pre-existing 35).

- [ ] **Step 5: Add `usePagination` and `Pager` to `src/ui.jsx`**

`src/ui.jsx` currently starts with:

```js
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
```

(verify — if the import list differs, just ensure `useEffect` and `useState` are present). Add below the existing imports:

```js
import { pageCount, pageSlice } from './pagination.js'
```

Append at the end of the file:

```jsx
// Pagination fallback for long lists: invisible at one page, classic pager beyond.
// resetKey = the caller's filter signature (never the items array), so data
// edits keep the current page while filter changes jump back to page 1.
export function usePagination(items, { pageSize, resetKey }) {
  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [resetKey])
  const pages = pageCount(items.length, pageSize)
  const current = Math.min(page, pages)
  return { pageItems: pageSlice(items, current, pageSize), page: current, pages, setPage }
}

export function Pager({ page, pages, onPage }) {
  if (pages <= 1) return null
  return (
    <nav className="pager" aria-label="Stronicowanie">
      <IconBtn name="chevL" label="Poprzednia strona" disabled={page <= 1} onClick={() => onPage(page - 1)} />
      <span className="pager__label" aria-live="polite">Strona {page} z {pages}</span>
      <IconBtn name="chevR" label="Następna strona" disabled={page >= pages} onClick={() => onPage(page + 1)} />
    </nav>
  )
}
```

- [ ] **Step 6: Add the CSS**

In `src/styles.css`, directly after the `.month-nav__label` media-query block (search for `.month-nav__label { min-width: 142px`), append:

```css
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 14px;
}
.pager__label {
  font-size: 12.5px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 7: Full unit suite + build sanity**

Run: `npm test 2>&1 | tail -3 && npm run build 2>&1 | tail -2`
Expected: tests PASS; vite build succeeds (proves ui.jsx parses). Then `git checkout -- dist` (build output is tracked; keep it out of this commit).

- [ ] **Step 8: Commit**

```bash
git add src/pagination.js src/ui.jsx src/styles.css tests/unit/pagination.test.js
git commit -m "feat: add shared pagination helpers and pager primitive"
```

---

### Task 2: Paginate the Finanse month table

**Files:**
- Modify: `src/views/Payments.jsx` (import at line 5, hook near line 47, rows at line 239, pager after the table)
- Test: `tests/e2e/workspace.spec.js` (add one test after `'Payments exposes an all-status control to reverse unpaid filtering'`)

**Interfaces:**
- Consumes: `usePagination(items, { pageSize, resetKey })` → `{ pageItems, page, pages, setPage }` and `<Pager page pages onPage />` from `src/ui.jsx` (Task 1).
- Produces: e2e contract — a `nav` named "Stronicowanie" with buttons "Poprzednia strona"/"Następna strona" under the Finanse table whenever a scope has > 25 rows.

- [ ] **Step 1: Write the failing e2e test**

The demo generator seeds ~190 sessions over ~4 months, so the previous calendar month has well over 25 billable rows. Add to `tests/e2e/workspace.spec.js` (after the `'Payments exposes an all-status control to reverse unpaid filtering'` test):

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pkill -f vite; npx playwright test tests/e2e/workspace.spec.js -g "paginates a month" 2>&1 | tail -4`
Expected: FAIL — the "Stronicowanie" navigation does not exist yet.

- [ ] **Step 3: Wire the hook into Payments**

In `src/views/Payments.jsx`:

(a) Extend the ui.jsx import (line 5) with the two new names:

```js
import { Avatar, Pill, Chip, IconBtn, Button, InfoTip, EmptyState, Figure, usePagination, Pager } from '../ui.jsx'
```

(b) Replace the `flipRef` line (`const flipRef = useFlip(filtered.map((s) => s.id).join(','))`) with:

```js
const { pageItems, page, pages, setPage } = usePagination(filtered, {
  pageSize: 25,
  resetKey: `${allPeriods}|${ym}|${psychFilter}|${unpaidOnly}`,
})
const flipRef = useFlip(pageItems.map((s) => s.id).join(','))
```

(c) Change the row loop `{filtered.map((s) => {` to `{pageItems.map((s) => {` (the empty-state row above it keeps testing `filtered.length`).

(d) After the table's closing `</table>` and its wrapping `</div>` (the `table-scroll` container), still inside the card, add:

```jsx
<Pager page={page} pages={pages} onPage={setPage} />
```

Aggregates (`collected`, `outstanding`, figures, per-psych bars) intentionally keep using `filtered`/`scopeBillable` — they describe the whole scope, not the visible page.

- [ ] **Step 4: Run the new test + the payments/attention tests**

Run: `npx playwright test tests/e2e/workspace.spec.js -g "paginates a month|Payments|attention" 2>&1 | tail -4`
Expected: all PASS (the two attention tests assert `tr.is-due` non-zero on the all-periods unpaid scope — page 1 of that scope still contains due rows).

- [ ] **Step 5: Commit**

```bash
git add src/views/Payments.jsx tests/e2e/workspace.spec.js
git commit -m "feat: paginate the payments settlement table"
```

---

### Task 3: Paginate the Klienci roster and client history

**Files:**
- Modify: `src/views/Clients.jsx` (import at line 5, roster hook at line 40, roster rows at line 119, roster pager after the table; history at lines 206/370-384 in the `ClientDetail` component)
- Test: `tests/e2e/workspace.spec.js` (one test after `'switching to therapist ignores a previous team client filter'`)

**Interfaces:**
- Consumes: `usePagination(items, { pageSize, resetKey })` → `{ pageItems, page, pages, setPage }` and `<Pager page pages onPage />` from `src/ui.jsx` (Task 1).
- Produces: nothing relied on by later tasks (final wiring task).

- [ ] **Step 1: Write the failing e2e test**

Add to `tests/e2e/workspace.spec.js` (after `'switching to therapist ignores a previous team client filter'`):

```js
test('short lists render fully without a pager and history caps at ten rows', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation').getByRole('button', { name: 'Klienci' }).click()
  // 19 demo clients < 25: full roster, no pager anywhere on the view
  expect(await page.locator('tbody tr').count()).toBeGreaterThan(15)
  await expect(page.getByRole('navigation', { name: 'Stronicowanie' })).toHaveCount(0)
  await page.getByRole('row', { name: /Zofia Mazur/ }).click()
  await expect(page.getByRole('heading', { name: 'Historia frekwencji' })).toBeVisible()
  const historyRows = await page.locator('.client-record__section:has(h2:text("Historia frekwencji")) tbody tr').count()
  expect(historyRows).toBeLessThanOrEqual(10)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx playwright test tests/e2e/workspace.spec.js -g "short lists" 2>&1 | tail -4`
Expected: the roster assertions pass, but the history-rows assertion FAILS if Zofia Mazur has more than 10 past sessions (the demo pins her as a long-running client). If it unexpectedly passes because her history is ≤ 10 rows at today's run date, note it — the wiring in Step 3 is still required by the spec, and the assertion remains as a regression cap.

- [ ] **Step 3: Wire both tables**

In `src/views/Clients.jsx`:

(a) Extend the ui.jsx import (line 5):

```js
import { Button, Avatar, Pill, Chip, SearchInput, IconBtn, EmptyState, usePagination, Pager } from '../ui.jsx'
```

(b) Roster (in `Clients()`): replace `const tbodyRef = useFlip(filtered.map((c) => c.id).join(','))` with:

```js
const { pageItems, page, pages, setPage } = usePagination(filtered, {
  pageSize: 25,
  resetKey: `${query}|${psychFilter}|${debtOnly}`,
})
const tbodyRef = useFlip(pageItems.map((c) => c.id).join(','))
```

Change the roster row loop `{filtered.map((c) => {` to `{pageItems.map((c) => {` (the empty-state row keeps testing `filtered.length`). After the roster table's closing `</table>` and its `table-scroll` wrapper `</div>`, still inside the card, add:

```jsx
<Pager page={page} pages={pages} onPage={setPage} />
```

(c) History (in `ClientDetail`, after `const history = all.filter((s) => !upcomingIds.has(s.id)).slice().reverse()`):

```js
const historyPages = usePagination(history, { pageSize: 10, resetKey: client.id })
```

Change the history row loop `{history.map((s) => (` to `{historyPages.pageItems.map((s) => (`. The surrounding conditional keeps testing `history.length > 0`. After the history table's `table-scroll` wrapper `</div>` closes (before the `) : (` of the empty-state ternary), add:

```jsx
<Pager page={historyPages.page} pages={historyPages.pages} onPage={historyPages.setPage} />
```

- [ ] **Step 4: Run the e2e file's client + pagination tests**

Run: `npx playwright test tests/e2e/workspace.spec.js -g "short lists|client|Klienci" 2>&1 | tail -4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/Clients.jsx tests/e2e/workspace.spec.js
git commit -m "feat: paginate the client roster and session history"
```

---

### Task 4: Full verification and visual check

**Files:**
- No source changes expected; fixes only if verification finds regressions.

**Interfaces:** none.

- [ ] **Step 1: Full automated suite**

Run: `pkill -f vite; npm test 2>&1 | tail -3 && npx playwright test 2>&1 | tail -3`
Expected: all PASS (unit incl. 4 new; e2e incl. 2 new).

- [ ] **Step 2: Build and visually verify**

```bash
npm run build
npx vite preview &   # http://localhost:4173/julia/ (IPv6 localhost, not 127.0.0.1)
```

Drive with Playwright (import `/Users/mateusz/dev/julia/node_modules/@playwright/test/index.mjs`, any non-empty login, `reducedMotion: 'reduce'`, viewport 1440×900; `.content` is the scroll container — scroll it or screenshot card locators). Capture and READ:
1. Finanse on the previous month — pager visible and centered under the table, "Strona 1 z N", chevrons aligned with the label.
2. Same view after clicking "Następna strona" — rows changed, label "Strona 2 z N", left chevron enabled.
3. Klienci roster — full list, no pager rendered.
4. A client card (Zofia Mazur) — history table ≤ 10 rows; pager present only if her history exceeds 10.

Check spacing/alignment against the app's aesthetic. Kill the preview server and `git checkout -- dist` afterwards.

- [ ] **Step 3: Fix anything found, re-run, commit if changes were made**

Visual defects get the smallest fix in `src/styles.css`:

```bash
git add src/styles.css
git commit -m "fix: polish pager spacing"
```
