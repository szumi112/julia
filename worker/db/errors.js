const messageOf = (error) => {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return ''
    const message = Reflect.get(error, 'message')
    return typeof message === 'string' ? message : String(message)
  } catch {
    return ''
  }
}

const exactSignal = (error, signal) => new RegExp(
  `^(?:${signal}: SQLITE_CONSTRAINT(?: \\(extended: SQLITE_CONSTRAINT_TRIGGER\\))?|D1_ERROR: ${signal}: SQLITE_CONSTRAINT(?: \\(extended: SQLITE_CONSTRAINT_TRIGGER\\))?)$`
).test(messageOf(error))

export const isD1IdentityCollision = (error) => exactSignal(error, 'identity_collision')

export const isD1LastActiveOwner = (error) => exactSignal(error, 'last_active_owner')

export const isD1RateLimitGuardFailure = (error) => exactSignal(error, 'rate_limit_guard_failed')

export const isD1CoreDirectoryInvariantFailure = (error) => exactSignal(error, 'core_directory_invariant_failed')

export const isD1OutboxOperationGuardFailure = (error) => exactSignal(error, 'outbox_operation_guard_failed')

export const classifyCoreConstraintError = (error) => exactSignal(error, 'invalid_payment_correction')
  ? 'PAYMENT_CORRECTION_CONFLICT'
  : null

export const classifyOwnerTransitionError = (error, context) => {
  if (isD1LastActiveOwner(error)) return 'LAST_ACTIVE_OWNER'
  const guardProven = context && typeof context === 'object' && !Array.isArray(context)
    && Object.getPrototypeOf(context) === Object.prototype
    && Object.keys(context).length === 1 && Object.hasOwn(context, 'guardProven')
    && context.guardProven === true
  return guardProven && isD1IdentityCollision(error) ? 'VERSION_CONFLICT' : null
}
