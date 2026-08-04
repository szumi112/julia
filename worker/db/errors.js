export const isD1IdentityCollision = (error) => /^(?:identity_collision: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: identity_collision: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')

export const isD1LastActiveOwner = (error) => /^(?:last_active_owner: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: last_active_owner: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')

export const isD1RateLimitGuardFailure = (error) => /^(?:rate_limit_guard_failed: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: rate_limit_guard_failed: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')

export const isD1CoreDirectoryInvariantFailure = (error) => /^(?:core_directory_invariant_failed: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: core_directory_invariant_failed: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')

export const isD1OutboxOperationGuardFailure = (error) => /^(?:outbox_operation_guard_failed: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: outbox_operation_guard_failed: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')

export const classifyOwnerTransitionError = (error, context) => {
  if (isD1LastActiveOwner(error)) return 'LAST_ACTIVE_OWNER'
  const guardProven = context && typeof context === 'object' && !Array.isArray(context)
    && Object.getPrototypeOf(context) === Object.prototype
    && Object.keys(context).length === 1 && Object.hasOwn(context, 'guardProven')
    && context.guardProven === true
  return guardProven && isD1IdentityCollision(error) ? 'VERSION_CONFLICT' : null
}
