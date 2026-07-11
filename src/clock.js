import { useEffect, useState } from 'react'

// A lightweight shared clock for UI whose state changes at class boundaries.
// Align to the next minute, then update once a minute; visibility refresh keeps
// a backgrounded tab correct without running a high-frequency timer.
export function useMinuteNow() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let interval
    const tick = () => setNow(new Date())
    const delay = 60_000 - (Date.now() % 60_000)
    const timeout = setTimeout(() => {
      tick()
      interval = setInterval(tick, 60_000)
    }, delay)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearTimeout(timeout)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return now
}
