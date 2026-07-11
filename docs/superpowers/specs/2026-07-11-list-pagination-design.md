# List pagination fallback — design

Date: 2026-07-11
Status: approved

## Problem

The app has no guard for long lists. Demo data is small, but with real data
three lists grow unbounded: the Finanse month table (all sessions of a
month), the Klienci roster table, and the client-detail session history.
The user wants classic pagination as a fallback that stays invisible at
today's volumes.

## Decisions

Approach: one shared hook + one shared Pager component (no per-view copies,
no numbered pages, no page-size picker).

### 1. Shared unit — `src/pagination.js` + `src/ui.jsx`

Split so the pure part stays testable with `node --test` (which cannot parse
JSX): pure helpers live in `src/pagination.js` (no imports); `usePagination`
and `Pager` live with the other shared primitives in `src/ui.jsx`.

- Pure helpers, unit-testable without React:
  - `pageCount(total, pageSize)` → number of pages (min 1).
  - `pageSlice(items, page, pageSize)` → the items of a 1-based page.
- `usePagination(items, { pageSize, resetKey })` → `{ pageItems, page,
  pages, setPage }`:
  - Clamps `page` into `[1, pages]` when the list shrinks — never strands
    the user on an empty page.
  - Resets to page 1 when `resetKey` changes. Callers pass their filter
    signature (month + filters, search query, client id) as `resetKey` —
    deliberately not the items array, so data edits (e.g. booking a payment
    on page 3) do not reset the page.
- `Pager` component: `IconBtn` chevL ("Poprzednia strona") · label
  "Strona X z Y" · `IconBtn` chevR ("Następna strona"), wrapped in
  `nav aria-label="Stronicowanie"`, label `aria-live="polite"`.
  Returns `null` when `pages <= 1` — the fallback stays invisible until a
  list actually overflows.

### 2. Wiring

- `src/views/Payments.jsx` month table: pageSize 25; `resetKey` = selected
  month + payment-status filter. The FLIP key uses the current page's ids
  instead of all filtered ids.
- `src/views/Clients.jsx` roster table: pageSize 25; `resetKey` = search
  query + active filter chips.
- `src/views/Clients.jsx` client-detail history table: pageSize 10;
  `resetKey` = client id.

All user-facing copy Polish: "Poprzednia strona", "Następna strona",
"Strona X z Y".

### 3. Testing

- Unit tests (node:test) for `pageCount`/`pageSlice`: empty list, exact
  multiple of page size, overflow page clamped.
- E2E (Playwright):
  - A table whose rows exceed the page size (a past month in Finanse)
    renders at most 25 rows, the pager is visible, clicking "Następna
    strona" changes the row set and the label reads "Strona 2 z …".
  - A short list (Klienci roster at demo volume) renders fully with no
    pager in the DOM.

## Out of scope

Page-size picker, numbered page buttons, URL/router state, virtualization,
pagination for calendar, dashboard, TUS, notes, or upcoming-session lists.
