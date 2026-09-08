const REQUIRED = Object.freeze([
  'BETTER_AUTH_SECRET',
])

const valid = (value, minimum = 1) => typeof value === 'string'
  && value === value.trim() && value.length >= minimum && value.length <= 4096
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)

export function validateStagingAuthPreflight(env, target) {
  if (target !== 'staging') throw new Error('STAGING_AUTH_PREFLIGHT_REFUSED')
  if (!env || typeof env !== 'object'
    || REQUIRED.some((name) => !valid(env[name], 32))) {
    throw new Error('STAGING_AUTH_PREFLIGHT_FAILED')
  }
  return Object.freeze({ ready: true })
}

export function authenticationRollbackStatements(tableNames) {
  if (!Array.isArray(tableNames) || tableNames.some((name) => typeof name !== 'string')) {
    throw new Error('AUTH_ROLLBACK_PREFLIGHT_FAILED')
  }
  const names = new Set(tableNames)
  return Object.freeze(['auth_session', 'auth_verification']
    .filter((name) => names.has(name))
    .map((name) => `DELETE FROM ${name}`))
}
