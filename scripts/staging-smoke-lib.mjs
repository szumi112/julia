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
const EXPORT_EVIDENCE_KEYS = Object.freeze([
  'actor', 'scope', 'status', 'byteSize', 'sha256',
])
const MAX_EXPORT_BYTES = 10 * 1024 * 1024
const failed = () => { throw new Error('STAGING_SMOKE_FAILED') }
const plain = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))

function acceptedExportEvidence(value, role) {
  const scope = role === 'specialist' ? 'own' : 'centre'
  if (!exact(value, EXPORT_EVIDENCE_KEYS)
    || value.actor !== role || value.scope !== scope || value.status !== 'verified'
    || !Number.isSafeInteger(value.byteSize) || value.byteSize < 1
    || value.byteSize > MAX_EXPORT_BYTES
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) failed()
  return Object.freeze(Object.fromEntries(
    EXPORT_EVIDENCE_KEYS.map((key) => [key, value[key]]),
  ))
}

function actorResult(value, role) {
  const keys = [
    'role', ...(role === 'owner' ? ['authorityRefreshClearsState'] : []),
    'exportEvidence',
    ...RESULT_BOOLEAN_KEYS,
  ]
  if (!exact(value, keys) || value.role !== role
    || (role === 'owner' && value.authorityRefreshClearsState !== true)
    || RESULT_BOOLEAN_KEYS.some((key) => value[key] !== true)) failed()
  const exportEvidence = acceptedExportEvidence(value.exportEvidence, role)
  return Object.freeze(Object.fromEntries(keys.map((key) => [
    key, key === 'exportEvidence' ? exportEvidence : value[key],
  ])))
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
