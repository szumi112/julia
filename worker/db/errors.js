export const isD1IdentityCollision = (error) => /^(?:identity_collision: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: identity_collision: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')

export const isD1LastActiveOwner = (error) => /^(?:last_active_owner: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: last_active_owner: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')

export const classifyOwnerTransitionError = (error) => isD1LastActiveOwner(error) ? 'LAST_ACTIVE_OWNER'
  : isD1IdentityCollision(error) ? 'VERSION_CONFLICT' : null
