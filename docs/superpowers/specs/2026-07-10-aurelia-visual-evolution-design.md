# Aurelia — Visual & Interaction Evolution: Design Direction

Implementation design for the brief in `task.md`. The brief pins palette, typography,
identity, behavior, breakpoints, and financial semantics; this document decides the axes
the brief leaves open: composition, hierarchy, the signature element, motion choreography,
tokens, and the accessibility fixes its acceptance targets require.

## Concept

**Aurelia as a practice journal.** A small psychotherapy center's real materials are the
appointment book, the day's schedule, the client file, the month's summary. Each view is
composed like a well-set page of that journal: one focal layer, quiet hairline-ruled
figures instead of card noise, and prose where prose is truer than tiles. The current UI's
"header → chips → equal cards" rhythm is replaced per view with a deliberate scan path.

## Signature element — the day thread ("nić dnia")

A vertical time spine: a soft rose-to-transparent rule with session nodes in the
specialist's color and a breathing "now" marker. Sessions hang off it with Fraunces
times. Used consistently in four places — the Dashboard "Dziś" focal band, the Calendar
selected-day panel, the Today cockpit list, and the phone agenda — so the app's most
important recurring object (a day of sessions) has one recognizable, Aurelia-specific
form. Motion: the thread draws in once (scaleY, compositor-friendly); the now-marker
breathes only when motion is allowed. One CSS family (`.spine`), no new dependencies.

The second expression of the concept is **the written lead in Reports**: the month opens
with two calm Polish sentences whose key figures are set inline in Fraunces italic,
derived from existing `monthStats` — the "editorial data story" as actual editorial.

## Tokens (added to `:root`, existing values preserved unless noted)

- **Spacing**: `--s1..--s7` = 4/8/12/16/24/32/48px, used by new and edited rules.
- **Z ladder**: `--z-tabbar/drawer/cockpit/pop/cmd/toast` replacing scattered literals.
- **Durations**: `--dur-fast .18s / --dur .25s / --dur-slow .4s` for new CSS transitions.
- **Focus**: focus ring becomes `var(--gold-deep)` (gold at 2.87:1 fails the 3:1 target).
- **Contrast corrections** (brief: WCAG 2.2 AA as acceptance targets — measured failures):
  - `--ink-faint #a08e96 → #7a6871` (was 2.74:1 on paper; now 4.61:1). Hairlines stay on `--line`.
  - `--rose-deep #a4596b → #964d5f` (pill 3.78→4.53:1 on rose-ghost; links 4.42→5.30:1).
  - `--sage-deep #5f7050 → #556349`, `--gold-deep #86683a → #7d5f33`,
    `--mauve-deep #7c6373 → #71586a`, `--error #b04a33 → #a54430` (all pill pairs ≥4.5:1).
  - New `--line-strong #94848c` for form-control boundaries (3.39:1 on surface; `--line`
    at ~1.2:1 stays for decorative rules).
  - Weekend markers switch terra → terra-deep (3.39→5.16:1).
- **Charts** read tokens via one `getComputedStyle` helper instead of hard-coded hexes.

Typography stays Fraunces + Hanken Grotesk with the existing helpers (`.display`,
`.eyebrow`, `.num`); Fraunces gains ground in times, figures, and the report lead.

## Shared primitives (new, replacing repeated one-offs)

- `.spine` — the day thread (above).
- `.figures` — a quiet KPI line: numbers with hairline separators, explicit period/scope
  eyebrow, each figure a real link/button to its downstream view. Replaces equal-weight
  stat-card rows on Dashboard and Finances. (`.stat` cards remain where they still fit:
  specialist detail.)
- `.id-band` — full-width identity header for Client/Specialist detail (avatar, display
  name, status/debt pills, contact, actions) replacing the small profile card.
- Row exception marker — gold inset rail + tint for unpaid/partial finance rows, so
  exceptions scan without color-only encoding.

## Per-view composition

- **Login** — keep the centered card over the ambient scene; shorten the entrance
  (≤0.7s to an interactive form), programmatic error association + first-invalid focus.
- **Dashboard** — three tiers. (1) Focal "Dziś" band on the ambient scene: greeting,
  date, the day thread with next session emphasized, day progress, quick actions.
  (2) A `.figures` line (clients / sessions / hours / revenue / outstanding-in-gold),
  each linking to its view — replaces the five equal KPI cards. (3) Revenue chart beside
  an actionable "Do rozliczenia" rail; below, "Zespół dziś" (who works today, their
  load) with the team board integrated beside it rather than appended.
- **Calendar** — desktop keeps grid + day panel; the panel adopts the spine and stays
  visibly linked to the selected cell; `+n więcej` becomes a real button selecting the
  day; filter changes animate only affected items (FLIP/opacity, no full-grid replay);
  weekends tinted, today marked with the bloom dot. Phone: controls compress to one
  scrollable row under the mode switch; the duplicate "Nowa sesja" button yields to the
  tabbar FAB.
- **Clients** — the table stays a table (semantics + phone card reflow preserved) but is
  re-weighted around care: identity cell (avatar, name, contact stacked), specialist,
  last/next session ("upcoming-care"), debt, status. Detail view: `.id-band`, then notes
  elevated on the left, history split into "Nadchodzące" (spine) and past sessions.
- **Team** — cards keep the specialist color band, gain a "dziś: N sesji" relational
  line and explicit period labels. Specialist detail gets the `.id-band` treatment.
- **Finances** — focal collection meter (zebrane vs zaległe, amounts printed, one bar)
  with explicit scope labels on every figure; per-specialist bars keep printed values;
  billing table marks outstanding rows with the gold rail treatment.
- **Reports** — written lead + `.figures` line replace the watermark hero; breakdown
  table and donut stay whole-clinic (existing dual-scope contract); donut and area chart
  gain visually-hidden tabular equivalents; print gets page-break and header rules.
  Export button labeled as demo ("Eksport (demo)").
- **Settings** — team/rates become the focal column; profile/center/preferences stack
  quietly; rate commits give feedback; reduced-motion row reflects OS state.
- **Forms/drawers** — unchanged structurally; gain `aria-invalid`/`aria-describedby`
  wiring in `Field`, first-invalid focus on failed submit, upfront blocked-delete notice
  in the specialist form, radiogroup semantics with arrow keys in `Segmented`.
- **Shell** — view changes move focus to the view and announce the destination
  (aria-live); one modal layer enforced centrally (palette/cockpit/drawers close each
  other, body scroll locks); cockpit places and contains focus; the decorative topbar
  month chip is removed (duplicate signal); toasts get exit animation, tap-to-dismiss,
  and a stack cap.

## Motion

Build on `anim.js`; every effect stays behind `motionOK()`. New: spine draw-in
(scaleY), directional view continuity (list→detail exits left, back returns right),
FLIP filter continuity where lists persist, toast exit. Removed: blanket grid-replay
staggers on filter change. Unchanged: drawer choreography, gold burst, ambient scene
rules (login + dashboard only).

## Guardrails honored

No new runtime dependencies; CSS budget respected by removing the watermark/month-chip/
stat-row usages that the new primitives replace (target: within +10% of 10.62 kB gzip
CSS, 86.12 kB JS); all financial math continues to flow through `isBillable`/
`collectedOf`/`outstandingOf`/`monthStats`; drag-DOM contracts, `data-th`/`data-flip-id`
machinery, Escape layering, and route names are preserved per the risk map.

## Verification

Per the brief's evidence list: production build + gzip sizes, full smoke walkthrough,
keyboard/focus/escape checks, OS + in-app reduced motion, CDN/WebGL fallback, and
screenshots at 360×800 / 768×1024 / 1024×768 / 1440×900 plus 640/641 and 1024/1025
breakpoint pairs, with no viewport-level horizontal overflow.
