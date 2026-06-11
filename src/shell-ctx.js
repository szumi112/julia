import { createContext, useContext } from 'react'

export const ShellCtx = createContext(null)
export const useShell = () => useContext(ShellCtx)
