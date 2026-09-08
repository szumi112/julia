// The API orders open actions newest first. Only backup failures share a display group.
export function groupOperationalActions(actions) {
  const groups = []
  let backups
  for (const action of actions) {
    if (action.kind !== 'backup_failed') groups.push([action])
    else if (backups) backups.push(action)
    else {
      backups = [action]
      groups.push(backups)
    }
  }
  return groups
}

export const ACTION_GUIDANCE = Object.freeze({
  backup_failed: 'Nie powstała nowa kopia z tej próby. To nie oznacza utraty danych w panelu, ale może ograniczyć możliwość ich odtworzenia po awarii. Administrator powinien sprawdzić przyczynę i potwierdzić utworzenie nowej kopii.',
  backup_stale: 'Bez aktualnej kopii po awarii można odtworzyć jedynie starszy stan danych. Poproś administratora o sprawdzenie tworzenia kopii i potwierdzenie nowej, udanej kopii.',
  access_reconciliation_lag: 'Zmiany dostępu personelu mogły nie zostać jeszcze zastosowane. Właściciel powinien sprawdzić konta w sekcji Personel oraz nieudane zadania synchronizacji na tej liście.',
  authorization_denial_spike: 'System zablokował próby wykonania czynności bez wymaganych uprawnień. Sam alarm nie potwierdza włamania. Właściciel powinien sprawdzić zdarzenia w zakładce Bezpieczeństwo i uprawnienia personelu.',
  outbox_job_failed: 'Automatyczne zadanie nie zostało zakończone. Jeśli dostępne jest ponowienie, właściciel może je zlecić. Gdy błąd wraca lub ponowienie nie jest dostępne, potrzebna jest pomoc administratora.',
  scheduler_stale: 'Automatyczne kontrole i tworzenie kopii mogą być opóźnione. Poproś administratora o sprawdzenie działania zadań cyklicznych.',
})

export const HEALTH_GUIDANCE = Object.freeze({
  'backup.freshness': 'Sprawdzamy, czy kopia danych została zapisana i czy nie jest starsza niż 36 godzin. Udany zapis nie jest potwierdzeniem testu odtworzenia danych.',
  'outbox.processing': 'Kolejka wykonuje zadania w tle, m.in. wysyłkę zaproszeń i aktualizację dostępu. Błąd może opóźnić te czynności. Nieudane zadania znajdziesz w zakładce Działania.',
  'access.reconciliation': 'Sprawdzamy, czy zmiany dostępu personelu zostały zastosowane. Opóźnienie może oznaczać, że przyznanie lub odebranie dostępu jeszcze się nie zakończyło.',
  'scheduler.runs': 'Sprawdzamy, czy uruchamiają się automatyczne kontrole i obsługa kopii. Brak zakończenia przez ponad 15 minut wymaga sprawdzenia przez administratora.',
})

export const AUDIT_ENTITY_LABELS = Object.freeze({
  staff_user: 'konto personelu', staff_invitation: 'zaproszenie personelu',
  access_group: 'dostęp do centrum', backup_run: 'kopia zapasowa',
  data_key: 'zabezpieczenie danych', operational_action: 'zgłoszenie operacyjne',
  outbox_job: 'zadanie w tle', client: 'klient', appointment: 'wizyta',
  payment_entry: 'płatność', finance_import: 'import finansowy',
  activity_attendance: 'obecność na zajęciach', activity_projection_job: 'import aktywności',
  workbook_import: 'import arkusza', workbook_export: 'eksport arkusza',
  payment: 'płatność', specialist: 'specjalista', activity_group: 'grupa zajęciowa',
  activity_participant: 'uczestnik zajęć', activity_class: 'zajęcia grupowe',
  activity_membership: 'członkostwo w grupie', activity_charge: 'rozliczenie zajęć',
  finance_entry: 'pozycja finansowa',
})
