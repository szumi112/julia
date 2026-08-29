# Staging Finance Visual Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the staging-only protected views (Finanse, Raporty, Rejestr, own payments) with the demo pages' motion and chart-rich feel, and add useful charts to the protected Finanse page.

**Architecture:** All chart data already arrives on the client through `loadFinanceWindow` (`kpis`, six-month `trend`, `splits`); new pure read-model helpers in `src/finance-charts.js` shape it for the existing hand-rolled `AreaChart`/`Donut`/`BarFill` components, and the demo's `useReveal`/`useCountUp` motion is applied to the protected views. No backend or demo-mode changes.

**Tech Stack:** React 18 (plain JSX), existing `charts.jsx` SVG charts, GSAP via `anim.js` (always behind `motionOK()`), single `styles.css` with CSS custom-property tokens, `node --test` unit tests, Playwright app-mode e2e.

**Spec:** `docs/superpowers/specs/2026-08-29-staging-finance-visuals-design.md`

## Global Constraints

- UI copy in Polish; code identifiers and comments in English (AGENTS.md).
- Never hardcode palette hex in CSS or JSX; chart colors resolve through CSS tokens (`tok()` in `charts.jsx` is the only place with hex fallbacks).
- Domain logic stays pure and JSX-free in `.js` modules so `node --test` can import it.
- All motion gated by `motionOK()`; every effect degrades to the final state.
- Keep the e2e contract from `tests/e2e/app-protected-visuals.spec.js`: Finanse shows 5 `.finance-window__kpi` cards with ≥4 distinct backgrounds; tabs `Przychody / Płatności i zaległości / Wydatki / Faktury`; Rejestr heading `Rejestr skoroszytów` and its 4 tabs.
- Deep tones keep ≥4.5:1 contrast on paper (AA); breakpoints: phone ≤ 640px, tablet ≤ 1024px.
- Reuse existing primitives (`card`, `grid-31`, `hbar`, `legend`, `Figure`/`Stat` patterns) — no new bespoke one-off styling where a shared class exists.
- Git: Conventional Commit subjects in English; branch `feat/staging-finance-visuals` (no ticket exists). Do NOT mention any AI tool in commits/PRs and do NOT add any `Co-Authored-By` trailer.
- Demo mode (`npm run dev`, `data.js`, demo views) must remain untouched.

## File Structure

- Create: `src/finance-charts.js` — pure chart read-models (payment mix, service ranks).
- Create: `tests/unit/finance-charts.test.js` — node --test coverage for the above.
- Modify: `src/ui.jsx` — add shared `MoneyKpi` primitive (count-up money card).
- Modify: `src/charts.jsx` — export `toneColor` (tone name → concrete color via `tok`).
- Modify: `src/views/ProtectedFinance.jsx` — motion + trend chart + insights grid.
- Modify: `src/views/OwnPayments.jsx` — motion + toned `MoneyKpi` cards.
- Modify: `src/views/ProtectedReports.jsx` — motion + shared `.chart-frame`.
- Modify: `src/views/Registry.jsx`, `src/views/WorkbookImport.jsx`, `src/views/WorkbookExport.jsx` — entrance reveal.
- Modify: `src/styles.css` — `.chart-frame` (renamed from `.report-window__chart`), `.finance-window__trend`, `.finance-window__insights`.
- Modify: `tests/e2e/app-protected-visuals.spec.js` — extended assertions.

---

### Task 0: Branch

- [ ] **Step 1: Create the working branch from up-to-date main**

```bash
cd /Users/mateusz/dev/julia
git checkout main && git pull && git checkout -b feat/staging-finance-visuals
```

---

### Task 1: Pure chart read-models (`finance-charts.js`)

**Files:**
- Create: `src/finance-charts.js`
- Test: `tests/unit/finance-charts.test.js`

**Interfaces:**
- Consumes: the finance window's `splits.payment` (plain object `{ blik|card|cash|monthly|other|transfer|unknown|outstanding: grosze }`) and `splits.service` (plain object `{ [serviceIdOr'Nie ustalono']: grosze }`) as delivered by `loadFinanceWindow` (validated in `src/api.js`, so keys are domain-checked upstream).
- Produces (used by Task 4):
  - `paymentMixParts(paymentSplit)` → frozen array of frozen `{ id: string, label: string, tone: string, value: number }`, positive amounts only, `outstanding` excluded, sorted by value desc then Polish label.
  - `serviceRevenueRanks(serviceSplit, labelFor, limit = SERVICE_RANK_LIMIT)` → frozen array of frozen `{ id: string, label: string, value: number }`, top `limit` rows plus one `{ id: 'rest', label: 'Pozostałe' }` bucket when more remain.
  - `SERVICE_RANK_LIMIT` = 5.
  - Tones are CSS token names without `--` prefix (`'pink'`, `'sky-deep'`, `'line-strong'`, …).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/finance-charts.test.js`:

```js
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SERVICE_RANK_LIMIT,
  paymentMixParts,
  serviceRevenueRanks,
} from '../../src/finance-charts.js'

describe('paymentMixParts', () => {
  it('keeps positive methods sorted by amount then Polish label', () => {
    const parts = paymentMixParts({
      blik: 5000, card: 20000, cash: 0, monthly: 20000,
      other: 0, transfer: 90000, unknown: 100, outstanding: 70000,
    })
    assert.deepEqual(parts.map(({ id }) => id), ['transfer', 'card', 'monthly', 'blik', 'unknown'])
    assert.deepEqual(parts[0], {
      id: 'transfer', label: 'Przelew', tone: 'sky-deep', value: 90000,
    })
    assert.deepEqual(parts[1], { id: 'card', label: 'Karta', tone: 'coral', value: 20000 })
    assert.deepEqual(parts[2], {
      id: 'monthly', label: 'Miesięcznie', tone: 'amber', value: 20000,
    })
    assert.ok(Object.isFrozen(parts))
    assert.ok(Object.isFrozen(parts[0]))
  })

  it('returns an empty list when nothing was collected', () => {
    assert.deepEqual(paymentMixParts({ outstanding: 12300 }), [])
    assert.deepEqual(paymentMixParts({}), [])
  })

  it('rejects invalid input', () => {
    assert.throws(() => paymentMixParts(null), TypeError)
    assert.throws(() => paymentMixParts([]), TypeError)
    assert.throws(() => paymentMixParts({ voucher: 100 }), TypeError)
    assert.throws(() => paymentMixParts({ cash: 10.5 }), TypeError)
    assert.throws(() => paymentMixParts({ cash: -1 }), TypeError)
  })
})

describe('serviceRevenueRanks', () => {
  const labelFor = (id) => (id === 'konsultacja' ? 'Konsultacja psychologiczna' : id)

  it('ranks by revenue and applies the label resolver', () => {
    const ranks = serviceRevenueRanks(
      { konsultacja: 90000, superwizja: 30000, 'Nie ustalono': 5000 },
      labelFor,
    )
    assert.deepEqual(ranks, [
      { id: 'konsultacja', label: 'Konsultacja psychologiczna', value: 90000 },
      { id: 'superwizja', label: 'superwizja', value: 30000 },
      { id: 'Nie ustalono', label: 'Nie ustalono', value: 5000 },
    ])
    assert.ok(Object.isFrozen(ranks))
    assert.ok(Object.isFrozen(ranks[0]))
  })

  it('buckets everything past the limit into Pozostałe', () => {
    const split = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, index) => [id, (7 - index) * 1000]),
    )
    const ranks = serviceRevenueRanks(split, (id) => id, 5)
    assert.equal(ranks.length, 6)
    assert.deepEqual(ranks.at(-1), { id: 'rest', label: 'Pozostałe', value: 3000 })
    assert.equal(SERVICE_RANK_LIMIT, 5)
  })

  it('drops zero rows and handles an empty split', () => {
    assert.deepEqual(serviceRevenueRanks({ konsultacja: 0 }, labelFor), [])
    assert.deepEqual(serviceRevenueRanks({}, labelFor), [])
  })

  it('rejects invalid input', () => {
    assert.throws(() => serviceRevenueRanks(null, labelFor), TypeError)
    assert.throws(() => serviceRevenueRanks({}, 'not a function'), TypeError)
    assert.throws(() => serviceRevenueRanks({ konsultacja: 1 }, labelFor, 0), TypeError)
    assert.throws(() => serviceRevenueRanks({ konsultacja: 1.5 }, labelFor), TypeError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/finance-charts.test.js`
Expected: FAIL — `Cannot find module … src/finance-charts.js`

- [ ] **Step 3: Write the implementation**

Create `src/finance-charts.js`:

```js
// Chart read-models for the protected finance window. Pure and JSX-free so
// node --test can import them (AGENTS.md: domain logic stays pure).

const PAYMENT_MIX = Object.freeze({
  blik: Object.freeze({ label: 'BLIK', tone: 'pink' }),
  card: Object.freeze({ label: 'Karta', tone: 'coral' }),
  cash: Object.freeze({ label: 'Gotówka', tone: 'sage' }),
  monthly: Object.freeze({ label: 'Miesięcznie', tone: 'amber' }),
  other: Object.freeze({ label: 'Inna', tone: 'ink-faint' }),
  transfer: Object.freeze({ label: 'Przelew', tone: 'sky-deep' }),
  unknown: Object.freeze({ label: 'Nie ustalono', tone: 'line-strong' }),
})

export const SERVICE_RANK_LIMIT = 5

const assertSplit = (split, name) => {
  if (split === null || typeof split !== 'object' || Array.isArray(split)) {
    throw new TypeError(`${name} must be a plain object`)
  }
}

const assertAmount = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} amounts must be non-negative safe integers`)
  }
}

const byValueThenLabel = (left, right) => (
  right.value - left.value || left.label.localeCompare(right.label, 'pl')
)

// Donut parts for the collected money of the selected month: one part per
// payment method with a positive amount, largest first. The synthetic
// 'outstanding' bucket is the settlement bar's story, not the donut's.
export function paymentMixParts(paymentSplit) {
  assertSplit(paymentSplit, 'paymentSplit')
  const parts = []
  for (const [method, value] of Object.entries(paymentSplit)) {
    if (method === 'outstanding') continue
    const mix = PAYMENT_MIX[method]
    if (mix === undefined) throw new TypeError(`unknown payment method: ${method}`)
    assertAmount(value, 'paymentSplit')
    if (value > 0) {
      parts.push(Object.freeze({ id: method, label: mix.label, tone: mix.tone, value }))
    }
  }
  return Object.freeze(parts.sort(byValueThenLabel))
}

// Ranked revenue rows for the selected month: the top services plus one
// explicit 'Pozostałe' bucket, so the list never exceeds limit + 1 rows.
export function serviceRevenueRanks(serviceSplit, labelFor, limit = SERVICE_RANK_LIMIT) {
  assertSplit(serviceSplit, 'serviceSplit')
  if (typeof labelFor !== 'function') throw new TypeError('labelFor must be a function')
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a positive integer')
  }
  const ranked = []
  for (const [id, value] of Object.entries(serviceSplit)) {
    assertAmount(value, 'serviceSplit')
    if (value > 0) ranked.push({ id, label: String(labelFor(id)), value })
  }
  ranked.sort(byValueThenLabel)
  if (ranked.length <= limit) {
    return Object.freeze(ranked.map((row) => Object.freeze(row)))
  }
  const rest = ranked.slice(limit)
  return Object.freeze([
    ...ranked.slice(0, limit).map((row) => Object.freeze(row)),
    Object.freeze({
      id: 'rest',
      label: 'Pozostałe',
      value: rest.reduce((total, row) => total + row.value, 0),
    }),
  ])
}
```

(`'rest'` cannot collide with a real service id — `src/services.js` ids are `konsultacja`, `superwizja`, `warsztaty`, … and none is `rest`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/finance-charts.test.js` — expected: PASS.
Run: `npm test` — expected: all unit tests pass (the `**` glob picks the new file up).

- [ ] **Step 5: Commit**

```bash
git add src/finance-charts.js tests/unit/finance-charts.test.js
git commit -m "feat: add finance chart read models"
```

---

### Task 2: Count-up KPIs and entrance reveal on Finanse and own payments

**Files:**
- Modify: `src/ui.jsx` (imports at top; add component after `Stat`, around line 303)
- Modify: `src/views/ProtectedFinance.jsx`
- Modify: `src/views/OwnPayments.jsx`
- Test: `tests/e2e/app-protected-visuals.spec.js`

**Interfaces:**
- Consumes: `useCountUp(value, fmt)` and `useReveal(deps)` from `src/anim.js` (both existing), `fmtMoney` from `src/format.js`.
- Produces (used by Task 4's page layout and by OwnPayments): `MoneyKpi({ label, grosze, tone })` exported from `src/ui.jsx` — renders an `<article class="finance-window__kpi finance-window__kpi--<tone>" data-reveal>` with a count-up `<strong>` money value; `grosze` is the API's integer money.

- [ ] **Step 1: Extend the e2e spec (failing first)**

In `tests/e2e/app-protected-visuals.spec.js`, inside the existing test `@owner enriches protected Finanse without replacing its summary, tabs or ledger`, after the `.finance-window__kpi` count assertion, add:

```js
  await expect(page.locator('.finance-window__kpi strong').first()).toHaveText(/zł/)
```

and append this new test at the end of the file:

```js
test('@specialist own payments render toned, readable KPI cards', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('./#/payments')

  await expect(page.getByRole('heading', { level: 1, name: /Finanse/ })).toBeVisible()
  const kpis = page.locator('.finance-window__kpi')
  await expect(kpis).toHaveCount(3)
  await expect(kpis.first()).toHaveText(/zł/)
  const backgrounds = await kpis.evaluateAll((items) => (
    items.map((item) => getComputedStyle(item).backgroundColor)
  ))
  expect(new Set(backgrounds).size).toBe(3)
})
```

- [ ] **Step 2: Run the new e2e test to verify it fails**

Run: `npx playwright test tests/e2e/app-protected-visuals.spec.js --config=playwright.app.config.js --grep "own payments render"`
Expected: FAIL — the three own-payment KPI cards currently share one (toneless) background, so `new Set(backgrounds).size` is 1. (The `/zł/` addition to the owner test passes already — that guard exists for the reduced-motion count-up about to be introduced.)

- [ ] **Step 3: Add `MoneyKpi` to `src/ui.jsx`**

Change the format import at the top:

```js
import { initials, fmtNumber, fmtMoney } from './format.js'
```

Add after the `Stat` component:

```jsx
// Money KPI card for the protected finance surfaces — the boxed, toned
// cousin of Figure/Stat with the same count-up. `grosze` keeps the API's
// integer money; the card formats złote.
export function MoneyKpi({ label, grosze, tone }) {
  const ref = useCountUp(grosze / 100, fmtMoney)
  return (
    <article
      className={`finance-window__kpi ${tone ? `finance-window__kpi--${tone}` : ''}`}
      data-reveal
    >
      <span>{label}</span>
      <strong ref={ref}>{fmtMoney(grosze / 100)}</strong>
    </article>
  )
}
```

- [ ] **Step 4: Wire motion into `src/views/ProtectedFinance.jsx`**

Imports: add `useReveal` and `MoneyKpi`:

```js
import { useReveal } from '../anim.js'
```

and extend the ui import to

```js
import { Button, EmptyState, IconBtn, MoneyKpi, Pill, TableScroll, Tabs } from '../ui.jsx'
```

Replace the whole `Kpis` component with:

```jsx
function Kpis({ values }) {
  const items = [
    ['Przychody', values.revenueGrosze, 'coral'],
    ['Wpłacono', values.collectedGrosze, 'sage'],
    ['Pozostało do zapłaty', values.outstandingGrosze, 'amber'],
    ['Wydatki', values.expensesGrosze, 'pink'],
    ['Dochód', values.incomeGrosze, 'sky'],
  ]
  return (
    <section className="finance-window__kpis" aria-label="Podsumowanie finansowe">
      {items.map(([label, value, tone]) => (
        <MoneyKpi key={label} label={label} grosze={value} tone={tone} />
      ))}
    </section>
  )
}
```

In `MonthlySettlement`, add `data-reveal` to the root section:

```jsx
    <section className="card card--pad finance-window__balance" data-reveal aria-label="Rozliczenie miesiąca">
```

In `LedgerTable`, add `data-reveal` to both root sections (the `payments` variant and the generic one):

```jsx
    <section className="card finance-window__table" data-reveal aria-labelledby="finance-payments-title">
```

```jsx
    <section className="card finance-window__table" data-reveal aria-labelledby={`finance-${kind}-title`}>
```

In the `ProtectedFinance` component body (next to the other hooks, before any early return), add:

```js
  const revealRef = useReveal([finance.status, selectedMonth])
```

On the **ready** return path, attach the ref and mark the head:

```jsx
  return (
    <div className="finance-window" ref={revealRef}>
      <div className="view-head" data-reveal>
```

(The loading/error return path stays as is — the reveal effect no-ops while the ref is unattached.)

- [ ] **Step 5: Wire motion into `src/views/OwnPayments.jsx`**

Imports: add `useReveal` from `'../anim.js'` and `MoneyKpi` to the `'../ui.jsx'` import list.

In the component body, after the existing derivation `const status = request.key === requestKey ? request.status : 'loading'` (around line 56), add:

```js
  const revealRef = useReveal([status, selectedMonth])
```

Attach the ref to the root and mark the head:

```jsx
    <div className="finance-window" ref={revealRef}>
      <div className="view-head" data-reveal>
```

Replace the KPI section's mapped `<article>` markup:

```jsx
          <section className="finance-window__kpis" aria-label="Podsumowanie własnych rozliczeń">
            {[
              ['Należne', summary.due, 'coral'],
              ['Wpłacono', summary.collected, 'sage'],
              ['Pozostało do zapłaty', summary.outstanding, 'amber'],
            ].map(([label, value, tone]) => (
              <MoneyKpi key={label} label={label} grosze={value} tone={tone} />
            ))}
          </section>
```

Add `data-reveal` to the table section root:

```jsx
          <section className="card finance-window__table" data-reveal aria-labelledby="own-payments-title">
```

- [ ] **Step 6: Run the visuals e2e file to verify it passes**

Run: `npx playwright test tests/e2e/app-protected-visuals.spec.js --config=playwright.app.config.js`
Expected: PASS (owner Finanse test including the new `/zł/` assertion and 5-card/≥4-backgrounds contract; new specialist test now sees 3 distinct toned backgrounds).

- [ ] **Step 7: Commit**

```bash
git add src/ui.jsx src/views/ProtectedFinance.jsx src/views/OwnPayments.jsx tests/e2e/app-protected-visuals.spec.js
git commit -m "feat: animate protected finance KPIs"
```

---

### Task 3: Six-month trend chart on Finanse + shared `.chart-frame`

**Files:**
- Modify: `src/styles.css` (rename `.report-window__chart` → `.chart-frame`, around lines 3940–3951; add `.finance-window__trend` near the other `.finance-window__*` rules)
- Modify: `src/views/ProtectedReports.jsx` (class rename, around line 151)
- Modify: `src/views/ProtectedFinance.jsx`
- Test: `tests/e2e/app-protected-visuals.spec.js`

**Interfaces:**
- Consumes: `AreaChart` from `src/charts.jsx` (existing; takes `data: [{ ym, revenue }]`, `height`, `label`); `window.trend` (six frozen `{ month, revenueGrosze, … }` points, oldest first, ending at `selectedMonth`).
- Produces: shared `.chart-frame` CSS class (coral-ghost gradient frame + focus ring for the chart's `role="img"`), used by both Raporty and Finanse; `.finance-window__trend` card accent.

- [ ] **Step 1: Extend the e2e spec (failing first)**

In the `@owner enriches protected Finanse…` test, after the settlement-region assertion, add:

```js
  await expect(page.getByRole('img', { name: /Przychody w sześciu miesiącach/ })).toBeVisible()
```

Run: `npx playwright test tests/e2e/app-protected-visuals.spec.js --config=playwright.app.config.js --grep "enriches protected Finanse"`
Expected: FAIL — no chart on the Finanse page yet.

- [ ] **Step 2: Rename the chart frame class in `src/styles.css`**

Replace the two `.report-window__chart` rules with:

```css
.chart-frame {
  margin: 18px 0 12px;
  padding: 10px 10px 0;
  border: 1px solid var(--blush);
  border-radius: var(--r-md);
  background: linear-gradient(180deg, var(--coral-ghost), var(--surface));
}
.chart-frame [role="img"]:focus-visible {
  outline: 3px solid var(--coral);
  outline-offset: 3px;
  border-radius: var(--r-sm);
}
```

Next to the other `.finance-window__*` rules add:

```css
.finance-window__trend {
  margin-bottom: 22px;
  overflow: hidden;
  border-top: 4px solid var(--coral);
}
```

- [ ] **Step 3: Update `src/views/ProtectedReports.jsx`**

Change `className="report-window__chart"` to `className="chart-frame"` (single occurrence inside the trend card).

- [ ] **Step 4: Add the trend card to `src/views/ProtectedFinance.jsx`**

Extend the charts import:

```js
import { AreaChart, BarFill } from '../charts.jsx'
```

In the ready return, directly after `<MonthlySettlement values={window.kpis} />`, insert:

```jsx
      <section className="card card--pad finance-window__trend" data-reveal aria-labelledby="finance-trend-title">
        <h2 className="card-title" id="finance-trend-title">Przychody · sześć miesięcy</h2>
        <div className="chart-frame">
          <AreaChart
            data={window.trend.map((point) => ({
              ym: point.month,
              revenue: point.revenueGrosze / 100,
            }))}
            height={200}
            label={`Przychody w sześciu miesiącach do ${fmtMonthYear(selectedMonth)}`}
          />
        </div>
      </section>
```

(An all-zero month range renders a flat baseline — `AreaChart` guards its max with `Math.max(…, 1)` — so empty staging months stay presentable.)

- [ ] **Step 5: Run the visuals e2e file to verify it passes**

Run: `npx playwright test tests/e2e/app-protected-visuals.spec.js --config=playwright.app.config.js`
Expected: PASS — including the pre-existing Raporty test (`role img /Przychody w sześciu miesiącach/` on `#/reports`), which guards the `.chart-frame` rename.

- [ ] **Step 6: Commit**

```bash
git add src/styles.css src/views/ProtectedReports.jsx src/views/ProtectedFinance.jsx tests/e2e/app-protected-visuals.spec.js
git commit -m "feat: add six-month trend chart to protected finances"
```

---

### Task 4: Payment-mix Donut and service-revenue ranks on Finanse

**Files:**
- Modify: `src/charts.jsx` (add `toneColor` export next to `tok`)
- Modify: `src/views/ProtectedFinance.jsx`
- Modify: `src/styles.css`
- Test: `tests/e2e/app-protected-visuals.spec.js`

**Interfaces:**
- Consumes: `paymentMixParts` / `serviceRevenueRanks` from Task 1; `Donut` and `BarFill` from `src/charts.jsx` (Donut takes `parts: [{ value, color, label }]` in złote, `centerTop`, `centerBottom`, `label`); `.chart-frame` from Task 3; `SERVICE_BY_ID` (already imported in the view).
- Produces: `toneColor(tone)` exported from `src/charts.jsx` — resolves a token tone name (`'sage'`, `'sky-deep'`, …) to a concrete color string for SVG attributes, which cannot read `var()`.

- [ ] **Step 1: Extend the e2e spec (failing first)**

In the `@owner enriches protected Finanse…` test, after the trend-chart assertion from Task 3, add:

```js
  await expect(page.getByRole('heading', { name: 'Przychody według usługi' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Wpłaty według formy' })).toBeVisible()
```

Run: `npx playwright test tests/e2e/app-protected-visuals.spec.js --config=playwright.app.config.js --grep "enriches protected Finanse"`
Expected: FAIL — the insight cards don't exist yet.

- [ ] **Step 2: Add `toneColor` to `src/charts.jsx`**

Directly below the existing `tok` export:

```js
// Resolve a palette tone name (e.g. 'sage', 'sky-deep') to its concrete
// colour for SVG attributes, which cannot read var() directly.
export const toneColor = (tone) => tok(`--${tone}`, '#6d6188')
```

- [ ] **Step 3: Build the insights grid in `src/views/ProtectedFinance.jsx`**

Update imports:

```js
import { AreaChart, BarFill, Donut, toneColor } from '../charts.jsx'
import { addMonths, cap, fmtMoney, fmtMonthName, fmtMonthYear, fmtShortDate } from '../format.js'
import { paymentMixParts, serviceRevenueRanks } from '../finance-charts.js'
```

Add a module-level helper next to the existing `money` constant:

```js
const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0)
```

In the component body, next to the existing `selectedRows`/`specialistNames` memos (before the early return):

```js
  const serviceRanks = useMemo(() => (window === null ? [] : serviceRevenueRanks(
    window.splits.service,
    (id) => SERVICE_BY_ID[id]?.label ?? 'Nie ustalono',
  )), [window])
  const paymentMix = useMemo(
    () => (window === null ? [] : paymentMixParts(window.splits.payment)),
    [window],
  )
```

After the early return (so it only runs on the ready path), before the main `return`:

```js
  const paymentMixTotal = paymentMix.reduce((total, part) => total + part.value, 0)
```

In the ready return, directly after the trend section from Task 3, insert:

```jsx
      <div className="grid-31 finance-window__insights">
        <section className="card card--pad" data-reveal aria-labelledby="finance-services-title">
          <h2 className="card-title" id="finance-services-title">Przychody według usługi</h2>
          {serviceRanks.length === 0 ? (
            <p className="muted">Brak przychodów w tym miesiącu</p>
          ) : (
            <div className="hbar" style={{ marginTop: 20 }}>
              {serviceRanks.map(({ id, label, value }) => (
                <div className="hbar__row hbar__row--labeled" key={id}>
                  <span className="hbar__name"><span>{label}</span></span>
                  <div>
                    <div className="hbar__track" style={{ height: 18 }}>
                      <BarFill
                        segments={[{ value, color: 'var(--coral)', label }]}
                        totalMax={serviceRanks[0].value}
                      />
                    </div>
                    <div className="row row--between finance-window__insight-meta">
                      <span className="muted">{money(value)}</span>
                      <span>{share(value, window.kpis.revenueGrosze)}%</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section
          className="card card--pad"
          data-reveal
          aria-labelledby="finance-mix-title"
          style={{ alignSelf: 'start', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
        >
          <h2 className="card-title" id="finance-mix-title" style={{ alignSelf: 'stretch' }}>
            Wpłaty według formy
          </h2>
          {paymentMix.length === 0 ? (
            <p className="muted" style={{ alignSelf: 'stretch' }}>Brak wpłat w tym miesiącu</p>
          ) : (
            <>
              <div style={{ marginTop: 18 }}>
                <Donut
                  parts={paymentMix.map(({ label, tone, value }) => ({
                    label, value: value / 100, color: toneColor(tone),
                  }))}
                  centerTop={money(paymentMixTotal)}
                  centerBottom={cap(fmtMonthName(selectedMonth))}
                  label={`Wpłaty według formy — ${fmtMonthYear(selectedMonth)}`}
                />
              </div>
              <div className="stack" style={{ gap: 10, marginTop: 22, alignSelf: 'stretch' }}>
                {paymentMix.map(({ id, label, tone, value }) => (
                  <div className="row row--between" key={id} style={{ fontSize: 13.5 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="legend__swatch" style={{ background: `var(--${tone})` }} />
                      {label}
                    </span>
                    <span style={{ fontWeight: 650 }}>{share(value, paymentMixTotal)}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
```

- [ ] **Step 4: Add the grid styles to `src/styles.css`**

Next to the other `.finance-window__*` rules:

```css
.finance-window__insights { margin-bottom: 22px; }
.finance-window__insight-meta { margin-top: 6px; font-size: 12.5px; }
```

(`.grid-31` already collapses to one column at ≤1024px and every child carries `min-width: 0` — no extra responsive rules needed.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx playwright test tests/e2e/app-protected-visuals.spec.js --config=playwright.app.config.js` — expected: PASS.
Run: `npx playwright test tests/e2e/app-finance.spec.js --config=playwright.app.config.js` — expected: PASS (the breakpoint-bounding test at `#/payments` must still see no horizontal overflow with the new grid).

- [ ] **Step 6: Commit**

```bash
git add src/charts.jsx src/views/ProtectedFinance.jsx src/styles.css tests/e2e/app-protected-visuals.spec.js
git commit -m "feat: add payment mix and service revenue charts"
```

---

### Task 5: Entrance reveal on Raporty, Rejestr and the workbook panels

**Files:**
- Modify: `src/views/ProtectedReports.jsx`
- Modify: `src/views/Registry.jsx`
- Modify: `src/views/WorkbookImport.jsx` (root section, around line 217)
- Modify: `src/views/WorkbookExport.jsx` (root section, around line 86)

**Interfaces:**
- Consumes: `useReveal(deps)` from `src/anim.js`. `data-reveal` elements are picked up by the nearest ancestor holding the `useReveal` ref (Registry's ref covers the workbook panel sections it renders).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: `src/views/ProtectedReports.jsx`**

Add the import:

```js
import { useReveal } from '../anim.js'
```

In the component body (next to the other hooks, before the early return):

```js
  const revealRef = useReveal([finance.status, selectedMonth])
```

On the ready return path, attach the ref and mark sections:

```jsx
    <div className="report-window" ref={revealRef}>
      <div className="view-head" data-reveal>
```

Add `data-reveal` to: the trend section (`className="card card--pad report-window__trend"`), the `MoneySplit` root section (edit the `MoneySplit` component: `<section className="card card--pad report-window__split" data-reveal>`), the two inline split sections (Faktury and TUS i angielski), the coverage section, and the unknown-period section.

- [ ] **Step 2: `src/views/Registry.jsx`**

Add the import:

```js
import { useReveal } from '../anim.js'
```

In the main `Registry` component body:

```js
  const revealRef = useReveal()
```

Attach to the root and mark the hero:

```jsx
    <div className="registry-view" ref={revealRef}>
      <div className="view-head registry-view__hero" data-reveal><div>
```

- [ ] **Step 3: Workbook panels**

`src/views/WorkbookImport.jsx` root section:

```jsx
    <section className="card card--pad workbook-import" data-reveal aria-labelledby="workbook-import-title">
```

`src/views/WorkbookExport.jsx` root section:

```jsx
    <section className="card card--pad workbook-export" data-reveal aria-labelledby="workbook-export-title">
```

- [ ] **Step 4: Run the protected e2e suites**

Run: `npx playwright test tests/e2e/app-protected-visuals.spec.js tests/e2e/app-finance.spec.js --config=playwright.app.config.js`
Expected: PASS — reveal is a transform-only entrance behind `motionOK()`; under the suites' reduced-motion emulation elements simply render in place, so no assertion changes are needed.

- [ ] **Step 5: Commit**

```bash
git add src/views/ProtectedReports.jsx src/views/Registry.jsx src/views/WorkbookImport.jsx src/views/WorkbookExport.jsx
git commit -m "feat: align protected views with shell motion"
```

---

### Task 6: Full verification, PR, staging deploy

**Files:** none (verification and delivery only)

- [ ] **Step 1: Run every suite (AGENTS.md requires all of them for UI changes)**

```bash
npm test
npm run test:worker
npm run test:scripts
npm run test:e2e
npm run test:e2e:app
```

Expected: all pass. `test:worker`/`test:scripts` touch nothing changed here but are part of the repo's done-bar; treat any failure as a stop.

- [ ] **Step 2: Build both modes**

```bash
npm run build:demo
npm run build:staging
```

Expected: both builds complete; the staging build's repository-safety guard passes.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/staging-finance-visuals
gh pr create --title "feat: align staging finance surfaces with demo visuals" --body "$(cat <<'EOF'
- Add six-month revenue AreaChart, payment-method Donut and top-service revenue bars to protected Finanse (all from the existing finance window; empty months fall back to quiet placeholders)
- Add count-up MoneyKpi cards (shared ui.jsx primitive) and entrance reveals to Finanse, own payments, Raporty, Rejestr and the workbook panels
- Extract pure chart read-models to src/finance-charts.js with node --test coverage; chart colours resolve via CSS tokens (new toneColor in charts.jsx)
- Share the Raporty chart frame as .chart-frame and reuse it on Finanse
- Extend tests/e2e/app-protected-visuals.spec.js (trend chart, insight cards, specialist KPI tones)
EOF
)"
```

(PR body: bullets only, no headings; never mention AI tooling.)

- [ ] **Step 4: Poll the PR until the Codex reviewer responds**

Poll (e.g. `gh pr view --comments` / reaction check every few minutes) until the Codex reviewer either posts a review comment for the pushed head commit or reacts with 👍. Silence or 👀 is not approval. Address any findings with brief one-to-two-sentence replies and follow-up commits, re-running the affected suites.

- [ ] **Step 5: After merge — deploy to staging (requires user go-ahead)**

Confirm with Mateusz before running (shared environment):

```bash
git checkout main && git pull
npm run deploy:staging
```

Expected: `check:repo` → `build:staging` → safety guard → `wrangler deploy`, all green. Then open the staging app and eyeball `#/payments`, `#/reports`, `#/ledger` with the imported workbook data (23 populated months, so the trend, donut and service ranks should all be live).

---

## Self-review notes

- **Spec coverage:** motion alignment → Tasks 2 & 5; shared MoneyKpi → Task 2; Finanse charts (trend, donut, service ranks, empty fallbacks) → Tasks 3 & 4; pure read-models + toneColor → Tasks 1 & 4; `.chart-frame` sharing → Task 3; verification/deploy → Task 6. Non-goals (demo, StaffAccess, TUS/English, backend) touched nowhere.
- **Data reality check:** the imported workbook populates payment methods and services richly but almost never specialists — the chosen splits match what staging can actually show.
- **Type consistency:** `paymentMixParts` → `{ id, label, tone, value }` consumed exactly in Task 4 (donut parts use `value / 100` złote; legend uses `tone` as `var(--<tone>)`); `serviceRevenueRanks` → `{ id, label, value }` consumed in Task 4's bars; `MoneyKpi({ label, grosze, tone })` used identically in ProtectedFinance and OwnPayments; `toneColor(tone)` defined in Task 4 Step 2 before its Step 3 use.
