export const isD1IdentityCollision = (error) => /^(?:identity_collision: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: identity_collision: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')

export const isD1LastActiveOwner = (error) => /^(?:last_active_owner: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?|D1_ERROR: last_active_owner: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)$/.test(error?.message ?? '')
