export const BACKUP_SQL_MAX_BYTES = 64 * 1024 * 1024
export const BACKUP_SQL_IMPORT_MAX_BYTES = BACKUP_SQL_MAX_BYTES * 2

export function nextBackupSqlByteCount(current, chunk) {
  if (!Number.isSafeInteger(current) || current < 0
    || !Number.isSafeInteger(chunk) || chunk < 1
    || chunk > BACKUP_SQL_MAX_BYTES - current) return null
  return current + chunk
}
