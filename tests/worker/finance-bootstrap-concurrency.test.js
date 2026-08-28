import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { startFinanceImport } from '../../worker/core/finance.js'
import { createKeyring } from '../../worker/security/keyring.js'
import {
  applyCoreDirectoryStageB,
  applyFinanceStageC,
  applySpecialistProfilesStageD,
  applyWorkbookRegistryStageE,
  completeCoreDirectoryStageA,
} from './apply-migrations.js'
import { authorityActor } from './fixtures.js'

const OWNER = authorityActor({ id: 'stf_finance_bootstrap_owner', role: 'owner' })
const NOW_MS = 1_800_000_100_000
const CORRELATION_ID = '00000000-0000-4000-8000-000000000041'

let serial = 0
const ids = () => {
  const marker = ++serial
  const values = [
    `finance_bootstrap_batch_${marker}`,
    `finance_bootstrap_key_${marker}`,
    `finance_bootstrap_audit_${marker}`,
  ]
  return () => values.shift()
}

describe('finance key bootstrap concurrency', () => {
  beforeAll(async () => {
    await completeCoreDirectoryStageA(env.DB)
    await applyCoreDirectoryStageB(env.DB)
    await applyFinanceStageC(env.DB)
    await applySpecialistProfilesStageD(env.DB)
    await applyWorkbookRegistryStageE(env.DB)
    await env.DB.prepare(
      `INSERT INTO staff_users
       (id,email_lookup,email_envelope,display_name_envelope,role,status,
        access_subject,specialist_id,version,activated_at,disabled_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      OWNER.id, 'lookup_finance_bootstrap_owner', 'email_envelope',
      'display_name_envelope', 'owner', 'active', 'subject_finance_bootstrap_owner',
      null, 1, new Date(NOW_MS).toISOString(), null,
      new Date(NOW_MS).toISOString(), new Date(NOW_MS).toISOString(),
    ).run()
  })

  it('replays the winner when the first two imports race to create the data key', async () => {
    const keyring = await createKeyring(env, {
      activeDataKekVersion: 1,
      activeLookupKeyVersion: 1,
      activeBackupKekVersion: 1,
    })
    const input = (idFactory) => ({
      db: env.DB, actor: OWNER, keyring, nowMs: NOW_MS,
      correlationId: CORRELATION_ID, idFactory,
      body: {
        filename: 'first-import.xlsx', fingerprint: 'e'.repeat(64),
        formatVersion: 1, totalRows: 1,
      },
      idempotencyKey: 'finance-bootstrap-concurrent-0001',
    })
    const starts = await Promise.all([
      startFinanceImport(input(ids())),
      startFinanceImport(input(ids())),
    ])
    expect(starts[1]).toEqual(starts[0])
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM data_keys
       WHERE scope_type='centre_finance' AND scope_id='centre_1' AND purpose='ledger'`
    ).first('count')).toBe(1)
  })
})
