import { useCallback, useEffect, useState } from 'react'

import { financeRepository } from '../finance-repository.js'

export function financeWindowPresentation({ selectedMonth, requestMonth, status, data }) {
  const isCurrent = data?.selectedMonth === selectedMonth
  const isStale = isCurrent && (status === 'refreshing' || status === 'error')
  if (status === 'ready' && isCurrent) return { phase: 'ready', isCurrent, isStale: false }
  if (status === 'error') return { phase: isCurrent && data !== null ? 'refresh-error' : 'error', isCurrent, isStale }
  return { phase: data === null || requestMonth !== selectedMonth ? 'loading' : 'refreshing', isCurrent, isStale }
}

export function useFinanceWindow(selectedMonth) {
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState(() => ({
    requestMonth: selectedMonth, status: 'loading', data: null, error: null,
  }))

  useEffect(() => {
    const controller = new AbortController()
    setState((current) => ({
      requestMonth: selectedMonth,
      status: current.data === null ? 'loading' : 'refreshing',
      data: current.data,
      error: null,
    }))
    financeRepository.loadFinanceWindow(
      { selectedMonth }, { signal: controller.signal },
    ).then((data) => {
      if (!controller.signal.aborted) setState({
        requestMonth: selectedMonth, status: 'ready', data, error: null,
      })
    }).catch((error) => {
      if (!controller.signal.aborted) setState((current) => ({
        requestMonth: selectedMonth, status: 'error', data: current.data, error,
      }))
    })
    return () => controller.abort()
  }, [reloadToken, selectedMonth])

  const reload = useCallback(() => setReloadToken((value) => value + 1), [])
  const presentation = financeWindowPresentation({ selectedMonth, ...state })
  return { ...state, ...presentation, reload }
}
