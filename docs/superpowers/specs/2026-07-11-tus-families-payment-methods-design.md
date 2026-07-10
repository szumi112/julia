# Aurelia — Grupa TUS, rodziny, formy płatności: Design

FE-only increment on mocked data, derived from the client conversation (13–14 June 2026)
and the pasted "Grupa TUS" Excel tab. No backend, no persistence — same contract as the
rest of the prototype (in-memory state, reset on refresh).

## Requirements (from the conversation)

The client runs a child-psychology centre. Beyond the existing prototype she asked for:

1. **Grupa TUS** — group social-skills classes for children, "an entirely separate
   category from our daily sessions". Enrolled kids (e.g. 15) are divided by the owner
   into age groups (~5 kids, 2 leading psychologists each). Weekly classes; leaders
   enter the topic and tick attendance; dates sometimes move (reschedule). The owner
   marks whether parents paid for the month and whether they signed the class
   regulations; parent contacts must be at hand. A short child profile (add/edit +
   attendance history) and a month summary round it out. **Stated priority: child
   attendance + whether parents paid. Everything else is supporting.**
2. **Families** — a parent attends the first session, then the child; both are regular
   clients in the calendar, often with different surnames. Somewhere the app must show
   they are one family.
3. **Payment method** — each specialist must be able to mark how a client paid: card or
   cash (the Excel also shows bank transfer + "invoice issued", so: card / cash /
   transfer).
4. **Google Calendar sync** — asked as a question; real sync needs a backend and OAuth,
   so the mock gets an honest demo affordance only.
5. **Excel import script** — out of scope for the FE mock (nothing to import into);
   planned for the real backend phase. The Excel structure informs the TUS payments
   model: Usługa / Cena / Klient (= parent) / Data zakupu / Sposób płatności / Status.

## Approaches considered

- **A (chosen) — dedicated TUS module with its own collections.** New `tus` view, new
  `tusGroups` / `tusKids` / `tusClasses` / `tusPayments` state, pure helpers in
  `src/tus.js`. Matches the client's mental model ("osobna kategoria"), and keeps the
  existing financial contracts (`isBillable`/`collectedOf`/`monthStats`, whole-clinic
  reports) untouched — TUS fees never leak into session revenue.
- **B — model TUS on top of existing entities** (kids as `clients`, classes as
  multi-client `sessions`, fees as session payments). Rejected: the session model is
  1:1 (`clientId` FK everywhere), and every existing selector/view would need
  exclusion logic; reports and finance metrics would silently absorb TUS fees.
- **C — single flat attendance-sheet view** with no group/kid management. Rejected:
  fails the owner's named jobs (dividing kids into groups, kid profiles, parent
  contacts, regulations flag), though its discipline informs A's priorities.

Family links: shared `familyId` + per-client `familyRole` (chosen) over an explicit
relation edge list (over-modeled) or a free-text note (not navigable, error-prone with
different surnames).

## Data model (src/data.js, seeded like existing collections)

- `TUS_GROUPS`: `{ id: 'g1', name: 'Grupa TUS 5–6 lat', age: '5–6 lat',
  leaderIds: ['p2','p3'], weekday: 3, time: '16:00', fee: 300 }` — two demo groups
  mirroring the Excel (5–6 lat, 4 lata). Fee = monthly price per child.
- `TUS_KIDS`: `{ id: 'k1', name, age, groupId|null, parentName, parentPhone,
  regulationsSigned: bool, note: '' }` — ~11 kids: 5 + 4 assigned, 2 unassigned (to
  demo the divide-into-groups job). Some parent surnames differ from the kid's.
  Fictional names only (no names from the client's real sheet).
- `TUS_CLASSES`: `{ id: 'tc1', groupId, date, time, topic, attendance: { [kidId]: bool } }`
  — weekly per group, weeks −10…+3 relative to TODAY (same generator style as
  sessions); past classes have topics + ~85% attendance marked; future ones are empty.
  A missing entry in `attendance` renders as absent; future classes are not markable.
- `TUS_PAYMENTS`: `{ id: 'tp1', kidId, ym: 'YYYY-MM', amount, status: 'paid'|'unpaid',
  method: 'transfer'|'cash'|'card'|null, invoice: bool, paidDate: iso|null, note: '' }`
  — seeded per assigned kid per month with past classes; mixed statuses like the Excel
  (mostly transfer + invoice, a few unpaid, one note à la "przelew od przedszkola").
- `SESSIONS` gain `method: 'card'|'cash'|'transfer'|null` (seeded for paid/partial).
- `CLIENTS`: two seeded records with different surnames share `familyId: 'f1'` and
  carry `familyRole: 'rodzic'` / `'dziecko'`.
- `state.prefs` gains `gcalConnected: false`.

## Pure logic (src/tus.js — unit-testable like workspace.js)

`tusGroupsForRole(state, role)` (scope `'own'` → groups whose `leaderIds` include
`role.psychId`), `canLeadGroup(group, role)` (leader or centre scope),
`kidsOfGroup(kids, groupId)`, `unassignedKids(kids)`, `classesInMonth(classes, ym)`,
`tusMonths(classes)`, `nextClassOf(classes, groupId, now)`,
`attendanceRate(pastClasses, kidId?)`, `tusPaymentFor(payments, kidId, ym)` (default
unpaid row when absent), `tusMonthSummary(group, classes, kids, payments, ym)` →
`{ classCount, heldCount, attendanceRate, paidCount, dueCount, dueAmount }`,
`stripKid(classes, payments, kidId)` (cascade helper used by the reducer).

## Store actions (store.jsx)

`ADD_TUS_GROUP`, `UPDATE_TUS_GROUP`, `ADD_TUS_KID`, `UPDATE_TUS_KID`,
`DELETE_TUS_KID` (cascades via `stripKid`), `ADD_TUS_CLASS`, `UPDATE_TUS_CLASS`,
`DELETE_TUS_CLASS`, `SET_TUS_ATTENDANCE { classId, kidId, present }`,
`UPSERT_TUS_PAYMENT { kidId, ym, patch }` (creates a default row from the group fee on
first touch). New ids reuse the shared `nextId` counter (`g…`, `k…`, `tc…`, `tp…`).

## Views

**Nav/registration** (all the layout.jsx points): route `tus` (list) + `tusGroup`
(detail; `ACTIVE_OF: tus`, `DEPTH: 1`). NAV item `{ id: 'tus', label: 'Zajęcia TUS',
icon: 'group' }` between *Klienci* and *Zespół*; `TITLES`: `tus: 'Zajęcia grupowe TUS'`,
`tusGroup: 'Grupa TUS'`. `ROLE_NAV`: all three roles get `tus` (therapist sees only led
groups). Command palette `VIEW_ITEMS` += `{ view: 'tus', label: 'Zajęcia TUS' }`.
New hand-drawn `group` icon in icons.jsx. Phone tabbar unchanged (4 slots by design).

**Zajęcia TUS (list, src/views/Tus.jsx)** — `view-head` + `grid-2` of group cards
(name, age `Pill`, leader `Avatar`s, "co tydzień · śr 16:00", kid count, next class,
month attendance %; centre roles also see an unpaid-count gold `Pill`). Click →
`tusGroup` detail. Centre-only: "Nowa grupa" button; a "Bez grupy" card listing
unassigned kids with quick "Przypisz" (opens the kid drawer). Therapist: only their
groups, no management affordances.

**Grupa TUS (detail, src/views/TusGroup.jsx)** — back link, `id-band` (group name, age,
leaders, schedule; actions: *Edytuj grupę* (centre), *Dodaj zajęcia* (leaders+centre),
*Dodaj dziecko* (centre)). A `month-nav` (same pattern as Finanse) scopes the sections;
a `.figures` row gives the month summary — Zajęcia, Frekwencja, and (centre only)
Opłacone n/m. Sections:

1. **Obecność · month** — the core: table (in `.table-scroll`), rows = classes (date +
   topic; row click → class drawer for reschedule/topic), columns = kids (initials,
   full name in `title`/`aria-label`), cells = toggle buttons ✓ present / – absent
   (`SET_TUS_ATTENDANCE`), disabled for future dates and for non-leader therapists.
   Footer row: per-kid attendance % for the month. Reading a kid's column is the
   attendance history the client asked for.
2. **Płatności · month** — centre roles only. Row per assigned kid: kid, parent
   (payer) + seeded note, amount, method picker (Przelew/Gotówka/Karta popover pill),
   invoice `Check` ("Faktura"), payment status pill picker + "Zaksięguj" shortcut —
   all via `UPSERT_TUS_PAYMENT`. Mirrors the Excel month blocks.
3. **Dzieci** — roster table (`table--cards`): kid (avatar, name, age), parent
   (name, phone — the "in case something happens" contact), Regulamin (centre: toggle;
   therapist: read-only pill), attendance %, edit → kid drawer.

**Drawers (src/views/TusForms.jsx, shell-routed like existing forms)** —
`GroupDrawer` (name, age label, leaders as `Check` list ≥1, weekday, time, fee),
`KidDrawer` (name, age, group select incl. "Bez grupy", parent name required, phone,
regulations `Check`; centre-only delete with two-step confirm + cascade note),
`ClassDrawer` (date, time, topic; add prefills the next weekly slot; date change on
edit toasts "Zajęcia przeniesione"; two-step delete). Shell gains drawer kinds
`tusGroup`/`tusKid`/`tusClass` + `openTusGroupForm`/`openTusKidForm`/`openTusClassForm`.

**Payment method (regular sessions)** — `METHOD_LABELS = { card: 'Karta', cash:
'Gotówka', transfer: 'Przelew' }` in format.js. `PaymentPicker` popover gains a "Forma
płatności" radio group (visible when payment ≠ unpaid) → `UPDATE_SESSION { method }`;
since the picker is used in the calendar agenda and client detail, therapists can mark
it where they already work. `SessionDrawer` gains a 4-option `Segmented` (—/Gotówka/
Karta/Przelew) shown when payment ≠ unpaid. Finanse table gains a muted "Forma" column.

**Rodziny (regular clients)** — reducer actions `LINK_FAMILY { clientId, otherId,
role }` (adopts the other's `familyId` or mints one; sets `familyRole` on the edited
client) and `UNLINK_FAMILY { clientId }`. `ClientDrawer` gains a "Rodzina" block:
current members with unlink, plus link-select (other clients) + role `Segmented`
(Rodzic/Dziecko). `ClientDetail` care-overview gains a "Rodzina" item listing linked
clients (role label + link to their record), "—" when none. Client list unchanged.

**Ustawienia — Integracje** — new card with one row: Google Calendar, sub
"Synchronizacja wizyt (demo)", connect/disconnect via `SET_PREF gcalConnected` +
toast. No behavioral claims beyond the demo label.

## Role scoping summary

| Capability | owner/coordinator (centre) | therapist (own) |
|---|---|---|
| See groups | all | only led groups |
| Attendance + topics + reschedule | yes | only led groups |
| Payments section, regulations, group/kid CRUD | yes | hidden |
| Session payment method | yes | own sessions (existing picker surfaces) |

## Out of scope (documented for the client)

Real Google Calendar sync, the Excel/Sheets import script (backend phase; the mock's
TUS model is shaped so the import maps 1:1), TUS classes on the main calendar and the
Dziś workspace, TUS revenue in Raporty/Finanse (kept clinic-only on purpose).

## Testing & verification

- `tests/unit/tus.test.js` (node:test): role scoping, `canLeadGroup`, attendance math,
  `tusMonthSummary`, payment upsert default, `stripKid` cascade.
- `tests/e2e/tus.spec.js` (Playwright, conventions of workspace.spec.js): owner
  group-card → attendance toggle persists; payment mark-paid updates the summary;
  therapist sees only led groups and no payments; family link visible on client
  detail; session method picked in Finanse; GCal demo connect toasts.
- `npm test`, `npm run test:e2e`, `npm run build`, and a scripted screenshot
  walkthrough (desktop + 360×800) of the new views.

## Guardrails

No new runtime dependencies; existing financial selectors untouched; shell overlay
invariants (one overlay, inert background, Escape layering) reused via existing drawer
machinery; all copy in Polish; tokens/BEM-lite classes from styles.css; NAV order and
route names of existing views unchanged.
