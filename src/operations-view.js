import { relDayLabel, warsawDateTimeFromUtc } from './format.js'

export const BACKUP_STALE_HOURS = 36

const STATUS_RANK = Object.freeze({ ok: 0, pending: 0, warning: 1, critical: 2 })
const SOURCE_PRIORITY = Object.freeze({
  'backup.freshness': 0,
  'access.reconciliation': 1,
  'outbox.processing': 2,
  'scheduler.runs': 3,
})

// "dziś, 03:15" / "wczoraj, 22:14" / "8 wrz, 22:14" in Warsaw time; null when
// the instant cannot be read.
export function relInstantLabel(instant) {
  const ms = Date.parse(instant ?? '')
  if (!Number.isFinite(ms)) return null
  const { date, time } = warsawDateTimeFromUtc(new Date(ms).toISOString())
  return `${relDayLabel(date)}, ${time}`
}

const checkFor = (health, id) => health?.checks?.find((check) => check.id === id) ?? null

export function backupFreshnessState(health) {
  const check = checkFor(health, 'backup.freshness')
  const generatedMs = Date.parse(health?.generatedAt ?? '')
  const lastSuccessMs = Date.parse(check?.lastSuccessAt ?? '')
  const hasAge = Number.isFinite(generatedMs) && Number.isFinite(lastSuccessMs)
    && lastSuccessMs <= generatedMs
  const ageHours = hasAge ? (generatedMs - lastSuccessMs) / 3_600_000 : null
  const overdue = check?.detailCode === 'BACKUP_STALE'
    || (ageHours !== null && ageHours > BACKUP_STALE_HOURS)
  const status = check?.detailCode === 'BACKUP_FAILED' && !overdue && ageHours !== null
    ? 'warning'
    : check?.status ?? 'pending'
  return Object.freeze({
    ageHours,
    detailCode: check?.detailCode ?? null,
    lastSuccessAt: check?.lastSuccessAt ?? null,
    overdue,
    status,
  })
}

function effectiveCheckStatus(health, check) {
  return check.id === 'backup.freshness'
    ? backupFreshnessState(health).status
    : check.status
}

export function currentOperationalActions(health, actions) {
  const backup = backupFreshnessState(health)
  const scheduler = checkFor(health, 'scheduler.runs')
  const access = checkFor(health, 'access.reconciliation')
  return actions.filter((action) => {
    if (action.kind === 'backup_failed') return false
    if (action.kind === 'backup_stale') {
      return backup.status === 'critical' && backup.overdue
    }
    if (action.kind === 'scheduler_stale') {
      return scheduler?.status === 'critical' && scheduler.detailCode === 'SCHEDULER_STALE'
    }
    if (action.kind === 'access_reconciliation_lag') {
      return access?.status === 'critical'
        && access.detailCode === 'ACCESS_RECONCILIATION_LAG'
    }
    return true
  })
}

export function operationalActionCommand(action, canManageStaff) {
  const recovery = action?.recovery
  if (recovery === null) return 'resolve'
  if (!recovery || typeof recovery !== 'object') return null
  if (recovery.status === 'available') return canManageStaff === true ? 'recover' : null
  if (recovery.status === 'unsafe') return canManageStaff === true ? 'resolve' : null
  return null
}

export function operationsOverview(health, actions) {
  const candidates = []
  for (const check of health?.checks ?? []) {
    const status = effectiveCheckStatus(health, check)
    if ((STATUS_RANK[status] ?? 0) > 0) {
      candidates.push({
        source: check.id,
        status,
        priority: SOURCE_PRIORITY[check.id] ?? 20,
      })
    }
  }
  for (const [index, action] of currentOperationalActions(health, actions).entries()) {
    if ((STATUS_RANK[action.severity] ?? 0) > 0) {
      candidates.push({
        source: action.kind,
        status: action.severity,
        priority: 100 + index,
      })
    }
  }
  candidates.sort((left, right) => (
    STATUS_RANK[right.status] - STATUS_RANK[left.status]
      || left.priority - right.priority
  ))
  const worst = candidates[0]
  if (worst) return Object.freeze({ status: worst.status, source: worst.source })
  return Object.freeze({
    status: health?.generatedAt === null ? 'pending' : 'ok',
    source: null,
  })
}

export function operationsSummary(health, actions) {
  const overview = operationsOverview(health, actions)
  if (overview.status === 'ok') return Object.freeze({
    ...overview,
    title: 'Wszystko działa',
    description: 'Kopie zapasowe i automatyczne kontrole działają prawidłowo.',
  })
  if (overview.status === 'pending') return Object.freeze({
    ...overview,
    title: 'Pierwsze sprawdzenie jest w toku',
    description: 'Stan pojawi się po pierwszym zakończonym sprawdzeniu systemu.',
  })
  if (overview.source === 'backup.freshness') {
    const backup = backupFreshnessState(health)
    if (backup.detailCode === 'BACKUP_PENDING') return Object.freeze({
      ...overview,
      title: 'Kopia zapasowa jest przygotowywana',
      description: 'Pierwsza nocna kopia czeka na zakończenie.',
    })
    if (backup.detailCode === 'BACKUP_FAILED') {
      let description = 'Ostatnia próba kopii się nie udała i nie ma potwierdzonej aktualnej kopii.'
      if (backup.status === 'warning') {
        description = 'Ostatnia próba kopii się nie udała, ale wcześniejsza kopia nadal jest aktualna.'
      } else if (backup.ageHours !== null) {
        description = 'Ostatnia próba kopii się nie udała, a poprzednia udana kopia ma ponad 36 godzin.'
      }
      return Object.freeze({
        ...overview,
        title: backup.status === 'warning'
          ? 'Kopia zapasowa wymaga uwagi'
          : 'Kopia zapasowa wymaga działania',
        description,
      })
    }
    return Object.freeze({
      ...overview,
      title: 'Kopia zapasowa wymaga działania',
      description: 'Od ponad 36 godzin nie powstała nowa kopia zapasowa.',
    })
  }
  if (overview.source === 'access.reconciliation') return Object.freeze({
    ...overview,
    title: 'Zmiany dostępu wymagają sprawdzenia',
    description: 'Przyznanie lub odebranie dostępu mogło jeszcze nie zostać zastosowane.',
  })
  if (overview.source === 'scheduler.runs' || overview.source === 'scheduler_stale') {
    return Object.freeze({
      ...overview,
      title: 'Automatyczne kontrole są opóźnione',
      description: 'Kopie i inne zadania mogą wykonać się później niż zwykle.',
    })
  }
  if (overview.source === 'authorization_denial_spike') return Object.freeze({
    ...overview,
    title: 'Uprawnienia wymagają sprawdzenia',
    description: 'System zablokował więcej działań bez uprawnień niż zwykle.',
  })
  return Object.freeze({
    ...overview,
    title: overview.status === 'critical'
      ? 'Jedna sprawa wymaga działania'
      : 'Jedna sprawa wymaga uwagi',
    description: 'Poniżej znajdziesz prosty opis problemu i dostępne działanie.',
  })
}
