import assert from 'node:assert/strict'
import test from 'node:test'
import { groupOperationalActions } from '../../src/operations-view.js'

test('groups failed backups at the newest occurrence without merging independent jobs', () => {
  const actions = [
    { id: 'job1', kind: 'outbox_job_failed' },
    { id: 'backup2', kind: 'backup_failed' },
    { id: 'job2', kind: 'outbox_job_failed' },
    { id: 'backup1', kind: 'backup_failed' },
  ]
  const before = structuredClone(actions)
  assert.deepEqual(groupOperationalActions(actions), [
    [actions[0]], [actions[1], actions[3]], [actions[2]],
  ])
  assert.deepEqual(actions, before)
  assert.deepEqual(groupOperationalActions([]), [])
})
