import { useCallback, useEffect, useState } from 'react'

import { financeRepository } from '../finance-repository.js'

export function useFinanceWindow(selectedMonth) {
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState(() => ({
    requestMonth: selectedMonth, status: 'loading', data: null, error: null,
  }))

  useEffect(() => {
    const controller = new AbortController()
    setState({ requestMonth: selectedMonth, status: 'loading', data: null, error: null })
    financeRepository.loadFinanceWindow(
      { selectedMonth }, { signal: controller.signal },
    ).then((data) => {
      if (!controller.signal.aborted) setState({
        requestMonth: selectedMonth, status: 'ready', data, error: null,
      })
    }).catch((error) => {
      if (!controller.signal.aborted) setState({
        requestMonth: selectedMonth, status: 'error', data: null, error,
      })
    })
    return () => controller.abort()
  }, [reloadToken, selectedMonth])

  const reload = useCallback(() => setReloadToken((value) => value + 1), [])
  if (state.requestMonth !== selectedMonth) {
    return { status: 'loading', data: null, error: null, reload }
  }
  return { status: state.status, data: state.data, error: state.error, reload }
}
