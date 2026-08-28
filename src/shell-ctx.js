import { createContext, useContext } from 'react'
import { canAccessProtectedRoute } from './capability-access.js'

const DEMO_ROLE_NAV = Object.freeze({
  owner: Object.freeze([
    'dashboard', 'calendar', 'clients', 'tus', 'team', 'payments', 'reports', 'settings',
  ]),
  coordinator: Object.freeze([
    'dashboard', 'calendar', 'clients', 'tus', 'payments', 'settings',
  ]),
  therapist: Object.freeze([
    'dashboard', 'calendar', 'clients', 'tus', 'settings',
  ]),
})
const DETAIL_PARENT = Object.freeze({
  client: 'clients',
  psych: 'team',
  tusGroup: 'tus',
})
const SHELL_ROUTE_NAMES = new Set([
  'dashboard', 'calendar', 'clients', 'client', 'tus', 'tusGroup', 'team',
  'psych', 'payments', 'ledger', 'reports', 'settings', 'english',
])
const SAFE_ROUTE_ORDER = Object.freeze([
  'dashboard', 'calendar', 'clients', 'tus', 'english', 'team', 'payments', 'ledger',
  'reports', 'settings',
])

export const ShellCtx = createContext(null)
export const useShell = () => useContext(ShellCtx)

export function canAccessShellRoute(context, routeName) {
  try {
    if (!context || typeof context !== 'object' || Array.isArray(context)
      || typeof routeName !== 'string' || !SHELL_ROUTE_NAMES.has(routeName)) return false
    if (context.appMode === 'app') {
      return canAccessProtectedRoute(context.capabilities, routeName)
    }
    if (context.appMode !== 'demo') return false
    const parent = DETAIL_PARENT[routeName] || routeName
    return DEMO_ROLE_NAV[context.roleId]?.includes(parent) === true
  } catch {
    return false
  }
}

export function firstAccessibleShellRoute(context) {
  return SAFE_ROUTE_ORDER.find((routeName) => (
    canAccessShellRoute(context, routeName)
  )) ?? null
}

export function resolveShellRoute(context, requested) {
  try {
    if (requested && typeof requested === 'object' && !Array.isArray(requested)) {
      const descriptor = Object.getOwnPropertyDescriptor(requested, 'name')
      if (descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
        && canAccessShellRoute(context, descriptor.value)) return requested
    }
  } catch { /* Fall through to the first safe route. */ }
  const name = firstAccessibleShellRoute(context)
  return name === null ? null : { name }
}
