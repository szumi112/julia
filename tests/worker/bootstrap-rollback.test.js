import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { buildBootstrapCreationBatch } from '../../scripts/bootstrap-core.js'
import {
  bootstrapInput,
  bootstrapKeyring,
  executeBootstrapBatch,
} from './bootstrap-helpers.js'

it('rolls back the whole creation when a forced statement fails', async () => {
  const keyring = await bootstrapKeyring('2')
  const built = await buildBootstrapCreationBatch({
    ...bootstrapInput('2'),
    keyring,
  })
  const forced = built.batch.map((statement, index) => index === 4
    ? { sql: 'INSERT INTO missing_bootstrap_table(value) VALUES (NULL)', params: [] }
    : statement)
  await expect(executeBootstrapBatch(forced)).rejects.toThrow()
  expect(await env.DB.prepare('SELECT count(*) AS count FROM data_keys').first())
    .toEqual({ count: 0 })
  expect(await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first())
    .toEqual({ count: 0 })
  expect(await env.DB.prepare(
    "SELECT value_json,version FROM system_state WHERE key='access.desired_generation'"
  ).first()).toEqual({
    value_json: '{"generation":0}',
    version: 1,
  })
})

it('rolls back when a created encrypted field differs from the final exact proof', async () => {
  const keyring = await bootstrapKeyring('guard')
  const mutations = [
    [0, 4, 'forged_wrapped_key'],
    [1, 1, 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    [1, 2, '{"forged":"staff_email"}'],
    [2, 3, '{"forged":"invitation_email"}'],
    [3, 2, '{"forged":"staff_snapshot"}'],
    [4, 2, '{"forged":"invitation_snapshot"}'],
    [5, 4, '{"desiredGeneration":999,"invitationVersion":1,"staffVersion":1}'],
    [6, 0, '2027-01-15T08:00:00.001Z'],
    [7, 1, '{"forged":"reconcile_payload"}'],
    [8, 2, '{"forged":"expiry_payload"}'],
  ]

  for (const [statementIndex, parameterIndex, forged] of mutations) {
    const built = await buildBootstrapCreationBatch({
      ...bootstrapInput(`guard_${statementIndex}_${parameterIndex}`),
      keyring,
    })
    const changed = built.batch.map((entry, index) => index === statementIndex
      ? {
          ...entry,
          params: entry.params.map((value, parameter) => (
            parameter === parameterIndex ? forged : value
          )),
        }
      : entry)
    await expect(executeBootstrapBatch(changed)).rejects.toThrow(
      /outbox_operation_guard_failed/,
    )
    expect(await env.DB.prepare('SELECT count(*) AS count FROM data_keys').first())
      .toEqual({ count: 0 })
    expect(await env.DB.prepare('SELECT count(*) AS count FROM staff_users').first())
      .toEqual({ count: 0 })
    expect(await env.DB.prepare('SELECT count(*) AS count FROM outbox_jobs').first())
      .toEqual({ count: 0 })
  }
})
