---
name: frontend-design-guidelines
description: Design and review UI in one pass — make distinctive, subject-specific design choices, then audit the result against the Web Interface Guidelines (accessibility, focus states, forms, motion, performance, copy). Use when building new UI, reshaping existing UI, or reviewing/auditing a frontend.
metadata:
  author: adapted-combination
  sources:
    - "anthropics/skills — frontend-design (design philosophy)"
    - "vercel-labs/agent-skills — web-design-guidelines (review rules)"
  version: "1.0.0"
---

# Frontend Design + Guidelines

Two phases. **Design** makes it distinctive; **Review** makes it correct.
Run both when building or reshaping UI. Run Review alone when auditing existing code.

Before starting, ask which mode applies if it's unclear: build/reshape (both
phases) or audit-only (Phase 2). For build/reshape, work one screen at a time.

---

## Phase 1 — Design

Act as the design lead at a studio known for identities that couldn't be mistaken
for anyone else's. Make deliberate, opinionated choices; take one aesthetic risk
you can justify.

**Ground it in the subject.** Name the concrete product, its audience, and this
screen's single job — state your choice. Draw distinctive decisions from the
subject's own world (its materials, vocabulary, artifacts), not from generic taste.

**Principles**

- The hero is a thesis: open with the most characteristic thing, in whatever form
  fits. Avoid the template answer (big number + label + gradient accent).
- Typography carries personality. Pair display and body faces deliberately; set an
  intentional type scale. Don't treat type as a neutral delivery vehicle.
- Structure encodes meaning. Only use devices like numbered markers (01/02/03) when
  the content is genuinely a sequence. Question every decorative device.
- Motion is deliberate. One orchestrated moment beats scattered effects — excess
  animation is what makes a design feel AI-generated.
- Match complexity to the vision: maximalist needs elaborate execution; minimal
  needs precision in spacing, type, and detail.

**Avoid the AI defaults.** Don't spend a free design choice on: cream + high-contrast
serif + terracotta accent; near-black + one acid-green/vermilion accent; broadsheet
hairline-rule columns. These appear regardless of subject. If the brief explicitly
asks for one, follow it; otherwise go elsewhere.

**Process**

1. Draft a compact token system: 4–6 named hex colors, 2+ typefaces by role, a
   one-sentence layout concept, and ONE signature element to be remembered by.
2. Review the plan against the brief. If any part is what you'd produce for ANY
   similar screen, revise it and say what changed and why.
3. Only then write code, deriving every color and type choice from the plan.

Spend boldness in one place; keep everything else quiet.

---

## Phase 2 — Review against the Web Interface Guidelines

After building (or when auditing), check the code against the rules in
`references/web-interface-guidelines.md`. That file is the authoritative rule set —
read it and apply every rule. It covers:

- **Accessibility** — semantic HTML, `aria-label` on icon buttons, labels on
  controls, keyboard handlers, alt text, `aria-live` for async updates.
- **Focus states** — visible `:focus-visible` rings; never `outline: none` without
  a replacement.
- **Forms** — correct `type`/`inputmode`, `autocomplete`, clickable labels, inline
  errors that focus the first error, never block paste.
- **Animation** — honor `prefers-reduced-motion`, animate only `transform`/`opacity`,
  never `transition: all`, keep animations interruptible.
- **Typography** — real ellipsis `…`, curly quotes, non-breaking spaces, tabular
  numerals for columns, balanced headings.
- **Content handling** — truncation, `min-w-0` on flex children, empty states.
- **Images** — explicit `width`/`height` to prevent CLS, lazy vs. priority loading.
- **Performance** — virtualize large lists, no layout reads in render, preconnect.
- **Navigation & state** — URL reflects state, real links, confirm destructive actions.
- **Touch, safe areas, dark mode, i18n, hydration, hover states, copy.**

**Output format for the review.** Group by file. Use terse `file:line` findings,
skip explanation unless the fix is non-obvious, no preamble:

```text
## src/Button.tsx
src/Button.tsx:42 - icon button missing aria-label
src/Button.tsx:55 - animation missing prefers-reduced-motion

## src/Card.tsx
✓ pass
```

In build/reshape mode, fix the issues you find before finishing rather than only
reporting them.

---

## Keeping the guidelines current

`references/web-interface-guidelines.md` is a bundled snapshot. To refresh it with
the latest upstream rules:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md \
  -o references/web-interface-guidelines.md
```
