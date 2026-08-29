const WORKSPACE_API_METHODS = Object.freeze([
  'loadWorkspaceWindow', 'createClient', 'editClient', 'archiveClient',
  'activateHistoricalClient',
  'createAppointment', 'editAppointment', 'cancelAppointment', 'recordPayment',
  'correctPayment',
  'loadActivityWorkspace',
  'createActivityGroup', 'editActivityGroup',
  'createActivityParticipant', 'editActivityParticipant',
  'createActivityMembership', 'editActivityMembership',
  'createActivityClass', 'editActivityClass', 'setActivityAttendance',
  'createIdempotencyKey',
])

export const createWorkspaceApiDependency = (source) => {
  let descriptors
  try {
    if (source === null || typeof source !== 'object' || Array.isArray(source)
      || Object.getPrototypeOf(source) !== Object.prototype || !Object.isFrozen(source)) {
      throw new TypeError('Invalid workspace API client')
    }
    descriptors = Object.getOwnPropertyDescriptors(source)
  } catch {
    throw new TypeError('Invalid workspace API client')
  }
  const dependency = {}
  for (const name of WORKSPACE_API_METHODS) {
    const descriptor = descriptors[name]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function') {
      throw new TypeError('Invalid workspace API client')
    }
    const method = descriptor.value
    dependency[name] = (...args) => Reflect.apply(method, source, args)
  }
  return Object.freeze(dependency)
}
