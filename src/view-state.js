export function readRouteViewState(registry, roleId, routeName, defaults = {}) {
  return { ...defaults, ...(registry[roleId]?.[routeName] || {}) }
}

export function patchRouteViewState(registry, roleId, routeName, patch) {
  const roleState = registry[roleId] || {}
  return {
    ...registry,
    [roleId]: {
      ...roleState,
      [routeName]: {
        ...(roleState[routeName] || {}),
        ...patch,
      },
    },
  }
}

export function resetRouteViewState(registry, roleId, routeName) {
  const roleState = registry[roleId]
  if (!roleState || !(routeName in roleState)) return registry
  const { [routeName]: _removed, ...remainingRoutes } = roleState
  return { ...registry, [roleId]: remainingRoutes }
}

export function clearRoleViewState(registry, roleId) {
  if (!(roleId in registry)) return registry
  const { [roleId]: _removed, ...remainingRoles } = registry
  return remainingRoles
}
