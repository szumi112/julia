const messageOf = (error) => {
  try {
    if (!(error instanceof Error)) return ''
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message')
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return ''
    const snapshot = structuredClone(error)
    const snapshotDescriptor = Object.getOwnPropertyDescriptor(snapshot, 'message')
    if (!snapshotDescriptor || !Object.hasOwn(snapshotDescriptor, 'value')) return ''
    return snapshotDescriptor.value === descriptor.value ? descriptor.value : ''
  } catch {
    return ''
  }
}

const exactSignal = (error, signal) => new RegExp(
  `^(?:${signal}: SQLITE_CONSTRAINT(?: \\(extended: SQLITE_CONSTRAINT_TRIGGER\\))?|D1_ERROR: ${signal}: SQLITE_CONSTRAINT(?: \\(extended: SQLITE_CONSTRAINT_TRIGGER\\))?)$`
).test(messageOf(error))

const MISSING_COLUMNS = new Set([
  'specialist.display_name_envelope',
  'specialist.professional_title_envelope',
])

export const isD1IdentityCollision = (error) => exactSignal(error, 'identity_collision')

export const isD1FinanceSourceDuplicate = (error) => exactSignal(error, 'finance_source_duplicate')

export const isD1LastActiveOwner = (error) => exactSignal(error, 'last_active_owner')

export const isD1RateLimitGuardFailure = (error) => exactSignal(error, 'rate_limit_guard_failed')

export const isD1CoreDirectoryInvariantFailure = (error) => exactSignal(error, 'core_directory_invariant_failed')

export const isD1OutboxOperationGuardFailure = (error) => exactSignal(error, 'outbox_operation_guard_failed')

export const isD1InvalidOutboxRecoveryEdge = (error) => exactSignal(error, 'invalid_recovery_edge')

export const isD1MissingColumn = (error, column) => {
  if (!MISSING_COLUMNS.has(column)) return false
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `^(?:no such column: ${escaped}|D1_ERROR: no such column: ${escaped}(?: at offset \\d+)?: SQLITE_ERROR)$`,
  ).test(messageOf(error))
}

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
