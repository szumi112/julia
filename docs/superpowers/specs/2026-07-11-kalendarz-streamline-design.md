# Kalendarz streamline — design

Date: 2026-07-11
Status: approved

## Problem

The Kalendarz page feels cluttered and confusing:

- A permanent three-row filter panel (date presets, Od/Do inputs, payment,
  attendance) occupies the top of the page before any calendar content.
- The date-preset filter defaults to "Dzisiaj", so the Miesiąc view renders an
  almost-empty grid — the date filter silently fights the month grid.
- Two stacked toolbar rows (filter rail + month nav/hint row) add chrome.
- A permanent drag-and-drop hint sentence adds noise.
- The code carries an unreachable third "list" view mode (dead code).

Goal: make the page simple and obvious for non-technical users while keeping
both views (Plan dnia and Miesiąc) and all day-to-day actions.

## Decisions

Approach chosen: streamline in place (no layout restructure).

### 1. Filters

- Remove the date-preset system entirely: Dzisiaj / Ten tydzień / Ten miesiąc
  chips, Od/Do date inputs, `dateBoundsFor`, `datePreset` state, and the
  `is-filtered-out` day dimming. Navigation is the date filter: the day strip
  picks a day, the month nav picks a month.
- Payment and attendance filters remain, collapsed behind a single "Filtry"
  ghost button (funnel icon) in the toolbar with an active-count badge
  (e.g. "Filtry · 2"). Expanding shows one compact row with the two chip
  groups and a "Wyczyść" action when any filter is active.
- The "Wyświetlono N sesji po zastosowaniu filtrów" sentence is removed; the
  toolbar session count keeps an `aria-live` region for screen readers.

### 2. One toolbar

- The view switch (Plan dnia / Miesiąc) stays in the page header as today.
- Below it, a single toolbar row: month nav (‹ Lipiec 2026 ›) · "Dziś"
  shortcut · Filtry button · session count.
- The permanent drag-and-drop hint sentence is removed; session chips keep
  their `title` tooltip and drag behaviour is unchanged.

### 3. Plan dnia polish

- Day strip and day card stay structurally as they are.
- Empty-state copy states the next action plainly, e.g. "Brak sesji — dodaj
  pierwszą poniżej."
- The "+N więcej" expander and bottom "Dodaj sesję tego dnia" button stay.

### 4. Miesiąc polish

- Grid structure unchanged. With date filtering gone, the grid always shows
  the whole month's sessions (fixes the empty-grid bug by design).
- Legend and right-hand day panel stay; the shared `dayRow`/`dayThread`
  rendering is untouched.

### 5. Cleanup

- Remove the unreachable list-view branch (`listDays`, `listFlipRef`, the
  per-day table markup).
- Prune CSS for the removed filter rail.

### 6. Testing

Update/extend the Playwright e2e specs:

- Filters are collapsed by default; the page opens with calendar content
  visible.
- Expanding "Filtry" and applying a payment filter narrows the visible
  sessions; the badge shows the active count; "Wyczyść" resets.
- Miesiąc grid shows sessions on multiple days with default (no) filters.
- Switching between Plan dnia and Miesiąc works.

Run the full existing suite; no regressions.

## Out of scope

Session form, store, other views, mobile layout restructure, any new
features. No layout rework of either view beyond the chrome consolidation
above.
