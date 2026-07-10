// GSAP helpers. Every effect degrades gracefully: if GSAP is missing or
// the user prefers reduced motion, elements simply stay in their final state.
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { fmtNumber } from './format.js'

// Entrance tweens only touch transform + autoAlpha — clearing exactly those
// keeps inline layout styles on animated elements intact ('all' would wipe them).
const CLEAR = 'transform,opacity,visibility'

let reduceOverride = false

// Long-lived animation loops (Three.js scenes) subscribe here so flipping the
// in-app reduced-motion setting stops them live, not on next mount.
const motionSubs = new Set()
const notifyMotion = () => motionSubs.forEach((fn) => fn(motionOK()))
export const onMotionChange = (fn) => {
  motionSubs.add(fn)
  return () => motionSubs.delete(fn)
}

export const setReduceMotion = (v) => {
  if (reduceOverride === !!v) return
  reduceOverride = !!v
  // Clear running tweens before listeners update their loops; otherwise a
  // long-lived scene can continue moving for a frame after the preference flips.
  window.gsap?.globalTimeline.clear()
  // CSS animations (breathing dots, transitions) obey the in-app pref too
  document.documentElement.classList.toggle('rm', reduceOverride)
  notifyMotion()
}

const osReduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)')
osReduceMQ.addEventListener?.('change', notifyMotion)

export const motionOK = () =>
  !!window.gsap &&
  !reduceOverride &&
  !osReduceMQ.matches

const g = () => window.gsap

// Staggered entrance for [data-reveal] children + scroll-triggered reveal
// for [data-reveal-scroll] children (IntersectionObserver + GSAP tween).
export function useReveal(deps = []) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const items = root.querySelectorAll('[data-reveal]')
    const scrollItems = root.querySelectorAll('[data-reveal-scroll]')
    if (!motionOK()) return

    if (items.length) {
      g().fromTo(
        items,
        { autoAlpha: 0, y: 22 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.85,
          ease: 'power3.out',
          stagger: 0.07,
          clearProps: CLEAR,
          overwrite: 'auto',
        }
      )
    }

    // day-thread rules ([data-spine]) draw in from the top once per mount
    const spines = root.querySelectorAll('[data-spine]')
    if (spines.length) {
      g().fromTo(
        spines,
        { scaleY: 0 },
        { scaleY: 1, duration: 0.9, ease: 'power3.inOut', delay: 0.15, clearProps: 'transform' }
      )
    }

    let io
    if (scrollItems.length) {
      g().set(scrollItems, { autoAlpha: 0, y: 26 })
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              g().to(e.target, {
                autoAlpha: 1,
                y: 0,
                duration: 0.9,
                ease: 'power3.out',
                clearProps: CLEAR,
              })
              io.unobserve(e.target)
            }
          })
        },
        { threshold: 0.12 }
      )
      scrollItems.forEach((el) => io.observe(el))
    }
    return () => io && io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return ref
}

// Animated number counter. Tracks the value actually on screen so an
// interrupted tween restarts from the displayed number, not the old target.
export function useCountUp(value, fmt = fmtNumber, duration = 1.4) {
  const ref = useRef(null)
  const shown = useRef(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!motionOK()) {
      el.textContent = fmt(value)
      shown.current = value
      return
    }
    const obj = { v: shown.current }
    const tween = g().to(obj, {
      v: value,
      duration,
      ease: 'expo.out',
      onUpdate: () => {
        shown.current = obj.v
        el.textContent = fmt(obj.v)
      },
    })
    return () => tween.kill()
  }, [value, fmt, duration])
  return ref
}

// Magnetic hover for primary CTAs. quickTo retargets one tween pair per
// hover instead of allocating a new tween on every mousemove. The setters are
// recreated on each enter because the elastic release overwrites (kills) them.
export function useMagnetic(strength = 0.32) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !motionOK()) return
    let toX, toY
    const enter = () => {
      toX = g().quickTo(el, 'x', { duration: 0.5, ease: 'power3.out' })
      toY = g().quickTo(el, 'y', { duration: 0.5, ease: 'power3.out' })
    }
    const move = (e) => {
      if (!toX) enter()
      const r = el.getBoundingClientRect()
      toX((e.clientX - (r.left + r.width / 2)) * strength)
      toY((e.clientY - (r.top + r.height / 2)) * strength)
    }
    const leave = () => {
      toX = toY = null
      g().to(el, { x: 0, y: 0, duration: 0.8, ease: 'elastic.out(1, 0.45)', overwrite: 'auto' })
    }
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mousemove', move)
    el.addEventListener('mouseleave', leave)
    return () => {
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mousemove', move)
      el.removeEventListener('mouseleave', leave)
      g().killTweensOf(el, 'x,y')
    }
  }, [strength])
  return ref
}

// View-exit animation used by the router before swapping views. dir encodes
// drill-in continuity: 1 = deeper (list → detail, exits left), -1 = back out.
export function animateOut(el, dir = 0) {
  return new Promise((resolve) => {
    if (!el || !motionOK()) return resolve()
    g().to(el, {
      autoAlpha: 0,
      x: dir ? -18 * dir : 0,
      y: dir ? 0 : -14,
      duration: 0.22,
      ease: 'power2.in',
      onComplete: resolve,
    })
  })
}

export function animateIn(el) {
  if (!el || !motionOK()) return
  g().fromTo(
    el,
    { autoAlpha: 0, y: 10 },
    { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power3.out', clearProps: CLEAR }
  )
}

// Shared slide-over drawer choreography (entrance stagger, animated exit,
// Escape-to-close, focus trap + restore, shake-on-error) — used by every
// form drawer.
export function useDrawerFX(drawerRef, backRef, onClose) {
  const closing = useRef(false)

  useEffect(() => {
    const drawer = drawerRef.current
    if (!drawer) return
    if (motionOK()) {
      g().fromTo(backRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.35 })
      g().fromTo(drawer, { x: '102%' }, { x: '0%', duration: 0.55, ease: 'power4.out' })
      const items = drawer.querySelectorAll('.field, .drawer__head, .drawer__foot')
      g().fromTo(
        items,
        { autoAlpha: 0, x: 26 },
        { autoAlpha: 1, x: 0, duration: 0.55, ease: 'power3.out', stagger: 0.035, delay: 0.1, clearProps: CLEAR }
      )
    }
    // the entrance stagger starts fields at visibility:hidden, so focus the
    // first form control once it is visible again
    const t = setTimeout(() => {
      drawer.querySelector('input, select, textarea')?.focus()
    }, motionOK() ? 220 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = useCallback(() => {
    if (closing.current) return
    if (!motionOK()) return onClose()
    closing.current = true
    g().to(backRef.current, { autoAlpha: 0, duration: 0.3 })
    g().to(drawerRef.current, { x: '102%', duration: 0.42, ease: 'power3.in', onComplete: onClose })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose])

  // Escape closes the drawer — unless an overlay above it (command palette)
  // already handled the keypress
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.cmd')) close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close])

  // focus trap (aria-modal promises it) + restore focus to the opener on close
  useEffect(() => {
    const opener = document.activeElement
    const drawer = drawerRef.current
    const onTab = (e) => {
      if (e.key !== 'Tab' || !drawer) return
      // visibility check matters during the entrance stagger: autoAlpha keeps
      // fields visibility:hidden (offsetParent non-null), and the browser
      // skips those in real Tab order — the trap must reason over the same set
      const els = [...drawer.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden')
      if (!els.length) return
      const first = els[0]
      const last = els[els.length - 1]
      const inside = drawer.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onTab)
    return () => {
      document.removeEventListener('keydown', onTab)
      if (opener && typeof opener.focus === 'function') opener.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shake = useCallback(() => {
    if (motionOK() && drawerRef.current) {
      g().fromTo(drawerRef.current, { x: 0 }, { x: 8, duration: 0.06, repeat: 5, yoyo: true, clearProps: 'x' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { close, shake }
}

// FLIP-style reorder for keyed children ([data-flip-id]) — rows that move
// glide to their new position, new rows fade in. Uses offsetTop (not
// getBoundingClientRect) so ancestor reveal transforms don't skew positions.
export function useFlip(depKey) {
  const ref = useRef(null)
  const tops = useRef(new Map())
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const children = [...root.querySelectorAll('[data-flip-id]')]
    const next = new Map()
    children.forEach((el) => next.set(el.dataset.flipId, el.offsetTop))
    if (motionOK() && tops.current.size) {
      children.forEach((el) => {
        const prev = tops.current.get(el.dataset.flipId)
        if (prev != null) {
          const dy = prev - next.get(el.dataset.flipId)
          if (Math.abs(dy) > 2) {
            g().fromTo(el, { y: dy }, { y: 0, duration: 0.55, ease: 'power3.out', clearProps: 'transform', overwrite: true })
          }
        } else {
          g().fromTo(el, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power2.out', clearProps: CLEAR, overwrite: true })
        }
      })
    }
    tops.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey])
  return ref
}

// Celebration burst — small gold/rose petals scattering from an element.
export function goldBurst(el) {
  if (!el || !motionOK()) return
  const r = el.getBoundingClientRect()
  // the anchor may be display:none on small screens (e.g. the month chip)
  if (!r.width && !r.height) return
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const colors = ['#ac8a4e', '#c2808d', '#dcc488', '#964d5f', '#e8cfa0', '#7d8c6c']
  const wrap = document.createElement('div')
  wrap.className = 'burst'
  document.body.appendChild(wrap)
  const n = 22
  for (let i = 0; i < n; i++) {
    const bit = document.createElement('span')
    bit.className = 'burst__bit'
    bit.style.background = colors[i % colors.length]
    if (i % 3 === 0) bit.style.borderRadius = '62% 38% 55% 45%'
    wrap.appendChild(bit)
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.5
    const dist = 56 + Math.random() * 92
    g().set(bit, { x: cx, y: cy, scale: 0.5 + Math.random() * 0.8 })
    g().to(bit, {
      x: cx + Math.cos(a) * dist,
      y: cy + Math.sin(a) * dist - 42,
      rotation: Math.random() * 260 - 130,
      scale: 0,
      duration: 0.9 + Math.random() * 0.5,
      ease: 'power3.out',
    })
  }
  g().fromTo(el, { scale: 1 }, { scale: 1.03, duration: 0.18, yoyo: true, repeat: 1, ease: 'power2.out', clearProps: 'transform' })
  setTimeout(() => wrap.remove(), 1600)
}
