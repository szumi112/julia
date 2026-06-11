Build an Awwwards-worthy UI prototype for a psychology center management panel
Create a visually captivating, fully-clickable web app prototype for managing a small psychology center (clients, sessions, finances). This is a demo — no real backend — but every view must be navigable with realistic mock data and feel like a finished, premium product. Use in-memory React state only. Do not use localStorage or any browser storage.
This is a design-led project. UI/UX is the single most important thing. Build it as if a top-tier product designer crafted it for an Awwwards submission — the goal is to make a small clinical team feel excited to abandon their manual Excel sheets for something genuinely beautiful and calming to use.
Visual & motion direction:

Warm, feminine, sophisticated palette: dusty rose, blush, terracotta, warm ivory/cream, soft mauve, muted antique gold accents. Refined and editorial — never childish.
Elegant type pairing: a high-contrast serif display face (e.g. Fraunces, Canela-style) for headings paired with a clean humanist sans (e.g. Inter, General Sans) for UI text. Strong typographic hierarchy.
Generous negative space, intentional grid, soft layered shadows, gentle grain/noise texture, subtle gradients.
Motion is core, not decoration. Use GSAP for choreographed entrance animations, staggered list reveals, smooth page transitions, animated number counters on stat cards, and scroll-triggered reveals. Everything should feel fluid and physical, with carefully tuned easing — nothing abrupt.
A tasteful three.js ambient hero element: a soft, slow-moving abstract background on the login and dashboard (flowing gradient blob, particle field, or organic mesh in the warm palette) that feels alive but never distracting. Keep it performant and subtle.
Micro-interactions everywhere: hover states, button press feedback, animated toggles, magnetic buttons, smooth focus states.
Cohesive design system: consistent spacing scale, border radii, color tokens, and component styling throughout.

Authentication flow:

Stunning login page with the three.js ambient background, email + password, "remember me", forgot-password link. Any credentials log in. Animated transition into the app. Logout returns here.

Core views (build all with real depth and polish):

Dashboard — animated stat cards (total clients, sessions this month, hours logged, revenue, outstanding payments) with count-up numbers; an elegant monthly income chart; upcoming sessions; per-psychologist quick stats. Choreographed reveal on load.
Psychologists — practitioner roster, each with their own caseload; drill into a single psychologist's clients and monthly summary.
Clients — searchable, filterable client list with smooth filtering animations; client detail page with contact info, assigned psychologist, full session history, recommendations/notes, and payment status.
Sessions / Calendar — beautiful monthly list + calendar view; each session shows client, date, psychologist, status toggle (completed / cancelled / no-show), and payment state (paid / unpaid / partial); add new session.
Add/Edit session form — refined form with client, psychologist, date & time, status, amount, paid status, and recommendations — with polished inputs and validation states.
Payments / Finances — filterable payments table (by month, by psychologist); collected vs. outstanding totals; per-psychologist breakdown with subtle data-viz.
Monthly summary / Reports — the hero feature replacing her Excel: pick a month, see total hours and income broken down per psychologist and for the whole center, with elegant charts and an export/print button (stub). Make this view sing.
Settings — profile, center info, manage psychologists, preferences.

Navigation:

Persistent, beautifully designed sidebar (icons + labels, animated active state) and a top bar showing the logged-in user, current month, and logout.
Smooth animated transitions between every view.

Mock data:

3–4 psychologists, ~15–20 clients across them, 30+ sessions over a couple of months with varied statuses and payment states — so every table, filter, chart, and summary is richly populated (no empty states).

Tech & quality bar:

Single-page React app. Load GSAP and three.js via CDN. All navigation and interactions actually work for a live click-through.
Prioritize performance: animations should stay at 60fps; the three.js scene must be lightweight.
Accessibility-minded: readable contrast, keyboard-focusable controls, respects prefers-reduced-motion (gracefully reduce/disable heavy motion).
Treat this as a portfolio-grade piece: every screen should look intentional and finished.

POLISH LANGUAGE!
