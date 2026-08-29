# Staging finance visual alignment design

**Date:** 2026-08-29
**Status:** Approved for planning

## Objective

Bring the staging-only protected surfaces — Finanse (`ProtectedFinance`),
Raporty (`ProtectedReports`), Rejestr (`Registry` with its workbook panels)
and the specialist's own-payments view (`OwnPayments`) — up to the look,
motion and chart richness of the demo pages (`Payments`, `Reports`,
`Dashboard`), and add useful charts to the protected Finanse page.

This continues the "enrich protected app surfaces" pass (commit `4786613`)
whose e2e guardrails live in `tests/e2e/app-protected-visuals.spec.js`.

## Why the demo cannot be replicated exactly

The demo's finance pages are built on per-specialist session data (colors,
avatars, per-specialist ranked bars, specialist Donut). The staging data is
the imported workbook (`Przychody_2024-2026.xlsx`: 2,232 rows, accounting
months 2024-08 through 2026-07) where almost no income row carries a
specialist. What the staging finance window *does* have, already delivered
to the client by `loadFinanceWindow`:

- `kpis` — revenue/collected/outstanding/expenses/income (grosze);
- `trend` — six consecutive months of those KPIs;
- `splits.payment` — collected grosze per payment method plus `outstanding`;
- `splits.service` — revenue grosze per service id (or `'Nie ustalono'`);
- `splits.invoice`, `splits.program`, `specialistLabels`, `coverage`.

So the replication substitutes data-appropriate charts: a six-month revenue
AreaChart, a payment-method Donut, and ranked service-revenue bars — the
same visual language (same components, colors, motion) with splits the
workbook actually populates.

## Decisions

1. **Motion alignment.** The protected views adopt the demo's entrance
   motion: `useReveal` + `data-reveal` staggers, and count-up money KPIs
   (same `useCountUp` used by `Figure`/`Stat`). All motion stays behind
   `motionOK()` as everywhere else.
2. **Shared money KPI card.** A `MoneyKpi` primitive in `ui.jsx` renders the
   existing `.finance-window__kpi` card with count-up; `ProtectedFinance`
   and `OwnPayments` both use it. The e2e contract stays: 5 KPI cards on
   Finanse, ≥4 distinct backgrounds. `OwnPayments` KPIs gain the matching
   coral/sage/amber tones.
3. **Charts on Finanse.** Between the settlement bar and the tabs:
   - a six-month revenue AreaChart (from `window.trend`), framed like the
     Raporty chart;
   - a `grid-31` insights row: ranked service-revenue bars (top 5 +
     "Pozostałe" bucket, `BarFill`) and a payment-method Donut of collected
     money with a percentage legend (demo `Reports` donut pattern).
   Empty months render quiet "Brak…" fallbacks, never broken charts.
4. **Pure chart read-models.** Donut parts and service ranking live in a new
   JSX-free `src/finance-charts.js` (node --test coverage), following the
   "domain logic stays pure" convention. Chart colors resolve through
   CSS tokens only: a `toneColor` helper exported from `charts.jsx` wraps
   the existing `tok()`; no palette hex outside `charts.jsx`.
5. **Shared chart frame.** `.report-window__chart` is renamed to a shared
   `.chart-frame` used by both Raporty and Finanse.
6. **No backend changes.** Everything renders from the already-shipped
   finance window. Demo mode is untouched.

## Non-goals

- No changes to demo-mode views, `StaffAccess`/Settings (already animated
  through Settings' own reveal), TUS/English (already aligned), navigation
  or copy semantics.
- No per-specialist charts on staging while the workbook lacks specialist
  attribution.
- No new chart types beyond the existing hand-rolled `AreaChart`, `Donut`,
  `BarFill`.

## Verification

- New unit tests for `finance-charts.js`; extended assertions in
  `tests/e2e/app-protected-visuals.spec.js` (trend chart, insights cards,
  empty fallbacks, KPI text under reduced motion).
- Full suites: `npm test`, `npm run test:worker`, `npm run test:scripts`,
  `npm run test:e2e`, `npm run test:e2e:app`; `npm run build:staging`.
- After merge: guarded `npm run deploy:staging`, then a live look at the
  staging Finanse/Raporty/Rejestr pages.
