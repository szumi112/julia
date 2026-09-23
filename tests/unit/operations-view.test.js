import assert from 'node:assert/strict'
import test from 'node:test'
import {
  backupFreshnessState,
  dashboardBackupAlert,
  currentOperationalActions,
  operationalActionCommand,
  operationsOverview,
  operationsSummary,
  relInstantLabel,
} from '../../src/operations-view.js'

const check = (id, status, detailCode, lastSuccessAt = null) => ({
  id,
  label: id,
  status,
  detailCode,
  lastSuccessAt,
})

const health = ({
  generatedAt = '2031-04-12T12:00:00.000Z',
  backup = check(
    'backup.freshness',
    'ok',
    'BACKUP_FRESH',
    '2031-04-12T01:00:00.000Z',
  ),
  outbox = check('outbox.processing', 'ok', 'OUTBOX_HEALTHY', generatedAt),
  access = check('access.reconciliation', 'ok', 'ACCESS_CURRENT', generatedAt),
  scheduler = check('scheduler.runs', 'ok', 'SCHEDULER_HEALTHY', generatedAt),
} = {}) => ({ generatedAt, checks: [outbox, backup, access, scheduler] })

test('backup at exactly 36 hours is not over the stale threshold', () => {
  const state = backupFreshnessState(health({
    generatedAt: '2031-04-12T12:00:00.000Z',
    backup: check(
      'backup.freshness',
      'critical',
      'BACKUP_FAILED',
      '2031-04-11T00:00:00.000Z',
    ),
  }))

  assert.equal(state.ageHours, 36)
  assert.equal(state.overdue, false)
  assert.equal(state.status, 'warning')
})

test('backup one millisecond past 36 hours is overdue', () => {
  const state = backupFreshnessState(health({
    generatedAt: '2031-04-12T12:00:00.001Z',
    backup: check(
      'backup.freshness',
      'critical',
      'BACKUP_FAILED',
      '2031-04-11T00:00:00.000Z',
    ),
  }))

  assert.equal(state.overdue, true)
  assert.equal(state.status, 'critical')
})

test('Dashboard does not alert at exactly 36 hours and alerts immediately after', () => {
  const exactlyAtThreshold = health({
    backup: check('backup.freshness', 'critical', 'BACKUP_STALE', '2031-04-11T00:00:00.000Z'),
  })
  const pastThreshold = health({
    generatedAt: '2031-04-12T12:00:00.001Z',
    backup: check('backup.freshness', 'critical', 'BACKUP_STALE', '2031-04-11T00:00:00.000Z'),
  })

  assert.equal(dashboardBackupAlert(exactlyAtThreshold), null)
  assert.deepEqual(dashboardBackupAlert(pastThreshold), {
    title: 'Kopia zapasowa wymaga sprawdzenia',
    description: 'Od ponad 36 godzin nie powstała nowa kopia zapasowa.',
  })
})

test('Dashboard stays quiet when a failed backup has no confirmed previous success', () => {
  const snapshot = health({
    backup: check('backup.freshness', 'critical', 'BACKUP_FAILED'),
  })

  assert.equal(dashboardBackupAlert(snapshot), null)
})

test('Dashboard alerts when the canonical snapshot confirms a stale backup without success', () => {
  const snapshot = health({
    backup: check('backup.freshness', 'critical', 'BACKUP_STALE'),
  })

  assert.deepEqual(dashboardBackupAlert(snapshot), {
    title: 'Kopia zapasowa wymaga sprawdzenia',
    description: 'Od ponad 36 godzin nie powstała nowa kopia zapasowa.',
  })
})

test('Dashboard hides a fresh failed backup attempt', () => {
  const snapshot = health({
    backup: check('backup.freshness', 'critical', 'BACKUP_FAILED', '2031-04-12T01:00:00.000Z'),
  })

  assert.equal(dashboardBackupAlert(snapshot), null)
})

test('backup age uses generatedAt instead of the browser clock', () => {
  const state = backupFreshnessState(health({
    generatedAt: '2031-04-12T12:00:00.000Z',
    backup: check(
      'backup.freshness',
      'ok',
      'BACKUP_FRESH',
      '2031-04-12T10:00:00.000Z',
    ),
  }))

  assert.equal(state.ageHours, 2)
  assert.equal(state.overdue, false)
})

test('fresh successful backup softens BACKUP_FAILED to a warning', () => {
  const snapshot = health({
    generatedAt: '2031-04-12T12:00:00.000Z',
    backup: check(
      'backup.freshness',
      'critical',
      'BACKUP_FAILED',
      '2031-04-12T01:00:00.000Z',
    ),
  })

  assert.deepEqual(operationsOverview(snapshot, []), {
    status: 'warning',
    source: 'backup.freshness',
  })
})

test('backup pending summary does not describe a failed attempt', () => {
  const summary = operationsSummary(health({
    backup: check('backup.freshness', 'warning', 'BACKUP_PENDING'),
  }), [])

  assert.equal(summary.status, 'warning')
  assert.equal(summary.title, 'Kopia zapasowa jest przygotowywana')
  assert.equal(summary.description, 'Pierwsza nocna kopia czeka na zakończenie.')
})

test('failed backup without an earlier success does not claim it is over 36 hours old', () => {
  const summary = operationsSummary(health({
    backup: check('backup.freshness', 'critical', 'BACKUP_FAILED'),
  }), [])

  assert.equal(summary.status, 'critical')
  assert.equal(summary.title, 'Kopia zapasowa wymaga działania')
  assert.equal(
    summary.description,
    'Ostatnia próba kopii się nie udała i nie ma potwierdzonej aktualnej kopii.',
  )
})

test('worst current status wins after the backup failure adjustment', () => {
  const snapshot = health({
    backup: check(
      'backup.freshness',
      'critical',
      'BACKUP_FAILED',
      '2031-04-12T01:00:00.000Z',
    ),
    access: check(
      'access.reconciliation',
      'critical',
      'ACCESS_RECONCILIATION_LAG',
      '2031-04-12T11:00:00.000Z',
    ),
  })

  assert.deepEqual(operationsOverview(snapshot, []), {
    status: 'critical',
    source: 'access.reconciliation',
  })
})

test('open warning contributes to the overview when health is otherwise healthy', () => {
  assert.deepEqual(operationsOverview(health(), [{
    id: 'act_denial',
    kind: 'authorization_denial_spike',
    severity: 'warning',
    createdAt: '2031-04-12T11:30:00.000Z',
  }]), {
    status: 'warning',
    source: 'authorization_denial_spike',
  })
})

test('only ongoing backup and scheduler reports remain visible', () => {
  const snapshot = health({
    generatedAt: '2031-04-12T12:00:00.000Z',
    backup: check(
      'backup.freshness',
      'ok',
      'BACKUP_FRESH',
      '2031-04-12T10:00:00.000Z',
    ),
    scheduler: check(
      'scheduler.runs',
      'ok',
      'SCHEDULER_HEALTHY',
      '2031-04-12T11:00:00.000Z',
    ),
  })
  const denial = {
    id: 'act_denial',
    kind: 'authorization_denial_spike',
    severity: 'warning',
    createdAt: '2031-04-12T11:30:00.000Z',
  }

  assert.deepEqual(currentOperationalActions(snapshot, [
    { id: 'act_backup_failed', kind: 'backup_failed', severity: 'critical', createdAt: '2031-04-12T09:00:00.000Z' },
    { id: 'act_backup_stale', kind: 'backup_stale', severity: 'critical', createdAt: '2031-04-12T09:00:00.000Z' },
    { id: 'act_scheduler', kind: 'scheduler_stale', severity: 'critical', createdAt: '2031-04-12T10:00:00.000Z' },
    denial,
  ]), [denial])
})

test('staff recovery problems expose no mutation without staff management', () => {
  const available = { recovery: { kind: 'access', status: 'available' } }
  const unsafe = { recovery: { kind: 'email', status: 'unsafe' } }

  assert.equal(operationalActionCommand(available, false), null)
  assert.equal(operationalActionCommand(unsafe, false), null)
  assert.equal(operationalActionCommand(available, true), 'recover')
  assert.equal(operationalActionCommand(unsafe, true), 'resolve')
  assert.equal(operationalActionCommand({ recovery: null }, false), 'resolve')
})

test('pending health stays neutral until an open action needs attention', () => {
  assert.deepEqual(operationsOverview({ generatedAt: null, checks: [] }, []), {
    status: 'pending',
    source: null,
  })
  assert.deepEqual(operationsOverview({ generatedAt: null, checks: [] }, [{
    id: 'act_job',
    kind: 'outbox_job_failed',
    severity: 'critical',
    createdAt: '2031-04-12T11:00:00.000Z',
  }]), {
    status: 'critical',
    source: 'outbox_job_failed',
  })
})

test('relInstantLabel shows a relative Warsaw day with the time', () => {
  assert.equal(relInstantLabel('2031-04-12T01:15:00.000Z'), '12 kwi, 03:15')
  assert.equal(relInstantLabel('2031-01-12T22:14:00Z'), '12 sty, 23:14')
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  assert.match(relInstantLabel(noon.toISOString()), /^dziś, \d{2}:\d{2}$/)
  assert.equal(relInstantLabel(null), null)
  assert.equal(relInstantLabel('not a date'), null)
})
