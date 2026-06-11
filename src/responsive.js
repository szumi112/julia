// Shared responsive breakpoints — keep in sync with the canonical values
// documented at the top of styles.css (CSS media queries can't read JS).
//   phone  ≤ 640px
//   tablet ≤ 1024px (sidebar collapses into the drawer nav)
//   desktop > 1024px
import { useEffect, useState } from 'react'

export const BP = { phone: 640, tablet: 1024 }

export const phoneMQ = `(max-width: ${BP.phone}px)`
export const compactMQ = `(max-width: ${BP.tablet}px)`
export const desktopMQ = `(min-width: ${BP.tablet + 1}px)`

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

// phone-sized viewport
export const useIsPhone = () => useMediaQuery(phoneMQ)
// anything below desktop — the shell swaps the sidebar for a drawer here
export const useIsCompact = () => useMediaQuery(compactMQ)
