const ROLES = Object.freeze(['owner', 'coordinator', 'specialist'])
const RESULT_BOOLEAN_KEYS = Object.freeze([
  'routesOk',
  'actionsOk',
  'guardedSurfacesOk',
  'statusesOk',
  'countsOk',
  'leaksAbsent',
  'exportScopeOk',
  'exportHeadersOk',
  'exportInScopePresent',
  'exportOutOfScopeAbsent',
])
const failed = () => { throw new Error('STAGING_SMOKE_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))

function actorResult(value, role) {
  const keys = [
    'role', ...(role === 'owner' ? ['authorityRefreshClearsState'] : []),
    ...RESULT_BOOLEAN_KEYS,
  ]
  if (!exact(value, keys) || value.role !== role
    || (role === 'owner' && value.authorityRefreshClearsState !== true)
    || RESULT_BOOLEAN_KEYS.some((key) => value[key] !== true)) failed()
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])))
}

export async function runStagingSmoke({ actors }) {
  const results = []
  let cleanupOk = true
  try {
    if (!exact(actors, ROLES) || ROLES.some((role) => (
      !exact(actors[role], ['run', 'cleanup'])
      || typeof actors[role].run !== 'function'
      || typeof actors[role].cleanup !== 'function'
    ))) failed()
    for (const role of ROLES) results.push(actorResult(await actors[role].run(), role))
  } catch {
    cleanupOk = false
  } finally {
    if (plain(actors)) {
      for (const role of [...ROLES].reverse()) {
        try {
          if (await actors[role]?.cleanup?.() !== true) cleanupOk = false
        } catch { cleanupOk = false }
      }
    }
  }
  if (!cleanupOk || results.length !== ROLES.length) failed()
  return Object.freeze({
    actors: Object.freeze(results),
    browserCleanup: true,
    downloadCleanup: true,
    traceCleanup: true,
    status: 'ok',
  })
}
