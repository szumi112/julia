// Only these stable codes may cross the operations API boundary; never expose raw errors.
export const BACKUP_FAILURE_COPY = Object.freeze({
  BACKUP_CREATE_FAILED: 'Nie udało się utworzyć kopii. System nie zapisał dokładniejszej przyczyny.',
  BACKUP_EXPORT_START_FAILED: 'Nie udało się rozpocząć eksportu bazy danych. Administrator powinien sprawdzić dostęp usługi kopii do bazy.',
  BACKUP_EXPORT_DOWNLOAD_FAILED: 'Nie udało się pobrać eksportu bazy danych. Administrator powinien sprawdzić dostępność usługi eksportu.',
  BACKUP_EXPORT_TIMEOUT: 'Eksport bazy przekroczył limit czasu.',
  BACKUP_EXPORT_REDIRECTED: 'Usługa eksportu zwróciła niedozwolone przekierowanie. Tworzenie kopii zostało przerwane.',
  BACKUP_EXPORT_RESPONSE_INVALID: 'Usługa eksportu zwróciła nieprawidłową odpowiedź.',
  BACKUP_FINALIZE_UNCERTAIN: 'Nie udało się potwierdzić zakończenia zapisu kopii. Administrator powinien sprawdzić jej stan.',
  BACKUP_LEASE_LOST: 'Zadanie utraciło prawo do kontynuowania tej próby. Administrator powinien sprawdzić kolejne próby.',
  OUTBOX_LEASE_EXPIRED: 'Upłynął czas zarezerwowany na wykonanie zadania kopii.',
  BACKUP_MIGRATION_SET_CHANGED: 'Podczas tworzenia kopii zmieniła się struktura bazy. Potrzebna jest nowa próba po zakończeniu aktualizacji.',
  BACKUP_ORPHAN_CLEANUP_FAILED: 'Nie udało się posprzątać plików po przerwanej próbie. Administrator powinien sprawdzić magazyn kopii.',
  BACKUP_STATE_INVALID: 'Stan zadania kopii jest niespójny. Wymaga sprawdzenia przez administratora.',
})

export const isBackupFailureCode = (value) => typeof value === 'string'
  && Object.hasOwn(BACKUP_FAILURE_COPY, value)
